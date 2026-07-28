// Mendeley Data (data.mendeley.com) research datasets.
//
// WHY THIS NEEDS THE BROWSER BRIDGE, AND WHY IT NEEDS MORE THAN fetch_pdf.
// Measured 2026-07-26 against https://data.mendeley.com/datasets/hxfhg7ycpr/1:
// the served HTML contains no file references whatsoever -- zero .pdf urls, zero
// /public-files/ paths, no "filename" JSON, no __NEXT_DATA__ blob, and the string
// "download" appears 0 times. The file list is rendered client-side after
// hydration. The public API is no help either: api.data.mendeley.com answers 401
// for /datasets/<id> and 404 for /datasets/<id>/versions/1/files without an OAuth
// token. So there is no server-side route to a file URL at all, and the only way
// to learn one is to read the hydrated DOM inside a real tab. That is what the
// bridge's fetch_links capability is for.
//
// DATASETS ARE NOT PAPERS. A dataset holds arbitrary files: .csv, .zip, images,
// sometimes a .pdf. Only a PDF may be offered as a paper, so pickPdfLink filters
// on the .pdf extension before anything is fetched. The downstream %PDF- check in
// the bridge and in save-to-vault is what actually guarantees correctness; this
// filter is what stops the source claiming a .zip is a paper in the first place.
//
// LIMITATION: a dataset with several PDFs yields only the first one. There is no
// metadata in the DOM that reliably identifies "the paper" among them, and
// guessing would be worse than being predictable. A caller that needs the others
// has to go to the landing page by hand.

/**
 * Mendeley Data mints DOIs under the 10.17632 registrant prefix, one per dataset
 * version: 10.17632/<datasetId>.<version>. The prefix belongs to Mendeley Data
 * alone (it is not shared with Elsevier's article platforms, which are 10.1016),
 * so the prefix is a sufficient discriminator and cannot collide with the cell.com
 * or ScienceDirect matchers.
 */
const DOI_RE = /^10\.17632\/([a-z0-9]+)(?:\.(\d+))?$/i;

// data.mendeley.com/datasets/<datasetId>[/<version>]. The dataset id is an
// opaque lowercase alphanumeric token (10 characters in every sample seen, but
// the length is not part of the contract, so it is not pinned here).
const URL_RE = /^https?:\/\/(?:www\.)?data\.mendeley\.com\/datasets\/([a-z0-9]+)(?:\/(\d+))?(?:[/?#]|$)/i;

/** True for a Mendeley Data dataset DOI. */
export function isMendeleyDoi(doi) {
  return typeof doi === 'string' && DOI_RE.test(doi.trim());
}

/** True for a data.mendeley.com dataset URL. */
export function isMendeleyUrl(url) {
  return typeof url === 'string' && URL_RE.test(url.trim());
}

/**
 * The dataset identifier this module passes around: "<datasetId>" or
 * "<datasetId>/<version>" when a version was given. Returns null when neither
 * argument is a Mendeley dataset. Synchronous and pure -- the registry requires
 * extractId to be.
 */
export function mendeleyDatasetId(doi, url = null) {
  const fromDoi = typeof doi === 'string' ? DOI_RE.exec(doi.trim()) : null;
  const m = fromDoi || (typeof url === 'string' ? URL_RE.exec(url.trim()) : null);
  if (!m) return null;
  const id = m[1].toLowerCase();
  return m[2] ? `${id}/${m[2]}` : id;
}

/**
 * The dataset page. Opening this is the whole point: it is where hydration
 * happens and therefore the only place the file list exists.
 */
export function mendeleyLandingUrl(id) {
  const parts = String(id).split('/');
  const dataset = encodeURIComponent(parts[0]);
  const version = parts[1] ? `/${encodeURIComponent(parts[1])}` : '';
  return `https://data.mendeley.com/datasets/${dataset}${version}`;
}

