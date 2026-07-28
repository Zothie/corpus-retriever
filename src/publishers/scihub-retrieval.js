import { REALISTIC_UA } from '../utils/user-agent.js';
import axios from 'axios';

// Sci-Hub mirror hosts, tried in order. Overridable via SCIHUB_MIRRORS (comma-separated
// hostnames). Mirrors rotate/die often, so failing cleanly to the next is essential.
const SCIHUB_MIRRORS = (process.env.SCIHUB_MIRRORS || 'sci-hub.se,sci-hub.st,sci-hub.ru,sci-hub.red,sci-hub.box')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const SCIHUB_MIRROR_TIMEOUT_MS = 8000;

// Anna's Archive mirror hosts, tried in order. Overridable via ANNAS_MIRRORS
// (comma-separated hostnames). The .org apex is frequently DNS-blocked, so the
// currently-reachable community mirrors lead. Mirrors rotate/die often; every
// caller iterates this whole list and fails cleanly to the next.
export const ANNAS_MIRRORS = (
  process.env.ANNAS_MIRRORS ||
  'annas-archive.gd,annas-archive.pk,annas-archive.gl,annas-archive.se,annas-archive.li,annas-archive.org'
)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

/**
 * Validate a URL that was PARSED OUT OF untrusted remote HTML (a mirror page's viewer
 * iframe/anchor) before it is handed to the downloader, which has NO host allowlist of
 * its own. A compromised or MITM'd mirror could otherwise point the fetch at an internal
 * or link-local address (SSRF). Require plain https to a public host, no embedded
 * credentials, no explicit port, and a plausible PDF path. DOI-constructed mirror BASE
 * urls do not need this (they are code, not remote content) -- only the parsed hrefs do.
 */
// Host-only half of the SSRF guard: require plain https to a PUBLIC DNS host, no
// embedded credentials, no explicit port, and reject every IP-literal / loopback /
// link-local / private / CGNAT encoding. Split out of isSafePublicHttpsUrl so a
// resolver whose final download URL is not a *.pdf path (LibGen's get.php?md5=&key=)
// can reuse the exact same host safety without weakening the sci-hub .pdf rule.
export function isPublicDnsHttpsHost(candidate) {
  let u;
  try {
    u = new URL(candidate);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (u.port) return false;
  // Reject a trailing dot (fqdn escape) then lowercase.
  const host = u.hostname.replace(/\.$/, '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost')) return false;
  // Reject any IP-literal host: only a DNS hostname with a non-numeric TLD is allowed.
  // This closes decimal (2130706433), octal (0177.0.0.1), hex (0x7f.0.0.1), short-form
  // (127.1), and IPv6 ([::1], [::ffff:127.0.0.1]) encodings that would otherwise slip
  // past a dotted-decimal-only private-range check and resolve to a loopback/internal
  // address at fetch time. A legitimate publisher/mirror is always a DNS name.
  if (host.startsWith('[') || host === '::1') return false;                 // IPv6 literal
  if (/^[0-9.]+$/.test(host)) return false;                                  // any all-numeric v4 form
  if (/^0x/i.test(host) || /(^|\.)0[0-7]/.test(host)) return false;          // hex / octal octet
  const tld = host.split('.').pop();
  if (!tld || /^\d+$/.test(tld)) return false;                               // require an alpha TLD
  // Belt-and-suspenders explicit private/loopback/link-local dotted-decimal check.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;                      // CGNAT 100.64/10
  }
  return true;
}

