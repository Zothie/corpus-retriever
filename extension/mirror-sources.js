// Mirrors: Sci-Hub, LibGen and Anna's Archive.
//
// All three are wired. A mirror is skipped only when it is unreachable AT THE TIME, decided
// by probing rather than by a hardcoded belief about which domains work -- because the
// domains rotate constantly and a stale list is indistinguishable from an outage.
//
// VERIFICATION STATUS, stated honestly. The resolve chain is confirmed live: libgen walks
// index -> edition -> ads -> get.php and returns a keyed url, measured repeatedly. What has
// NOT been observed end to end is a mirror download completing THROUGH THE EXTENSION,
// because libgen rate-limits after a handful of probes and testing this needs many. The
// failures seen were all external (429/timeout/"not on libgen" for papers libgen genuinely
// lacks), not code -- but "not yet observed" is not "working", and the difference matters
// for anyone relying on this path.
//
// That distinction cost a wrong conclusion once already. Probing annas-archive.org/.se and
// libgen.is/.rs/.st on 2026-07-28 gave DNS failures and TCP timeouts, and I reported both
// networks as blocked. They were simply DEAD DOMAINS. The live sets, which this repo
// already configured, all answer:
//
//   libgen.bz .li .la .vg .gl            200
//   annas-archive.gd .pk .gl .li         200
//   annas-archive.org .se                DNS gaierror  (the stale ones I had tested)
//
// So availability is measured per run, and nothing here assumes a mirror is up or down.

import { credentialsFor, urlTier, TIER } from './allowlist.js';

// Sci-Hub publishes its rotating set as a CSV. Every host it names is intersected with the
// allowlist below, so a spoofed list can only REMOVE mirrors, never add one.
const SCIHUB_LIST_URL = 'https://cdn.lowyiyiu.com/scihub/';
const SCIHUB_FALLBACK = ['sci-hub.ru', 'sci-hub.st', 'sci-hub.su', 'sci-hub.red', 'sci-hub.box'];

// Kept in the same order as src/tools/libgen-retrieval.js and scihub-retrieval.js, which is
// roughly fastest-first as measured there.
const LIBGEN_MIRRORS = ['libgen.bz', 'libgen.li', 'libgen.la', 'libgen.vg', 'libgen.gl'];
const ANNAS_MIRRORS = ['annas-archive.gd', 'annas-archive.pk', 'annas-archive.gl', 'annas-archive.li'];

// A mirror gets this long to answer before the next is tried. Short on purpose: mirrors are
// raced against every other source, and one slow-but-not-dead host must not hold the race.
// 8s was too short for libgen, whose search hop measured 10.5s -- it aborted and the source
// reported "not on libgen" for a paper libgen has, which is a wrong answer rather than a
// slow one. But raising it multiplies: these are probed SEQUENTIALLY across 14 hosts, so
// the phase's worst case is minutes. The budget below is what actually bounds it.
const PROBE_TIMEOUT_MS_MIRROR = 12000;
/**
 * Whole-phase ceiling for one mirror source.
 *
 * Measured: probing every host at the old timeouts put the mirror phase past 170s, which a
 * user experiences as a hung download rather than as a slow one. Each source gets this long
 * to produce something, after which the ladder moves on -- a paper that needs three minutes
 * of mirror-walking is one the user would rather be told about.
 */
const SOURCE_BUDGET_MS_MIRROR = 45000;
const FETCH_TIMEOUT_MS_MIRROR = 20000;

