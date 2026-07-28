// Retrieval, run entirely inside the extension.
//
// This is the piece that makes the extension self-sufficient. It used to resolve
// and fetched for TEN publishers while the server still owned everything else -- the OA
// APIs, the mirrors, and the two-phase race that decides between them. Corpus Studio
// therefore still needed the server running to download anything that was not one of those
// ten. Now the whole ladder lives here.
//
// The design is ported rather than reinvented, because it was arrived at by measurement:
//
//   PHASE 1  every cheap source races in parallel; the first VALIDATED pdf wins and the
//            losers are abandoned. Cheap means "no tab, no human": the OA APIs and the
//            direct urls a caller already has.
//   PHASE 2  publishers, which may open a tab and may need a human to clear a challenge.
//   PHASE 3  mirrors, last on purpose -- see the ordering note below.
//
// Mirrors run LAST rather than in the parallel phase, which is a change from the server's
// ordering and a deliberate one. Mirrors have no bot-check, so in a flat race they
// routinely beat the publisher and a mirror copy silently displaces the authentic file --
// and %PDF- is a five-byte check, not an integrity guarantee. Preferring the publisher
// costs a few seconds on papers that are paywalled anyway.

import { credentialsFor, urlTier, TIER } from './allowlist.js';

/** A pdf is only a pdf if it starts with the magic. Everything downstream relies on this. */
const PDF_MAGIC = '%PDF-';
/** Matches the extension's own transfer ceiling. */
const MAX_PDF_BYTES = 80 * 1024 * 1024;
/** One source may not hold the whole ladder. Publishers get longer -- a human may be there. */
const CHEAP_SOURCE_TIMEOUT_MS = 25000;

/**
 * Fetch and validate one candidate url.
 *
 * Returns bytes only for something that really is a pdf, so a paywall page, a challenge
 * interstitial or an HTML error all fail the same way and the ladder moves on. Never
 * throws: a source that explodes must cost its own slot and nothing else.
 */
export async function fetchValidatedPdf(url, { timeoutMs = CHEAP_SOURCE_TIMEOUT_MS } = {}) {
  const credentials = credentialsFor(url);
  if (credentials === null) return { ok: false, error: 'host not allowlisted' };
  try {
    const res = await fetch(url, {
      credentials,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `http ${res.status}` };
    // Refuse before buffering: arrayBuffer() reads the whole body into worker memory, and
    // an origin serving hundreds of megabytes would OOM-kill the worker mid-transfer.
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_PDF_BYTES) {
      return { ok: false, error: `too large (${declared})` };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_PDF_BYTES) return { ok: false, error: 'too large' };
    if (buf.byteLength < 5) return { ok: false, error: `too short (${buf.byteLength})` };
    const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 5));
    if (magic !== PDF_MAGIC) {
      return { ok: false, error: `not a pdf (starts with ${JSON.stringify(magic)})` };
    }
    return { ok: true, buf, bytes: buf.byteLength };
  } catch (err) {
    return { ok: false, error: `${err.name}: ${err.message}` };
  }
}

/**
 * Race a set of candidate urls, keeping the first that validates.
 *
 * Concurrent because these are independent and none is authoritative. A rejection is not
 * fatal -- Promise.any would discard the reasons, so failures are collected instead and
 * reported when nothing wins, which is what makes a total failure diagnosable.
 */
async function raceCandidates(candidates, timeoutMs) {
  if (candidates.length === 0) return { ok: false, tried: [] };
  const tried = [];
  const results = await Promise.all(candidates.map(async (c) => {
    const out = await fetchValidatedPdf(c.url, { timeoutMs });
    if (!out.ok) tried.push({ source: c.source, error: out.error });
    return out.ok ? { ...out, source: c.source, url: c.url } : null;
  }));
  const winner = results.find(Boolean);
  return winner ? { ok: true, ...winner, tried } : { ok: false, tried };
}

/**
 * Everything the OA resolvers can offer for a DOI.
 *
 * `email` is required by Unpaywall and PMC and has no sensible default -- inventing one
 * would send a wrong address on every call, and Unpaywall answers 422 to the obvious
 * placeholders.
 */
export async function oaCandidates(doi, { email, coreApiKey, resolve }) {
  if (!doi) return [];
  const found = await resolve(doi, { email, coreApiKey });
  return found
    .filter((c) => c.pdfUrl && urlTier(c.pdfUrl) !== TIER.NONE)
    .map((c) => ({ source: c.source, url: c.pdfUrl }));
}

/**
 * The full ladder for one paper.
 *
 * `deps` carries the resolvers rather than importing them, so this file is testable without
 * a browser and the worker can hand it the inlined copies.
 */
export async function retrievePdf(request, deps) {
  const { doi, pdfUrl, email, coreApiKey } = request;
  const attempts = [];

  // PHASE 1 -- cheap and parallel. A direct url the caller already has costs nothing to try
  // alongside the OA APIs, so it is not a separate step.
  const cheap = [];
  if (pdfUrl && urlTier(pdfUrl) !== TIER.NONE) cheap.push({ source: 'direct', url: pdfUrl });
  cheap.push(...await deps.oaCandidates(doi, { email, coreApiKey }));

  const oa = await raceCandidates(cheap, CHEAP_SOURCE_TIMEOUT_MS);
  attempts.push(...oa.tried);
  if (oa.ok) return { ok: true, source: oa.source, url: oa.url, buf: oa.buf, attempts };

  // PHASE 2 -- publishers. Sequential: each may open a tab, and two tabs racing for the
  // user's attention is worse than waiting.
  for (const attempt of await deps.publisherAttempts(doi, pdfUrl)) {
    const out = await attempt.run();
    if (out.ok) return { ok: true, source: attempt.source, url: out.url, buf: out.buf, attempts };
    attempts.push({ source: attempt.source, error: out.error });
  }

  // PHASE 3 -- mirrors, last. See the header for why they do not race the publishers.
  for (const attempt of await deps.mirrorAttempts(doi)) {
    const out = await attempt.run();
    if (out.ok) return { ok: true, source: attempt.source, url: out.url, buf: out.buf, attempts };
    attempts.push({ source: attempt.source, error: out.error });
  }

  return { ok: false, error: 'no source produced a valid pdf', attempts };
}
