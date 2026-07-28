// Wiley (onlinelibrary.wiley.com).
//
// Measured 2026-07-26:
//   - Both the article page and the PDF return HTTP 403 from Cloudflare to a plain client,
//     even one impersonating a real Chrome TLS fingerprint. Only a fetch from inside a
//     browser that already holds cf_clearance gets through.
//   - Wiley hosts its own free PDFs. In a 40-DOI sample of the 10.1002 prefix, 10 articles
//     had a free PDF and ALL TEN were on onlinelibrary.wiley.com -- no PMC, arXiv or
//     repository copy existed. So for a free Wiley article the bridge is the only route,
//     which is exactly the case that makes a publisher entry worth its cost.
//   - The mix was 8 bronze / 2 hybrid: bronze means free to read with no open licence,
//     which on Elsevier meant HTML-only, but Wiley's own PDF URL is what Unpaywall points
//     at, so here the PDF really is served.
//
// The PDF url is constructible: /doi/pdfdirect/<doi> is Wiley's canonical download path
// and embeds the DOI whole. No DOM read, no redirect round trip.

import { isSafeDoiPathSegment } from './doi-path-safety.js';

// Wiley publishes under two registrant prefixes. 10.1002 is Wiley's own; 10.1111 came in
// with Blackwell and is still served from the same platform (confirmed in the sample: a
// 10.1111 DOI resolved to an onlinelibrary.wiley.com/doi/pdfdirect/ URL).
//
// 10.1111 is not a clean partition. Some 10.1111 DOIs are hosted by OUP under a society
// agreement -- the sample contained two consecutive articles of the same journal,
// 10.1111/1740-9713.01393 on Wiley and .01397 on academic.oup.com. This entry claims both
// anyway, because the OUP entry is keyed on 10.1093 and so cannot claim them either; the
// worst case is one wasted tab whose body fails the %PDF- check. Deciding the split would
// need a per-DOI Crossref lookup, which costs more than the failure it would avoid.
const WILEY_DOI = /^10\.(1002|1111)\/(.+)$/i;

/** True for a Wiley/Blackwell DOI. */
export function isWileyDoi(doi) {
  return typeof doi === 'string' && WILEY_DOI.test(doi.trim());
}

/**
 * The identifier IS the DOI, embedded whole in /doi/pdfdirect/<doi>.
 *
 * Lower-cased so one DOI has one spelling. isSafeDoiPathSegment rejects anything that
 * would change which path is requested once embedded -- dot segments, doubled slashes,
 * encoded separators, query/fragment delimiters. See doi-path-safety.js.
 */
export function wileyArticleId(doi) {
  if (typeof doi !== 'string') return null;
  const trimmed = doi.trim();
  if (!WILEY_DOI.test(trimmed)) return null;
  if (!isSafeDoiPathSegment(trimmed)) return null;
  return trimmed.toLowerCase();
}

export function wileyLandingUrl(id) {
  return `https://onlinelibrary.wiley.com/doi/${id}`;
}

export function wileyPdfUrl(id) {
  return `https://onlinelibrary.wiley.com/doi/pdfdirect/${id}`;
}