/** Fetch text with a timeout, through the tier resolver. Never throws. */
async function getTextMirror(url, timeoutMs = FETCH_TIMEOUT_MS_MIRROR) {
  const credentials = credentialsFor(url);
  if (credentials === null) return null;
  try {
    const res = await fetch(url, { credentials, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) { lastMirrorError = `http ${res.status}`; return null; }
    return await res.text();
  } catch (err) {
    lastMirrorError = `${err.name}: ${err.message}`;
    return null;
  }
}

/**
 * The first mirror in `hosts` that answers, or null when none do.
 *
 * Sequential rather than parallel: the point is to use ONE mirror, and hitting five at once
 * to discard four is rude to hosts that are donating bandwidth.
 */
let lastMirrorError = null;

async function firstReachable(hosts, pathFor) {
  let lastError = null;
  const deadline = Date.now() + SOURCE_BUDGET_MS_MIRROR;
  for (const host of hosts) {
    // Stop walking once the budget is gone: 14 hosts at 12s each is minutes, and the
    // remaining ones are no more likely to answer than the ones that just did not.
    if (Date.now() > deadline) {
      lastMirrorError = `${lastError || 'no mirror answered'} (budget exhausted)`;
      return null;
    }
    if (urlTier(`https://${host}/`) !== TIER.ANONYMOUS) continue;
    const body = await getTextMirror(`https://${host}${pathFor(host)}`, PROBE_TIMEOUT_MS_MIRROR);
    if (body !== null) return { host, body };
  }
  if (lastError) lastMirrorError = lastError;
  return null;
}

/** Absolute https url from an href that may be relative, protocol-relative or absolute. */
function absolutize(href, pageUrl) {
  if (typeof href !== 'string' || !href) return null;
  let abs = href;
  if (abs.startsWith('//')) abs = `https:${abs}`;
  try {
    abs = new URL(abs, pageUrl).toString();
  } catch {
    return null;
  }
  return /^https:\/\//i.test(abs) ? abs : null;
}

/** Every href in a page. Regex rather than DOM: a service worker has no DOMParser. */
function hrefsIn(html) {
  return (html.match(/href\s*=\s*["']([^"']{4,300})["']/g) || [])
    .map((m) => m.replace(/^href\s*=\s*["']/, '').replace(/["']$/, ''));
}

// --- Sci-Hub --------------------------------------------------------------------------

export async function scihubMirrors() {
  let hosts = SCIHUB_FALLBACK;
  const body = await getTextMirror(`${SCIHUB_LIST_URL}?v=${Date.now()}`, PROBE_TIMEOUT_MS_MIRROR);
  if (body) {
    const parsed = body.split(/[\r\n]+/)
      .map((line) => line.replace(/^\uFEFF/, '').trim().replace(/\/+$/, ''))
      .filter((h) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h));
    if (parsed.length > 0) hosts = parsed;
  }
  // The intersection is the security boundary, not the list.
  return hosts.filter((h) => urlTier(`https://${h}/`) === TIER.ANONYMOUS);
}

export function scihubArticleUrl(host, doi) {
  return `https://${host}/${doi}`;
}

/**
 * Pick the PDF out of a Sci-Hub page's links. The href comes from an untrusted page, so the
 * caller MUST still put it through the tier resolver -- this chooses, it does not grant.
 */
export function pickScihubPdf(hrefs, pageUrl) {
  if (!Array.isArray(hrefs)) return null;
  for (const raw of hrefs) {
    const abs = absolutize(raw, pageUrl);
    if (!abs) continue;
    let path;
    try { path = new URL(abs).pathname; } catch { continue; }
    if (/\.pdf$/i.test(path) || /\/downloads?\//i.test(path)) return abs;
  }
  return null;
}

// --- LibGen ---------------------------------------------------------------------------

/**
 * LibGen, walked to a direct file url.
 *
 * Four hops, all confirmed live 2026-07-28 for 10.1016/j.jfineco.2019.05.005:
 *
 *   index.php?req=<doi>   -> edition.php?id=82046471
 *   edition.php?id=...    -> /ads.php?md5=<md5>&downloadname=...
 *   ads.php?md5=...       -> get.php?md5=<md5>&key=<key>
 *   get.php?...           -> the bytes
 *
 * The KEY on the last hop is per-session and is why the chain cannot be shortcut: a
 * constructed get.php url without it returns a 47-byte redirect stub, which is what a
 * naive "just build the url" implementation would have downloaded and stored.
 */
export async function libgenPdfUrl(doi) {
  if (!doi) return null;
  // A mirror that is merely rate-limiting right now returns nothing and the next is tried.
  // Observed live: the same DOI resolved, then returned null after repeated probing, then
  // resolved again three times in a row. That is the "skip only if unavailable AT THE TIME"
  // case, and it is why availability is never cached across runs.
  const search = await firstReachable(
    LIBGEN_MIRRORS,
    () => `/index.php?req=${encodeURIComponent(doi)}`,
  );
  if (!search) return null;
  const base = `https://${search.host}`;

  const edition = /edition\.php\?id=(\d+)/.exec(search.body);
  if (!edition) return null;

  const editionBody = await getTextMirror(`${base}/edition.php?id=${edition[1]}`);
  if (!editionBody) return null;

  const ads = hrefsIn(editionBody).find((h) => /ads\.php\?md5=/i.test(h));
  if (!ads) return null;

  const adsBody = await getTextMirror(absolutize(ads, base) || `${base}/${ads.replace(/^\/+/, '')}`);
  if (!adsBody) return null;

  // get.php CARRYING A KEY. setlang.php also matches a looser "download" pattern and is not
  // the file -- picking it returns the stub described above.
  const get = hrefsIn(adsBody).find((h) => /get\.php\?/i.test(h) && /key=/i.test(h));
  return get ? absolutize(get, base) : null;
}

// --- Anna's Archive --------------------------------------------------------------------

/**
 * Anna's Archive scidb page for a DOI.
 *
 * Returns the PAGE url rather than a file url: measured 2026-07-28, the scidb page carries
 * no download href in its server-rendered HTML (the viewer is built client-side), so there
 * is nothing to parse from a plain fetch. The extension resolves it the same way it handles
 * Mendeley and OUP -- open the page in a tab, let it hydrate, read the links out of the live
 * DOM -- which is a capability the bridge already has and a plain HTTP client does not.
 */
export async function annasArticleUrl(doi) {
  if (!doi) return null;
  // The DOI's slash stays LITERAL. encodeURIComponent would send 10.1016%2Fj..., which
  // Anna's happens to accept (measured: both forms return the same 108,784-byte page) but
  // which is not the form the site links to itself, and a mirror that is stricter about it
  // would fail for a reason nothing here would explain. Only the characters that genuinely
  // need escaping are escaped.
  const path = `/scidb/${doi.split('/').map(encodeURIComponent).join('/')}`;
  const hit = await firstReachable(ANNAS_MIRRORS, () => path);
  return hit ? `https://${hit.host}${path}` : null;
}

/** Pick the file link out of a hydrated Anna's scidb page. */
export function pickAnnasPdf(hrefs, pageUrl) {
  if (!Array.isArray(hrefs)) return null;
  for (const raw of hrefs) {
    const abs = absolutize(raw, pageUrl);
    if (!abs) continue;
    let path;
    try { path = new URL(abs).pathname; } catch { continue; }
    // Anna's serves files from /scidb/dl/, and IPFS gateways from /ipfs/.
    if (/\.pdf$/i.test(path) || /\/scidb\/dl\//i.test(path) || /\/ipfs\//i.test(path)) return abs;
  }
  return null;
}
