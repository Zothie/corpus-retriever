// Open-access resolvers: DOI in, candidate PDF url out.
//
// Ported from the OA sources in src/tools/save-to-vault.js. These are the cheap half of
// retrieval -- plain JSON APIs, no captcha, no browser needed -- and they are what makes a
// genuinely-OA paper download without ever bothering the user or a mirror.
//
// This module RESOLVES ONLY. It does not fetch bytes: that goes through the bridge's
// existing fetch path, which owns the %PDF- magic check, the size cap and the chunked
// transfer. Keeping resolution separate is what lets these be tested without a browser.
//
// Measured 2026-07-28 against 10.1038/s41598-020-69209-2 (gold OA), all 200:
//
//   api.unpaywall.org         best_oa_location.url_for_pdf        ACAO *
//   api.openalex.org          best_oa_location.pdf_url            ACAO *
//   api.core.ac.uk            results[].downloadUrl               no ACAO, key required
//   www.ncbi.nlm.nih.gov      idconv -> pmcid                     no ACAO
//
// A missing ACAO does not block a service worker holding host_permissions, which is CORS
// exempt. It is recorded because it means the endpoint was not designed for browser use.
//
// Note that Unpaywall and OpenAlex both answered with a nature.com pdf url for that DOI --
// a CREDENTIALED-tier host. So an OA resolver can legitimately hand back a publisher url,
// and the tier resolver decides the credentials at fetch time. That is exactly why the tier
// is derived from the url rather than from which source produced it.

import { credentialsFor } from './allowlist.js';

/**
 * Fetch JSON through the tier resolver. Never throws: an OA API being down must cost its
 * own candidate and nothing else, since these race against every other source.
 */
async function getJsonOa(url) {
  const credentials = credentialsFor(url);
  if (credentials === null) return null;
  try {
    const res = await fetch(url, { credentials, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Unpaywall. `email` is REQUIRED by the API -- a request without it is refused, so the
 * caller has to supply one rather than this inventing a default that would be wrong.
 */
export async function unpaywallPdfUrl(doi, { email }) {
  if (!doi || !email) return null;
  // A placeholder address is refused with 422 "Please use your own email address in API
  // calls", and getJsonOa turns every non-200 into null -- so a misconfigured email silently
  // removes Unpaywall from every search. Warn rather than throw: these resolvers run under
  // Promise.all and the contract is that none of them ever rejects, so throwing here would
  // take out every OTHER OA source too, which is worse than the bug being warned about.
  if (/^(test|user|you|someone|email|example)@|@example\.(com|org|net)$/i.test(email)) {
    console.warn(
      `[oa] Unpaywall rejects placeholder addresses like "${email}" with 422 -- `
      + 'set a real contact email or this source silently returns nothing.',
    );
  }
  const u = new URL(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}`);
  u.searchParams.set('email', email);
  const data = await getJsonOa(u.toString());
  const loc = data?.best_oa_location;
  if (!loc) return null;
  return {
    pdfUrl: loc.url_for_pdf || null,
    landingUrl: loc.url_for_landing_page || null,
    oaStatus: data.oa_status || null,
  };
}

/**
 * OpenAlex. Aggregates OA locations across repositories, publisher-OA and PMC, and often
 * exposes a direct pdf_url that Unpaywall misses -- which is why both run rather than one
 * being treated as a superset of the other. No key, no email.
 */
export async function openAlexPdfUrl(doi) {
  if (!doi) return null;
  const data = await getJsonOa(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`);
  const loc = data?.best_oa_location;
  if (!loc) return null;
  return {
    pdfUrl: loc.pdf_url || null,
    landingUrl: loc.landing_page_url || null,
  };
}

/**
 * CORE. Key-optional by design: without one this returns null rather than erroring, so a
 * user who never sets a key simply has one fewer source instead of a failing one.
 */
export async function corePdfUrl(doi, { apiKey } = {}) {
  if (!doi || !apiKey) return null;
  const u = new URL('https://api.core.ac.uk/v3/search/works');
  u.searchParams.set('q', `doi:"${doi}"`);
  u.searchParams.set('limit', '1');
  u.searchParams.set('apiKey', apiKey);
  const data = await getJsonOa(u.toString());
  const hit = data?.results?.[0];
  return hit?.downloadUrl ? { pdfUrl: hit.downloadUrl, landingUrl: hit.doi || null } : null;
}

/**
 * DOI -> PMC id -> the OA pdf.
 *
 * Worth having even when a DOI looks closed: a paper with no publisher OA copy can still
 * have a free deposited one in PMC that neither Unpaywall nor the publisher surfaces. The
 * id lookup is a separate host from eutils (www.ncbi.nlm.nih.gov), which is why both are
 * granted.
 */
export async function pmcPdfUrl(doi, { email }) {
  if (!doi || !email) return null;
  const u = new URL('https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/');
  u.searchParams.set('ids', doi);
  u.searchParams.set('format', 'json');
  u.searchParams.set('tool', 'corpus-studio');
  u.searchParams.set('email', email);
  const data = await getJsonOa(u.toString());
  const pmcid = data?.records?.[0]?.pmcid;
  if (!pmcid) return null;
  return {
    // The /pdf/ path 302s to the real file; the bridge follows redirects inside one fetch.
    pdfUrl: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/pdf/`,
    landingUrl: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`,
  };
}

/** Every OA resolver, in the order they should be tried. */
export const OA_SOURCES = ['unpaywall', 'openalex', 'pmc', 'core'];

/**
 * Resolve a DOI through every OA source at once.
 *
 * Concurrent rather than sequential: they are independent, none is authoritative, and the
 * whole point of the OA tier is that it is cheap. Returns every candidate found, in
 * OA_SOURCES order, so the caller can try them in preference order and fall through to the
 * next when one fails the %PDF- check.
 */
export async function resolveOaCandidates(doi, { email, coreApiKey } = {}) {
  const [unpaywall, openalex, pmc, core] = await Promise.all([
    unpaywallPdfUrl(doi, { email }),
    openAlexPdfUrl(doi),
    pmcPdfUrl(doi, { email }),
    corePdfUrl(doi, { apiKey: coreApiKey }),
  ]);
  const found = { unpaywall, openalex, pmc, core };
  const out = [];
  for (const name of OA_SOURCES) {
    const hit = found[name];
    if (hit?.pdfUrl) out.push({ source: name, ...hit });
  }
  return out;
}
