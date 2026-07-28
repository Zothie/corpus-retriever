import axios from 'axios';
import { REALISTIC_UA } from '../utils/user-agent.js';
import { isPublicDnsHttpsHost } from './scihub-retrieval.js';

// LibGen (scimag) mirror hosts, tried in order. Overridable via LIBGEN_MIRRORS
// (comma-separated hostnames). Mirrors rotate/die often, so failing cleanly to the
// next is essential. The first host also backs the manual-fallback search link.
export const LIBGEN_MIRRORS = (
  process.env.LIBGEN_MIRRORS || 'libgen.bz,libgen.li,libgen.la,libgen.vg,libgen.gl'
)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Per-fetch timeout for each of the (up to three) sequential navigation GETs. Kept
// tight because a single DOI walks search -> edition -> ads; a slow mirror must not
// stall the whole download loop (which reaches LibGen only after Sci-Hub).
const LIBGEN_FETCH_TIMEOUT_MS = 6000;
// Wall-clock budget per mirror: abort the remaining fetches once exceeded so one
// slow-but-not-dead mirror cannot burn ~24s of sequential 6s fetches.
const LIBGEN_MIRROR_BUDGET_MS = 15000;
// Only try the first few mirrors: the flow is 3+ sequential fetches per mirror, and
// the configured hosts are equivalent, so an unbounded walk is pure latency.
const LIBGEN_MAX_MIRRORS = 3;

const AXIOS_NAV_OPTS = {
  timeout: LIBGEN_FETCH_TIMEOUT_MS,
  responseType: 'text',
  // Do NOT follow redirects on the navigation fetches: a redirect could point at an
  // internal/link-local address (SSRF), and a legitimate LibGen page returns 200 HTML
  // directly. A 3xx just means "treat this mirror as a miss".
  maxRedirects: 0,
  headers: { 'User-Agent': REALISTIC_UA, 'Accept-Language': 'en-US,en;q=0.9' },
  validateStatus: (s) => s >= 200 && s < 300,
};

/**
 * Normalize a DOI for exact comparison: trim and lowercase. NO version-suffix stripping:
 * DOIs do not carry an arXiv-style "vN" suffix, and stripping one would corrupt a real DOI
 * that legitimately ends in "v2"/"v3" (causing a false miss or collapsing two distinct DOIs).
 */
function normalizeDoi(doi) {
  return String(doi || '').trim().toLowerCase();
}

/**
 * Build the LibGen scimag DOI search URL for a mirror. Code-constructed (not parsed),
 * so it needs no SSRF guard; also used as the human manual-fallback link.
 */
export function buildLibgenSearchUrl(mirror, doi) {
  const params = new URLSearchParams();
  params.set('req', doi);
  for (const c of ['t', 'a', 's', 'y', 'p', 'i']) params.append('columns[]', c);
  for (const o of ['f', 'e', 's', 'a', 'p', 'w']) params.append('objects[]', o);
  for (const t of ['l', 'c', 'f', 'a', 'm', 'r', 's']) params.append('topics[]', t);
  params.set('res', '25');
  params.set('filesuns', 'all');
  return `https://${mirror}/index.php?${params.toString()}`;
}

/**
 * Parse the search result table (id="tablelibgen") into one entry per result row:
 * { doi, detailId } where detailId is the edition.php (or file.php) id for that row.
 *
 * The DOI is taken ONLY from the green-font "DOI: <x>" span inside the row -- NOT a
 * global scan -- because the requested DOI also appears in the search form's value=
 * attribute and other cells; a global grep would false-positive. Pure; never throws.
 */
