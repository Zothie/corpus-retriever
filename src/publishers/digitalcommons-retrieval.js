// DigitalCommons (bepress) institutional repositories.
//
// Unlike every other publisher in the registry there is NO DOI pattern here. bepress
// instances are per-university repositories on the university's own domain
// (digitalcommons.unl.edu, docs.lib.purdue.edu, scholarworks.uni.edu, ...), and the same
// software serves all of them from identical paths. So this source activates from a URL,
// not a DOI: it is driven by web_fulltext_* discovery results whose host is a known
// instance.
//
// Why the bridge is needed (measured 2026-07-26):
//   https://digitalcommons.unl.edu/cgi/viewcontent.cgi?article=1000&context=libraryscience
// answered HTTP 202 with a ~3 kB AWS WAF interstitial to a plain client, three times in a
// row with no progress. The body loads challenge.js from <id>.token.awswaf.com, which
// computes an aws-waf-token cookie and reloads the page. A non-JS client can never get
// past that; a real browser clears it in about a second, unattended. (Re-probed later the
// same day the same URLs answered 403 from a datacentre IP instead -- the edge picks
// between challenge and block, and neither is fetchable without a browser. Both outcomes
// argue for the bridge.)
//
// Consequences that live outside this file:
//   - chrome-extension/background.js pageIsCleared() had to learn the AWS WAF markers
//     (gokuProps / awsWafCookieDomainList / #challenge-container). Its Cloudflare-only
//     heuristics would otherwise declare the interstitial "cleared", fetch the challenge
//     HTML, and fail the %PDF- check -- a silent failure that reads as closed access.
//   - The instance list is the credentialed-fetch grant, so it lives in
//     src/bridge/allowed-hosts.js (mirrored in the extension), not here. This module
//     READS that list. Deriving detection from the boundary can only ever narrow what we
//     attempt; the reverse direction would let a change here widen the grant.

import { PATH_CONSTRAINED_HOSTS } from '../bridge/allowed-hosts.js';

/**
 * Known bepress instance hosts, taken from the allowlist so the two can never disagree.
 * Every PATH_CONSTRAINED_HOSTS entry exists for DigitalCommons; if that ever stops being
 * true this needs a discriminator rather than the whole list.
 */
const INSTANCE_HOSTS = new Set(PATH_CONSTRAINED_HOSTS.map((r) => r.host));

// The two content paths bepress serves a PDF from.
//   /cgi/viewcontent.cgi?article=<n>&context=<series>  -- the canonical download URL, the
//     one the landing page advertises as citation_pdf_url.
//   /context/<series>/article/<n>/type/native/viewcontent -- the same document under the
//     newer rewritten form. Kept because discovery returns both.
const VIEWCONTENT_CGI = '/cgi/viewcontent.cgi';
const CONTEXT_VIEWCONTENT = /^\/context\/[^/]+\/article\/\d+\/type\/[^/]+\/viewcontent$/;

/** Parse to a URL, or null. Never throws, never coerces a non-string. */
function parse(url) {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** True when a pathname is one of the bepress PDF endpoints. */
function isViewcontentPath(pathname) {
  return pathname === VIEWCONTENT_CGI || CONTEXT_VIEWCONTENT.test(pathname);
}

/**
 * True when this URL is a fetchable document on a known DigitalCommons instance:
 * https, a listed instance host, and a bepress viewcontent path.
 *
 * Host membership alone is not enough. The grant in allowed-hosts.js is host AND path,
 * and claiming a URL we would then be refused at the boundary just burns a race slot.
 */
export function isDigitalCommonsUrl(url) {
  const u = parse(url);
  if (!u) return false;
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password || u.port !== '') return false;
  if (!INSTANCE_HOSTS.has(u.hostname.toLowerCase())) return false;
  return isViewcontentPath(u.pathname);
}

/**
 * The PDF URL for a DigitalCommons document, or null.
 *
 * It is the viewcontent URL itself: bepress serves the PDF bytes straight from that
 * endpoint, there is nothing to construct. Normalised to a lowercase host with the
 * fragment dropped so the same document does not produce two cache keys; the query is
 * preserved verbatim because article= and context= ARE the document identity on the
 * /cgi/ form.
 */
export function digitalCommonsPdfUrl(url) {
  if (!isDigitalCommonsUrl(url)) return null;
  const u = new URL(url);
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';
  return u.toString();
}

/**
 * The page the bridge tab navigates to. Deliberately the PDF URL itself, not the article
 * landing page.
 *
 * background.js fetchPdf picks `landing = isAllowedUrl(referer) ? referer : url`. For
 * bepress the article landing page (/<series>/<n>/) is NOT allowlisted -- only the two
 * viewcontent paths are -- so referer would fall back to the PDF URL anyway. That
 * fallback is the correct behaviour here rather than an accident worth working around:
 * the WAF challenge is attached to the origin, so navigating the tab straight at
 * viewcontent.cgi lets that response run its own challenge, mint aws-waf-token for the
 * origin, and reload into the real document. The subsequent in-page fetch is then
 * same-origin with the cookie already set. Opening the landing page first would clear the
 * same cookie one navigation earlier and buy nothing, at the cost of widening the grant
 * to every path under an instance.
 */
export function digitalCommonsLandingUrl(url) {
  return digitalCommonsPdfUrl(url);
}

/**
 * Article-landing URLs (https://<host>/<series>/<n>/, or the /vol/iss/ journal form) are
 * NOT recognised, and cannot be mapped to viewcontent.cgi from the URL alone.
 *
 * The mapping needs the bepress `article=` number, which is an internal per-instance
 * counter unrelated to anything in the landing path: digitalcommons.usu.edu/etd/1/ is
 * article=1000, docs.lib.purdue.edu/jate/vol1/iss1/1/ is article=1020. The only reliable
 * source is the landing page's own citation_pdf_url meta tag -- an HTTP fetch, which is
 * exactly what the WAF blocks. So a landing URL is left to the other resolver sources,
 * and only a discovery result that already points at viewcontent is claimed here.
 *
 * Exported as a predicate so callers can tell "not DigitalCommons" from "DigitalCommons,
 * but we cannot reach the PDF from this URL" and log the difference.
 */
export function isDigitalCommonsLandingUrl(url) {
  const u = parse(url);
  if (!u) return false;
  if (!INSTANCE_HOSTS.has(u.hostname.toLowerCase())) return false;
  return !isViewcontentPath(u.pathname);
}

/** The instance hosts this source knows about. Read-only copy, for logging and tests. */
export function digitalCommonsHosts() {
  return [...INSTANCE_HOSTS];
}
