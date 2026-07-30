// American Chemical Society (pubs.acs.org).
//
// Measured 2026-07-26:
//   - Both the article page and the PDF return HTTP 403 from Cloudflare to a plain client
//     impersonating a real Chrome TLS fingerprint. Nothing outside a cleared browser
//     reaches either.
//   - ACS hosts its own free PDFs, and only its own. In a 40-DOI sample of the 10.1021
//     prefix, 10 articles had a free PDF and ALL TEN were on pubs.acs.org -- zero PMC or
//     repository copies. Chemistry is poorly served by the OA mirrors the other sources
//     use, so for a free ACS article the bridge is the only route.
//   - The whole free set was bronze (free to read, no open licence), and the PDF is
//     genuinely served rather than gated behind HTML as it is on ScienceDirect.
//
// The PDF url is NOT constructible, which cost a live failure to discover. Unpaywall
// reports bronze ACS PDFs at pubs.acs.org/doi/pdf/<doi>, and that shape 404s: measured
// through the bridge, /doi/pdf/10.1021/jacs.6c07767 returned "Not Found | ACS
// Publications". ACS runs on Silverchair, the same platform as OUP, and its real download
// path is the same shape as OUP's -- /<journal-code>/article-pdf/doi/<doi>/<asset-id>/<file>.pdf
// -- carrying both a journal code and an internal asset id that appear nowhere in the DOI.
//
// So pdfUrl returns null and the resolver reads the link out of the rendered page, as it
// does for OUP and Mendeley. The LANDING url is constructible and was verified live:
// /doi/<doi> serves the article page, which links the real PDF.

import { isSafeDoiPathSegment } from './doi-path-safety.js';

// 10.1021 is ACS's sole registrant prefix.
const ACS_DOI = /^10\.1021\/(.+)$/i;

/** True for an ACS DOI. */
export function isAcsDoi(doi) {
  return typeof doi === 'string' && ACS_DOI.test(doi.trim());
}

/**
 * The identifier IS the DOI, embedded whole in the landing url /doi/<doi>.
 *
 * Lower-cased for a single spelling. isSafeDoiPathSegment rejects anything that would
 * change which path is requested once embedded -- dot segments, doubled slashes, encoded
 * separators, query/fragment delimiters. See doi-path-safety.js for the measured escapes.
 */
export function acsArticleId(doi) {
  if (typeof doi !== 'string') return null;
  const trimmed = doi.trim();
  if (!ACS_DOI.test(trimmed)) return null;
  if (!isSafeDoiPathSegment(trimmed)) return null;
  return trimmed.toLowerCase();
}

export function acsLandingUrl(id) {
  return `https://pubs.acs.org/doi/${id}`;
}

/**
 * Picks the full text out of an ACS article page.
 *
 * Silverchair serves the article PDF from /<journal-code>/article-pdf/, and the page also
 * links supplementary material as .pdf. Matching on `article-pdf` rather than on `.pdf` is
 * what keeps a supplement from being filed as the paper -- worse than a failed download,
 * because nothing downstream can detect it.
 *
 * TWO shapes, both measured live:
 *   .../jacsat/article-pdf/doi/10.1021/jacs.6c07767/66240843/jacs.6c07767.pdf
 *   .../accacs/article-pdf/16/13/12814/65101330/cs-2026-025563.pdf
 *
 * The second is the volume/issue form, and requiring `doi/` rejected it -- so a free ACS
 * paper whose page offered exactly one real PDF link came back as "no link matched this
 * publisher". Supplements live under /doi/suppl/ and carry no `article-pdf` segment, so
 * dropping the `doi/` requirement widens this to the article PDF and nothing else.
 */
export const ACS_PDF_LINK = /\/article-pdf\//;
