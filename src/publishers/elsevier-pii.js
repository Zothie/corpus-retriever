// Shared Elsevier PII resolution.
//
// Every Elsevier platform addresses an article by its PII, not by its DOI. cell.com,
// ScienceDirect and linkinghub all key off the same identifier, so this module is the one
// place that knows how to obtain and reshape it. cell-retrieval.js and
// sciencedirect-retrieval.js both import it rather than each carrying a copy.
//
// How a DOI becomes a PII: https://doi.org/<doi> 302s to
// https://linkinghub.elsevier.com/retrieve/pii/<PII>. That is a network round trip, so it
// is memoized here and never throws -- a failed resolve returns null and the caller's
// source simply loses its race, which is cheaper than propagating an error through the
// resolver.
//
// Following the chain past linkinghub is pointless and is NOT attempted: linkinghub routes
// onward only with JavaScript, so a server-side redirect chain stops there for cell.com and
// ScienceDirect articles alike. Measured 2026-07-26 across six journals on both platforms.
// The final host is therefore not discoverable this way; only the PII is, which is all we
// need since each platform's URL patterns are constructible from it.
//
// Two PII spellings exist and both are in use:
//   compact     S240584402300419X       -- what linkinghub and ScienceDirect URLs carry
//   punctuated  S2405-8440(23)00419-X   -- what cell.com's own links carry
// They are the same identifier: the punctuation splits the print ISSN, the two-digit year
// and the check digit. Conversion is mechanical and lossless in both directions, so this
// module stores the compact form canonically and offers punctuatePii() for cell.com.

import { paperRateLimiter } from '../utils/rate-limiter.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('elsevier-pii');

// A PII is "S" plus 16 alphanumerics. The last character is a check digit that can be X,
// and the ninth character of the ISSN part can also be X (0304-405X is a real Elsevier
// ISSN), so the pattern cannot be "S plus digits".
const COMPACT_PII = /^S[0-9X]{16}$/i;

// Punctuated form: S<4 digits>-<4 alnum>(<2 digits>)<5 digits>-<check>.
const PUNCTUATED_PII = /^S\d{4}-[0-9X]{4}\(\d{2}\)\d{5}-[0-9X]$/i;

/** Strip punctuation and upper-case, giving the canonical compact PII, or null. */
export function normalizePii(raw) {
  if (typeof raw !== 'string') return null;
  const stripped = raw.trim().replace(/[-()]/g, '').toUpperCase();
  return COMPACT_PII.test(stripped) ? stripped : null;
}

/**
 * Compact PII -> the punctuated spelling cell.com uses in its own links.
 * Returns null for anything that is not a valid compact PII, so a caller cannot
 * accidentally build a URL around a malformed identifier.
 */
export function punctuatePii(pii) {
  const compact = normalizePii(pii);
  if (!compact) return null;
  const m = compact.match(/^S([0-9X]{4})([0-9X]{4})(\d{2})(\d{5})([0-9X])$/i);
  if (!m) return null;
  return `S${m[1]}-${m[2]}(${m[3]})${m[4]}-${m[5]}`;
}

/** True for either spelling of a PII. */
export function isPii(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return COMPACT_PII.test(v) || PUNCTUATED_PII.test(v);
}

/**
 * Pull a PII out of any Elsevier-shaped URL, without a network call.
 *
 * Covers the three forms we actually see: linkinghub's /retrieve/pii/<PII>, ScienceDirect's
 * /science/article/pii/<PII>, and cell.com's ?pii=<PII> query form. Returns the compact
 * spelling or null.
 */
export function piiFromUrl(url) {
  if (typeof url !== 'string') return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const fromQuery = u.searchParams.get('pii');
  if (fromQuery) {
    const normalized = normalizePii(fromQuery);
    if (normalized) return normalized;
  }
  // Path forms. Decoded first because a punctuated PII in a path arrives percent-encoded
  // ("S2405-8440%2823%2900419-X"), and the parentheses must be visible to the matcher.
  let path;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    path = u.pathname;
  }
  for (const segment of path.split('/')) {
    const normalized = normalizePii(segment.replace(/\.(pdf|xml)$/i, ''));
    if (normalized) return normalized;
  }
  return null;
}

// doi (lowercased) -> compact PII, or null when the resolve failed. In-flight promises are
// stored too, so N concurrent sources asking for the same DOI make one request.
const piiCache = new Map();

/** Test seam: drop everything memoized. */
export function clearPiiCache() {
  piiCache.clear();
}

/**
 * Record a PII we obtained for free.
 *
 * Crossref's works record carries resource.primary.URL, which for Elsevier is the very
 * linkinghub URL the doi.org redirect would have produced. When the cell.com matcher has
 * already paid for a Crossref lookup, seeding the cache here means the subsequent
 * elsevierPii() call costs nothing. Never overwrites a real cached value with null.
 */
export function seedPii(doi, pii) {
  if (typeof doi !== 'string') return;
  const compact = normalizePii(pii);
  if (!compact) return;
  piiCache.set(doi.trim().toLowerCase(), compact);
}

/** Synchronous peek at the memo. Returns the PII, or null/undefined when not resolved. */
export function cachedPii(doi) {
  if (typeof doi !== 'string') return undefined;
  const hit = piiCache.get(doi.trim().toLowerCase());
  return hit instanceof Promise ? undefined : hit;
}

/**
 * Default resolver: follow doi.org and report where we landed.
 *
 * A resolver's job is to produce the final URL, not to parse it -- elsevierPii extracts
 * the PII. Keeping the split here means an injected resolver is just "what does this DOI
 * redirect to", which is the thing a test can state without knowing PII syntax.
 */
async function resolveViaDoiOrg(doi, { signal } = {}) {
  await paperRateLimiter.acquire('doi-org', { signal }).catch(() => {});
  // HEAD is enough -- we only want the final URL, never the body. redirect:'follow' walks
  // doi.org -> linkinghub and stops there, which is exactly the hop that carries the PII.
  const response = await fetch(`https://doi.org/${encodeURI(doi)}`, {
    method: 'HEAD',
    redirect: 'follow',
    signal,
  });
  return response.url;
}

/**
 * DOI -> compact PII, memoized, never throwing.
 *
 * `resolve` is injectable so tests (and the registry's offline guards) never touch the
 * network. It returns the URL the DOI lands on; the PII is extracted from that here, so a
 * resolver that hands back a bare PII works too. A failed or malformed resolve caches
 * null: the DOI genuinely has no PII we can reach, and retrying it on every source in the
 * race would multiply the latency of the failure without changing the outcome.
 */
export async function elsevierPii(doi, { resolve = resolveViaDoiOrg, signal } = {}) {
  if (typeof doi !== 'string' || !doi.trim()) return null;
  const key = doi.trim().toLowerCase();
  if (piiCache.has(key)) return piiCache.get(key);

  const pending = (async () => {
    try {
      const landed = await resolve(doi.trim(), { signal });
      // Accept either a landing URL or an already-extracted PII, so callers are not
      // forced to know which shape the resolver speaks.
      return piiFromUrl(landed) || normalizePii(landed);
    } catch (err) {
      logger.debug(`PII resolve failed for ${doi}: ${err.message}`);
      return null;
    }
  })();

  piiCache.set(key, pending);
  const pii = await pending;
  piiCache.set(key, pii);
  return pii;
}
