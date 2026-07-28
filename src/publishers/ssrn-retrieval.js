// SSRN preprints are distributed as DOIs of the form 10.2139/ssrn.<numericId>. The
// doi.org resolver 302s to www.ssrn.com/abstract=<id>, which itself 302s to the real
// abstract page papers.ssrn.com/sol3/papers.cfm?abstract_id=<id>. That abstract page is
// behind Cloudflare (HTTP 403 "Just a moment..." to a plain axios GET), so the PDF can
// only be fetched by a browser that already holds a cf_clearance cookie. The actual PDF is
// served same-origin from papers.ssrn.com/sol3/Delivery.cfm?..., so the browser-extension
// bridge fetches it from inside the user's own Chrome (credentials:'include'), which is
// already cleared. This module only builds the URLs; the fetch lives in
// ssrn-extension-client.js.

/**
 * Match an SSRN DOI (10.2139/ssrn.<id>). Case-insensitive; the registrant prefix
 * 10.2139 is SSRN's and the /ssrn. sub-namespace is the preprint series.
 */
export function isSsrnDoi(doi) {
  return typeof doi === 'string' && /^10\.2139\/ssrn\./i.test(doi.trim());
}

/**
 * Extract the numeric abstract id from an SSRN DOI. Returns the id string (digits) or
 * null. Anchored so only the trailing numeric token after `ssrn.` is taken.
 */
export function ssrnAbstractId(doi) {
  if (typeof doi !== 'string') return null;
  const m = doi.trim().match(/^10\.2139\/ssrn\.(\d+)/i);
  return m ? m[1] : null;
}

/**
 * The real, server-rendered SSRN abstract page for an id. www.ssrn.com/abstract=<id>
 * just 302s here, so we go straight to the canonical URL.
 */
export function ssrnAbstractUrl(id) {
  return `https://papers.ssrn.com/sol3/papers.cfm?abstract_id=${encodeURIComponent(id)}`;
}

/**
 * The canonical Delivery.cfm PDF endpoint for an abstract id. This is the URL SSRN's own
 * "Download This Paper" button points at; it is code-constructed from the id (no HTML
 * parsing), and is fetched by the browser extension inside the user's real Chrome so the
 * existing cf_clearance + SSRN session cookies apply.
 */
export function ssrnDeliveryUrl(id) {
  const encoded = encodeURIComponent(id);
  return `https://papers.ssrn.com/sol3/Delivery.cfm/SSRN_ID${encoded}.pdf?abstractid=${encoded}&mirid=1`;
}
