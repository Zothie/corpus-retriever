// Springer Nature (nature.com).
//
// Measured 2026-07-26:
//   - www.nature.com serves a JS "Client Challenge" (an F5/Shape interstitial under
//     /_fs-ch-*) to any plain client. Both the article page and the .pdf return the same
//     3038-byte body, so no HTTP client reaches the PDF.
//   - Unlike ScienceDirect, Nature hosts its OWN open-access PDFs. In a 7-paper sample of
//     OA Nature-family articles, 6 had NO working pdf route outside nature.com -- the
//     arXiv/PMC copies the other sources rely on simply did not exist. That gap is what
//     makes this source worth having.
//
// The PDF url is constructible from the DOI, so no DOM read is needed: Springer Nature
// DOIs are 10.1038/<article-id>, and the article lives at /articles/<article-id> with the
// PDF at the same path plus ".pdf".

const NATURE_DOI = /^10\.1038\/(.+)$/i;

/** True for a Springer Nature DOI. */
export function isNatureDoi(doi) {
  return typeof doi === 'string' && NATURE_DOI.test(doi.trim());
}

/**
 * The article id embedded in the DOI, e.g. "s41586-020-2649-2".
 *
 * Legacy DOIs (10.1038/nature12373, 10.1038/nmeth.1923) carry an id that still resolves
 * on the same path, so they need no special case. Anything with a slash in the suffix is
 * rejected: that is not an article id and would let a crafted DOI reach another path.
 */
export function natureArticleId(doi) {
  if (typeof doi !== 'string') return null;
  const m = NATURE_DOI.exec(doi.trim());
  if (!m) return null;
  const id = m[1].trim();
  if (!id || id.includes('/') || id.includes('?') || id.includes('#')) return null;
  return id;
}

export function natureLandingUrl(id) {
  return `https://www.nature.com/articles/${id}`;
}

export function naturePdfUrl(id) {
  return `https://www.nature.com/articles/${id}.pdf`;
}
