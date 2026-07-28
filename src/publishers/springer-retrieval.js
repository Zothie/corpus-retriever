// Springer (link.springer.com).
//
// Measured 2026-07-26:
//   - link.springer.com answers a plain client with a 3038-byte F5/Shape "Client Challenge"
//     page (assets under /_fs-ch-*), status 200. The article page and the .pdf return the
//     SAME body, so no HTTP client reaches a PDF. Same wall as nature.com, which is the
//     same corporate group.
//   - Where Springer content IS free, the publisher copy lives on link.springer.com: in a
//     40-DOI sample of the 10.1007 prefix, 37 were closed and the one hybrid article's
//     publisher PDF was https://link.springer.com/content/pdf/<doi>.pdf. That is the
//     opposite of ScienceDirect, whose free PDFs are always hosted elsewhere.
//
// Springer's OA rate on this prefix is low, so this source will usually resolve to a
// paywall page and be rejected by the %PDF- check. It is registered anyway because when a
// Springer article IS free, nothing else in the pipeline can fetch it.
//
// The PDF url is constructible: Springer serves every article at
// /content/pdf/<doi>.pdf, so the DOI itself is the identifier and no DOM read or
// redirect round trip is needed.

import { isSafeDoiPathSegment } from './doi-path-safety.js';

// 10.1007 is Springer's own registrant prefix. The sibling Springer Nature prefixes are
// deliberately NOT claimed here: 10.1038 belongs to the nature entry, and 10.1186 (BioMed
// Central) is fully open access with every article mirrored into PMC, which the existing
// captcha-free sources already fetch -- a bridge source there would add nothing.
const SPRINGER_DOI = /^10\.1007\/(.+)$/i;

/** True for a Springer DOI. */
export function isSpringerDoi(doi) {
  return typeof doi === 'string' && SPRINGER_DOI.test(doi.trim());
}

/**
 * The identifier IS the DOI: /content/pdf/<doi>.pdf embeds it whole, slashes included.
 *
 * Returned trimmed and lower-cased so two spellings of one DOI cannot produce two
 * different cache keys or URLs. isSafeDoiPathSegment rejects anything that would change
 * which path is requested once embedded -- dot segments, doubled slashes, encoded
 * separators, query/fragment delimiters. See doi-path-safety.js for the measured escapes.
 */
export function springerArticleId(doi) {
  if (typeof doi !== 'string') return null;
  const trimmed = doi.trim();
  if (!SPRINGER_DOI.test(trimmed)) return null;
  if (!isSafeDoiPathSegment(trimmed)) return null;
  return trimmed.toLowerCase();
}

export function springerLandingUrl(id) {
  return `https://link.springer.com/article/${id}`;
}

export function springerPdfUrl(id) {
  return `https://link.springer.com/content/pdf/${id}.pdf`;
}