export function parseLibgenSearchRows(html) {
  if (typeof html !== 'string' || !html) return [];
  // Isolate the results table so form/header markup cannot leak into row parsing.
  const tableMatch = html.match(/id\s*=\s*["']tablelibgen["'][\s\S]*?<\/table>/i);
  const table = tableMatch ? tableMatch[0] : html;
  const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const out = [];
  for (const row of rows) {
    // Green-font DOI span is the only trusted DOI source for the row.
    const doiMatch = row.match(/color\s*=\s*["']?green["']?[^>]*>\s*DOI:\s*([^<]+)</i);
    if (!doiMatch) continue;
    const doi = doiMatch[1].trim();
    // The detail page for the row: edition.php?id= (typical) or file.php?id= (some mirrors).
    const idMatch = row.match(/(?:edition|file)\.php\?id=(\d+)/i);
    if (!idMatch) continue;
    out.push({ doi, detailId: idMatch[1] });
  }
  return out;
}

/**
 * From parsed search rows, return the detail id of the FIRST row whose DOI EXACTLY
 * matches the requested DOI (normalized: version-stripped, trimmed, case-insensitive).
 * Returns null when no row matches -- we NEVER guess by title, which would download a
 * different paper. Pure; never throws.
 */
export function selectDoiExactMatch(rows, wantedDoi) {
  const want = normalizeDoi(wantedDoi);
  if (!want) return null;
  for (const r of rows) {
    if (normalizeDoi(r.doi) === want) return r.detailId;
  }
  return null;
}

/**
 * Parse an edition.php page for the file md5 and (optionally) the ads.php download-page
 * link. The md5 is taken from the ads.php?md5= link specifically -- a bare 32-hex scan
 * would also grab Cloudflare data-cfemail email-protection tokens (also 32 hex) that are
 * NOT file md5s. Returns { md5, adsPath } (adsPath relative, may be null). Pure.
 */
export function parseEditionForMd5(html) {
  if (typeof html !== 'string' || !html) return { md5: null, adsPath: null };
  const ads = html.match(/ads\.php\?md5=([a-f0-9]{32})(?:&amp;|&)?[^"'<> ]*/i);
  if (ads) {
    return { md5: ads[1].toLowerCase(), adsPath: ads[0].replace(/&amp;/g, '&') };
  }
  // Fallback: an explicit md5=<32hex> hidden field / attribute on the edition page.
  const bare = html.match(/[?&"']md5=([a-f0-9]{32})\b/i);
  return { md5: bare ? bare[1].toLowerCase() : null, adsPath: null };
}

/**
 * Parse an ads.php page for the final get.php download link and normalize it to an
 * absolute https URL on the CODE-KNOWN mirror host (the relative href is resolved
 * against the mirror, never a page-supplied <base>). Cross-checks the get.php md5
 * equals the expected file md5 so a decoy/other-paper link is rejected. Returns the
 * absolute url or null. Pure; never throws. `expectMd5` guards paper identity.
 */
export function parseAdsForGetLink(html, mirror, expectMd5) {
  if (typeof html !== 'string' || !html) return null;
  const m = html.match(/get\.php\?md5=([a-f0-9]{32})&(?:amp;)?key=([A-Za-z0-9]+)/i);
  if (!m) return null;
  const md5 = m[1].toLowerCase();
  const key = m[2];
  if (expectMd5 && md5 !== String(expectMd5).toLowerCase()) return null;
  return `https://${mirror}/get.php?md5=${md5}&key=${key}`;
}

/**
 * Resolve the mirror's get.php to a TERMINAL (200-serving) download URL, validating EVERY
 * redirect hop's host -- WITHOUT letting the shared downloader chase any redirect blindly.
 * get.php replies 307 with a Location pointing at a separate CDN host (e.g. cdn4.booksdl.lc)
 * taken from the mirror's response header (untrusted). If we returned the get.php URL to the
 * downloader (which follows up to 5 redirects with NO host allowlist), a malicious/MITM'd
 * mirror could redirect the fetch at an internal/link-local address -- the request would be
 * ISSUED before any body validation, i.e. blind SSRF. So we walk the chain here with
 * maxRedirects:0, validating each Location host with isPublicDnsHttpsHost, and return the
 * ABSOLUTE url that finally serves 200. Because that url is terminal, the shared downloader
 * makes no further redirect (closing the un-allowlisted-redirect hole). Bounded to a few
 * hops. Never throws.
 */
async function resolveFinalDownloadUrl(getUrl, signal) {
  const MAX_HOPS = 4;
  let current = getUrl; // getUrl is code-constructed on a known mirror host -> safe to fetch.
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let resp;
    try {
      resp = await axios.get(current, {
        timeout: LIBGEN_FETCH_TIMEOUT_MS,
        responseType: 'stream',
        maxRedirects: 0,
        headers: { 'User-Agent': REALISTIC_UA, 'Accept-Language': 'en-US,en;q=0.9' },
        // Accept a 2xx (terminal file) or a 3xx (a redirect we validate ourselves).
        validateStatus: (s) => (s >= 200 && s < 300) || (s >= 300 && s < 400),
        signal,
      });
    } catch {
      return null;
    }
    // Drain/destroy the stream body: we only need headers here (the real byte download
    // happens later via the shared downloader on the returned terminal URL).
    try { resp.data?.destroy?.(); } catch { /* ignore */ }

    if (resp.status >= 200 && resp.status < 300) {
      // Terminal 200. current is either the code-known mirror (getUrl) or an already
      // host-validated CDN url from a prior hop -- safe to hand to the downloader.
      return current;
    }
    // Redirect: validate the next hop's host BEFORE it is ever fetched.
    const location = resp.headers?.location;
    if (!location) return null;
    let next;
    try {
      next = new URL(location, current).toString();
    } catch {
      return null;
    }
    next = next.replace(/^http:\/\//i, 'https://');
    if (!isPublicDnsHttpsHost(next)) return null;
    current = next;
  }
  return null; // too many hops; treat as a dead download
}

/**
 * Resolve a DOI to a direct, SSRF-validated PDF download URL via LibGen scimag mirrors,
 * with NO captcha and NO browser. For each mirror (bounded by a per-fetch timeout and a
 * per-mirror wall-clock budget), walks: DOI search -> exact-DOI-match row -> edition page
 * (file md5 + ads link) -> ads page (get.php?md5=&key=) -> get.php redirect resolved to a
 * host-validated absolute CDN url. Returns that url or null. Tries mirrors in order and
 * fails cleanly to the next. NEVER throws.
 */
export async function resolveLibgenPdf({ doi }) {
  if (!doi) return null;
  const cleanDoi = String(doi).trim();
  if (!cleanDoi) return null;

  for (const mirror of LIBGEN_MIRRORS.slice(0, LIBGEN_MAX_MIRRORS)) {
    const started = Date.now();
    const controller = new AbortController();
    // A hard per-mirror wall-clock timer: once the budget elapses it ABORTS any in-flight
    // axios request (signal) so a slow-but-not-dead mirror cannot burn several full 6s
    // fetch timeouts back to back. overBudget() also short-circuits between fetches.
    const budgetTimer = setTimeout(() => controller.abort(), LIBGEN_MIRROR_BUDGET_MS);
    const overBudget = () => Date.now() - started > LIBGEN_MIRROR_BUDGET_MS;
    try {
      // 1. Search by DOI.
      const searchUrl = buildLibgenSearchUrl(mirror, cleanDoi);
      const search = await axios.get(searchUrl, { ...AXIOS_NAV_OPTS, signal: controller.signal });
      const rows = parseLibgenSearchRows(String(search.data || ''));
      const detailId = selectDoiExactMatch(rows, cleanDoi);
      if (!detailId || overBudget()) continue;

      // 2. Edition page -> file md5 (+ optional ads link).
      const editionUrl = `https://${mirror}/edition.php?id=${detailId}`;
      const edition = await axios.get(editionUrl, { ...AXIOS_NAV_OPTS, signal: controller.signal });
      const { md5, adsPath } = parseEditionForMd5(String(edition.data || ''));
      if (!md5 || overBudget()) continue;

      // 3. Ads page -> final get.php link. If the edition page carried no ads.php link,
      //    build the ads URL from the md5 (the ads page is the canonical get-link source).
      const adsUrl = adsPath
        ? `https://${mirror}/${adsPath.replace(/^\//, '')}`
        : `https://${mirror}/ads.php?md5=${md5}`;
      const ads = await axios.get(adsUrl, { ...AXIOS_NAV_OPTS, signal: controller.signal });
      const getUrl = parseAdsForGetLink(String(ads.data || ''), mirror, md5);
      if (!getUrl || overBudget()) continue;

      // 4. Resolve get.php's redirect chain to a host-validated terminal download URL.
      const finalUrl = await resolveFinalDownloadUrl(getUrl, controller.signal);
      if (finalUrl) return finalUrl;
    } catch {
      // Dead / blocked / malformed / aborted mirror; try the next.
      continue;
    } finally {
      clearTimeout(budgetTimer);
    }
  }
  return null;
}
