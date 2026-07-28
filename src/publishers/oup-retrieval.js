// Oxford University Press (academic.oup.com).
//
// Measured 2026-07-26:
//   - Both the article page and the PDF return HTTP 403 from Cloudflare to a plain client
//     impersonating a real Chrome TLS fingerprint. So does /article-lookup/doi/<doi>, OUP's
//     own DOI entry point. Nothing outside a cleared browser reaches the site.
//   - OUP hosts its own free PDFs. In a 40-DOI sample of the 10.1093 prefix, 15 articles
//     had a free PDF and 11 of those were on academic.oup.com; the remaining four were
//     society titles served from other platforms, which the existing sources already reach.
//     The mix was 12 bronze / 2 gold / 1 hybrid.
//
// UNLIKE every other publisher here, the PDF url is NOT constructible. OUP's download path
// is /<journal>/article-pdf/<vol>/<issue>/<page>/<internal-id>/<file>.pdf -- it carries an
// internal asset id that appears nowhere in the DOI, and advance articles use a different
// shape again (/advance-article-pdf/doi/<doi>/<internal-id>/<file>.pdf). Both were seen in
// the sample. So pdfUrl() returns null and the resolver reads the link out of the rendered
// page, the same path Mendeley Data uses.
//
// What IS resolvable offline is the landing page: https://doi.org/<doi> 302s straight to
// the academic.oup.com article URL, and that redirect is served to a plain client (403 is
// only on OUP itself). That one hop is memoized here.

import { paperRateLimiter } from '../utils/rate-limiter.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('oup-retrieval');

// 10.1093 is OUP's registrant prefix. Society journals OUP hosts under a partner's prefix
// (some 10.1111 DOIs land on academic.oup.com) are deliberately not claimed by DOI: see the
// note in wiley-retrieval.js for why splitting that prefix is not worth a Crossref lookup.
const OUP_DOI = /^10\.1093\/(.+)$/i;

// The article path, without a leading slash. Three shapes, all seen live:
//   nar/article/49/D1/D480/6006196
//   bjs/advance-article/doi/10.1093/bjs/znad132/7163415
//   ahr/article-abstract/128/1/428/7098075
//
// /article-abstract/ is accepted but is a SIGNAL, not just a spelling. Measured live for
// 10.1093/ahr/rhad037: doi.org lands there, the page links no PDF at all, and requesting
// the /article/ form of the same path is bounced straight back to
// /article-abstract/?redirectedFrom=fulltext by OUP itself. Rewriting the path client-side
// was tried and does not work -- the redirect is the server declining, so a bronze OUP
// article whose full text is gated simply has no PDF to fetch and the source loses its
// race. Gold articles serve /article/ and yield the download link normally (verified:
// 10.1093/geroni/igaa057.3494). Do not re-add a /article-abstract/ -> /article/ rewrite.
//
// Constrained to path-safe characters and required to start with a journal slug, so a
// resolved URL cannot point the tab at an arbitrary path on the host.
const OUP_ARTICLE_PATH = /^[a-z0-9-]+\/(advance-)?article(-abstract)?\/[A-Za-z0-9._/-]+$/;

/** True for an OUP DOI. */
export function isOupDoi(doi) {
  return typeof doi === 'string' && OUP_DOI.test(doi.trim());
}

/**
 * Pull the article path out of an academic.oup.com URL, without a network call.
 *
 * Returns e.g. "nar/article/49/D1/D480/6006196", or null when the URL is not an OUP
 * article. Used both to answer from a discovery URL and to validate what the DOI resolve
 * landed on.
 */
export function oupArticlePath(url) {
  if (typeof url !== 'string') return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host !== 'academic.oup.com') return null;
  const path = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  return OUP_ARTICLE_PATH.test(path) ? path : null;
}

// doi (lowercased) -> article path, or null when the resolve failed. In-flight promises are
// stored too, so concurrent callers asking for the same DOI make one request.
const pathCache = new Map();

/** Test seam: drop everything memoized. */
export function clearOupPathCache() {
  pathCache.clear();
}

/** Synchronous peek at the memo. Returns the path, or null/undefined when not resolved. */
export function cachedOupPath(doi) {
  if (typeof doi !== 'string') return undefined;
  const hit = pathCache.get(doi.trim().toLowerCase());
  return hit instanceof Promise ? undefined : hit;
}

/**
 * Default resolver: follow doi.org and report where we landed.
 *
 * HEAD is enough -- only the final URL is wanted, never the body, and OUP would refuse the
 * body anyway. The 302 itself comes from doi.org, so this succeeds from a plain client even
 * though the destination does not.
 */
async function resolveViaDoiOrg(doi, { signal } = {}) {
  await paperRateLimiter.acquire('doi-org', { signal }).catch(() => {});
  const response = await fetch(`https://doi.org/${encodeURI(doi)}`, {
    method: 'HEAD',
    redirect: 'follow',
    signal,
  });
  return response.url;
}

/**
 * DOI -> article path, memoized, never throwing.
 *
 * `resolve` is injectable so tests and the registry's offline guards never touch the
 * network. A failed or off-host resolve caches null: retrying it on every source in the
 * race would multiply the latency of the failure without changing the outcome.
 */
export async function oupPath(doi, { resolve = resolveViaDoiOrg, signal } = {}) {
  if (typeof doi !== 'string' || !doi.trim()) return null;
  const key = doi.trim().toLowerCase();
  if (pathCache.has(key)) return pathCache.get(key);

  const pending = (async () => {
    try {
      const landed = await resolve(doi.trim(), { signal });
      // Accept either a landing URL or an already-extracted path, so a caller is not
      // forced to know which shape the resolver speaks.
      return oupArticlePath(landed)
        || (typeof landed === 'string' && OUP_ARTICLE_PATH.test(landed) ? landed : null);
    } catch (err) {
      logger.debug(`OUP path resolve failed for ${doi}: ${err.message}`);
      return null;
    }
  })();

  pathCache.set(key, pending);
  const path = await pending;
  pathCache.set(key, path);
  return path;
}

export function oupLandingUrl(id) {
  return `https://academic.oup.com/${id}`;
}