export function isSafePublicHttpsUrl(candidate) {
  if (!isPublicDnsHttpsHost(candidate)) return false;
  // A plausible PDF: the path ends in .pdf, or carries a pdf/download hint. Mirror
  // download links are frequently `/downloads/<id>/<name>.pdf` or `?download=...`.
  // Test against the RAW candidate string (not a re-serialized URL) so query-string
  // .pdf hints are honored, preserving the pre-split behavior exactly.
  let path;
  try {
    path = new URL(candidate).pathname.toLowerCase();
  } catch {
    return false;
  }
  if (!/\.pdf($|[?#])/.test(candidate.toLowerCase()) && !path.includes('.pdf')) return false;
  return true;
}

// Export the mirror list so callers (save-to-vault) can drive a headed ALTCHA solve
// against the same hosts this axios resolver tried, without re-deriving them.
export { SCIHUB_MIRRORS };

/**
 * Is this Sci-Hub response body the ALTCHA "Вы робот?" captcha page (as opposed to a
 * real article page or an "article not found" page)? Sci-Hub serves the captcha as
 * HTTP 200, so status never tells us -- the ALTCHA widget element, the /captcha/solution/
 * POST endpoint, or the Russian prose are the signal. Used to decide whether to escalate
 * to a headed window for a human to solve. Pure; never throws.
 */
export function isScihubCaptchaHtml(html) {
  if (typeof html !== 'string' || !html) return false;
  const h = html.toLowerCase();
  return (
    h.includes('<altcha-widget') ||
    h.includes('altcha-widget>') ||
    h.includes('/captcha/solution/') ||
    h.includes('altcha.min.js') ||
    h.includes('вы робот')
  );
}

/**
 * Is this Sci-Hub response body the "paper is not yet available in my database" page?
 * Sci-Hub serves it as HTTP 200 with a "similar articles" list and a link to the Sci-Net
 * request platform -- there is NO download link and never will be, so this is a definitive
 * FAIL: do not escalate to a headed window, and if the human already solved a captcha and
 * landed here, stop immediately instead of waiting for a download link that will never
 * render. Keyed on the stable prose + the sci-net.xyz request link. Pure; never throws.
 */
export function isScihubUnavailableHtml(html) {
  if (typeof html !== 'string' || !html) return false;
  const h = html.toLowerCase();
  return (
    h.includes('not yet available in my database') ||
    h.includes('sci-net.xyz') ||
    (h.includes('what can i do') && h.includes('similar')) && !h.includes('class="download"')
  );
}

/**
 * Parse the direct PDF url out of a Sci-Hub ARTICLE page's HTML (the page shown AFTER
 * any captcha is cleared). The canonical marker is the download anchor:
 *   <div class="download"><a href="//host/storage/.../<name>.pdf"></a></div>
 * (the href is protocol-relative and the anchor text is empty). Older mirror layouts
 * instead embed the PDF in a viewer <iframe>/<embed> or a download <button onclick>.
 *
 * Collects every candidate href, normalizes protocol-relative (`//host`) and
 * mirror-relative (`/path`) forms to absolute https, forces https, and returns the FIRST
 * that passes the isSafePublicHttpsUrl SSRF guard (the downloader has no host allowlist,
 * and this HTML is untrusted remote content). Returns null if none is safe. Pure; never
 * throws. `mirror` is the host the HTML came from, used to resolve mirror-relative hrefs.
 */
export function parseScihubDownloadLink(html, mirror) {
  if (typeof html !== 'string' || !html) return null;
  const candidates = [];
  // The canonical post-solve download anchor: <div class="download"><a href="..."> .
  // Match the href of an <a> that sits inside a class="download" container. Keyed on the
  // href attribute (the anchor text is empty in the real page).
  const dl = html.match(/class\s*=\s*["']download["'][^>]*>\s*<a[^>]+href\s*=\s*["']([^"']+)["']/i);
  if (dl) candidates.push(dl[1]);
  // Generic <a href="...pdf"> download button anywhere on the page.
  const anchor = html.match(/<a[^>]+href\s*=\s*["']([^"']+\.pdf[^"']*)["']/i);
  if (anchor) candidates.push(anchor[1]);
  // Viewer iframe/embed (older layout) and onclick download button.
  const iframe = html.match(/<iframe[^>]+src\s*=\s*["']([^"']+)["']/i);
  if (iframe) candidates.push(iframe[1]);
  const embed = html.match(/<embed[^>]+src\s*=\s*["']([^"']+)["']/i);
  if (embed) candidates.push(embed[1]);
  const onclick = html.match(/location\.href\s*=\s*['"]([^'"]+\.pdf[^'"]*)['"]/i);
  if (onclick) candidates.push(onclick[1]);

  for (const raw of candidates) {
    let href = (raw || '').trim();
    if (!href) continue;
    // Normalize protocol-relative and mirror-relative hrefs to absolute https.
    if (href.startsWith('//')) href = 'https:' + href;
    else if (href.startsWith('/')) href = `https://${mirror}${href}`;
    else if (!/^https?:/i.test(href)) href = `https://${mirror}/${href.replace(/^\.?\//, '')}`;
    // Force https even if the mirror served an http viewer link.
    href = href.replace(/^http:\/\//i, 'https://');
    if (isSafePublicHttpsUrl(href)) return href;
  }
  return null;
}

/**
 * Parse the direct PDF urls out of an Anna's Archive scidb page's HTML. The page carries
 * the same PDF in two equivalent places plus a captcha-free IPFS mirror:
 *   1. a "Download" anchor: <a href="https://<host>/.../<doi>.pdf~/.../...Archive.pdf">Download</a>
 *      -- the href points at an EXTERNAL download host (a short random domain), the path
 *      contains ".pdf~/" and the whole url ends ".pdf".
 *   2. a pdfjs viewer iframe: <iframe src="/pdfjs/web/viewer.html?file=<ENC>"> -- the `file=`
 *      query param is the SAME pdf url, with the scheme/host single-encoded and the filename
 *      DOUBLE-encoded; a single decodeURIComponent yields a working url (residual %20 in the
 *      filename is a valid url).
 *   3. an "IPFS Gateway" anchor: <a href="https://ipfs.filebase.io/ipfs/<cid>?filename=...pdf">
 *      -- a clean public host used as a captcha-free fallback when the primary host is dead.
 *
 * Returns { primary, ipfs } of absolute https urls that each pass the isSafePublicHttpsUrl
 * SSRF guard (this HTML is untrusted remote content and the downloader has no host
 * allowlist), or null for a form that is absent/unsafe. The primary prefers the Download
 * anchor and falls back to the decoded iframe param (they are the same url). Pure; never
 * throws. Absence of BOTH primary forms means the paper is not downloadable from this page.
 */
export function parseAnnasScidbLinks(html) {
  const result = { primary: null, ipfs: null };
  if (typeof html !== 'string' || !html) return result;

  // Collect primary candidates in preference order. Key the Download anchor on its inner
  // text ("Download") and a .pdf href -- NOT on a "download" substring in the href (the
  // real external host has no such substring). Then the iframe file= param (decoded once).
  const primaries = [];
  const dl = html.match(/<a\b[^>]*\bhref="(https:\/\/[^"]+?\.pdf[^"]*)"[^>]*>\s*Download\s*<\/a>/i);
  if (dl) primaries.push(dl[1]);
  const iframe = html.match(/<iframe\b[^>]*\bsrc="[^"]*[?&]file=([^"&]+)"/i);
  if (iframe) {
    let decoded;
    try { decoded = decodeURIComponent(iframe[1]); } catch { decoded = null; }
    if (decoded) primaries.push(decoded);
  }
  for (const cand of primaries) {
    if (isSafePublicHttpsUrl(cand)) { result.primary = cand; break; }
  }

  // IPFS fallback: prefer the ipfs.filebase.io gateway anchor. The IPFS url is a CID, so it
  // does not carry the DOI; it is only reached after the DOI-addressed page confirmed this
  // is the right paper, and the downloader still validates the bytes are %PDF-.
  const ipfs = html.match(/\bhref="(https:\/\/ipfs\.filebase\.io\/ipfs\/[^"]+)"/i);
  if (ipfs && isSafePublicHttpsUrl(ipfs[1])) result.ipfs = ipfs[1];

  return result;
}

/**
 * Resolve a DOI to a direct PDF url via Sci-Hub mirrors, WITHOUT a captcha. Fetches the
 * mirror's article page (`https://<mirror>/<doi>`) with axios (bounded timeout), then
 * parses the embedded viewer iframe/embed src or a direct download anchor out of the HTML
 * with parseScihubDownloadLink (SSRF-guarded). Returns { pdfUrl, captchaMirror }:
 *   - pdfUrl: the first safe pdf url found (no captcha in the way), or null.
 *   - captchaMirror: the FIRST mirror whose article page was an ALTCHA captcha (a human
 *     could solve it in a headed window), or null. The caller uses this to open exactly
 *     ONE headed window on that mirror when every mirror was walled. Never throws.
 */
export async function resolveScihubPdf({ doi }) {
  if (!doi) return { pdfUrl: null, captchaMirror: null };
  const cleanDoi = doi.replace(/v\d+$/, '').trim();
  let captchaMirror = null;
  for (const mirror of SCIHUB_MIRRORS) {
    const pageUrl = `https://${mirror}/${encodeURIComponent(cleanDoi)}`;
    let html;
    try {
      const { data } = await axios.get(pageUrl, {
        timeout: SCIHUB_MIRROR_TIMEOUT_MS,
        responseType: 'text',
        // Do NOT follow redirects on the mirror page fetch: a redirect could point at
        // an internal/link-local address (SSRF), and a legitimate Sci-Hub article page
        // returns 200 HTML directly. A 3xx just means "try the next mirror".
        maxRedirects: 0,
        headers: { 'User-Agent': REALISTIC_UA, 'Accept-Language': 'en-US,en;q=0.9' },
        validateStatus: (s) => s >= 200 && s < 300,
      });
      html = String(data || '');
    } catch {
      continue; // dead / blocked mirror; try the next
    }
    // This mirror flatly does not have the paper ("not yet available in my database").
    // Never a download here and never will be -- do NOT record it as a captcha mirror
    // (which would open a pointless headed window); just try the next mirror.
    if (isScihubUnavailableHtml(html)) {
      continue;
    }
    // If this mirror is showing the ALTCHA captcha, remember it (first one wins) so the
    // caller can open ONE headed window here, then keep trying other mirrors for a
    // captcha-free direct link.
    if (isScihubCaptchaHtml(html)) {
      if (!captchaMirror) captchaMirror = pageUrl;
      continue;
    }
    const href = parseScihubDownloadLink(html, mirror);
    if (href) return { pdfUrl: href, captchaMirror: null };
  }
  return { pdfUrl: null, captchaMirror };
}

const ANNAS_SCIDB_TIMEOUT_MS = 10000;

export async function retrievePaper({ doi, arxivId, pdfUrl, annas_archive_url = null }) {
  // If direct PDF URL is provided, just return it
  if (pdfUrl) {
    return {
      content: [{ type: 'text', text: `PDF URL: ${pdfUrl}\n\nDirect PDF link provided.` }],
      pdf_url: pdfUrl,
    };
  }

  // If arXiv ID is provided, construct arXiv PDF URL
  if (arxivId) {
    const cleanArxivId = arxivId.replace('arXiv:', '').trim();
    const arxivPdfUrl = `https://arxiv.org/pdf/${cleanArxivId}.pdf`;
    return {
      content: [{ type: 'text', text: `arXiv Paper Retrieved:\nPDF URL: ${arxivPdfUrl}\n\narXiv ID: ${cleanArxivId}` }],
      pdf_url: arxivPdfUrl,
    };
  }

  // Otherwise, use Anna's Archive with the DOI.
  if (!doi) {
    throw new Error('Either doi, arxivId, or pdfUrl must be provided');
  }

  // Strip version suffix from DOI (e.g., 10.1101/190215v4 -> 10.1101/190215)
  const cleanDoi = doi.replace(/v\d+$/, '');

  // Try ALL Anna's Archive mirrors for resilience. A caller-supplied mirror (if any) is
  // tried first, then the full configured list. Deduplicate, preserving order.
  const mirrors = [annas_archive_url, ...ANNAS_MIRRORS.map(h => `https://${h}`)].filter(Boolean);
  const uniqueMirrors = [...new Set(mirrors)];

  // The scidb page is fully server-rendered: the Download anchor, the pdfjs viewer iframe,
  // and the IPFS gateway link are all in the static HTML (no JS needed), so a plain axios
  // fetch is enough -- no browser, hence no leaked Chromium. Iterate mirrors and fall
  // cleanly through to the next on timeout, a non-2xx, or a page with no parseable link.
  const firstScidbUrl = `${uniqueMirrors[0]}/scidb/${encodeURIComponent(cleanDoi)}`;
  for (const mirror of uniqueMirrors) {
    const scidbUrl = `${mirror}/scidb/${encodeURIComponent(cleanDoi)}`;
    let html;
    try {
      const { data } = await axios.get(scidbUrl, {
        timeout: ANNAS_SCIDB_TIMEOUT_MS,
        responseType: 'text',
        headers: { 'User-Agent': REALISTIC_UA, 'Accept-Language': 'en-US,en;q=0.9' },
        validateStatus: (s) => s >= 200 && s < 300,
      });
      html = String(data || '');
    } catch {
      continue; // dead / blocked mirror; try the next
    }

    const { primary, ipfs } = parseAnnasScidbLinks(html);
    // No parseable download link on this mirror -- the page shape may differ or the paper
    // is not on this mirror. Fall through to the next mirror before concluding it is
    // unavailable.
    if (!primary && !ipfs) continue;

    let resultText = `Paper Retrieved from Anna's Archive (${mirror}):\n`;
    resultText += `Status: AVAILABLE\n`;
    if (primary) resultText += `Download URL: ${primary}\n`;
    if (ipfs) resultText += `IPFS fallback URL: ${ipfs}\n`;
    resultText += `\nAnna's Archive SciDB URL: ${scidbUrl}\nMirror used: ${mirror}\n`;

    return {
      content: [{ type: 'text', text: resultText }],
      // Prefer the primary external-host download url; the IPFS gateway url is a
      // captcha-free fallback the caller can try if the primary host is dead. Both
      // already passed the isSafePublicHttpsUrl SSRF guard inside parseAnnasScidbLinks.
      pdf_url: primary || ipfs || null,
      ipfs_url: ipfs || null,
      annas_archive_url: scidbUrl,
      available: true,
    };
  }

  // No mirror yielded a downloadable link.
  return {
    content: [{
      type: 'text',
      text: `Paper NOT found in Anna's Archive:\nDOI: ${cleanDoi}\nStatus: No downloadable link on any mirror\n\nAnna's Archive SciDB URL: ${firstScidbUrl}\nMirrors checked: ${uniqueMirrors.join(', ')}\n`,
    }],
    pdf_url: null,
    ipfs_url: null,
    annas_archive_url: firstScidbUrl,
    available: false,
  };
}

export async function extractDOI({ text }) {
  // Extract DOI from text using regex
  const doiPattern = /10\.\d{4,}\/[^\s<>"]+/g;
  const matches = text.match(doiPattern);

  if (!matches || matches.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: 'No DOIs found in the provided text.',
        },
      ],
    };
  }

  const uniqueDois = [...new Set(matches)];
  const resultText = `Found ${uniqueDois.length} DOI(s):\n\n${uniqueDois.map((doi, i) => `${i + 1}. ${doi}`).join('\n')}`;

  return {
    content: [
      {
        type: 'text',
        text: resultText,
      },
    ],
  };
}
