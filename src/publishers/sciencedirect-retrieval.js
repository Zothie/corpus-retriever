// ScienceDirect (sciencedirect.com) article retrieval through the browser bridge.
//
// Why the bridge: both the article page and the pdfft endpoint return 403 to a plain HTTP
// client (measured 2026-07-26). The gate is Cloudflare, which only a real browser clears,
// so the fetch happens inside the user's own Chrome. This module decides ownership, builds
// URLs, and -- the part that actually matters here -- decides how much of the bridge's time
// a given article is worth.
//
// ---------------------------------------------------------------------------
// Ownership: "Elsevier, but not Cell Press"
// ---------------------------------------------------------------------------
//
// cell.com and ScienceDirect share the 10.1016 registrant prefix and both resolve through
// linkinghub.elsevier.com, so the two sources would collide unless one is defined as the
// complement of the other. It is defined here, by delegating to isCellDoi(): this module
// carries no journal knowledge of its own, so the two matchers cannot drift apart and
// double-claim a DOI (the registry test enforces mutual exclusion).
//
// "Is Elsevier" is answered by the PREFIX ALONE -- no Crossref confirmation. 10.1016 is a
// registrant prefix, and registrant prefixes are not shared: a 10.1016 DOI is an Elsevier
// DOI by construction, so there is nothing for Crossref to confirm. What Crossref is needed
// for is the platform split, and isCellDoi already performs exactly that lookup, once,
// memoized, and only for the DOIs its offline table cannot settle. Adding a second
// publisher check would either duplicate that request or, for the table-hit case, introduce
// a network call where there is currently none -- paying latency to re-learn something the
// prefix already states.
//
// Elsevier's other prefixes (10.1006, 10.1053, 10.1054, 10.1078 and similar acquisitions)
// are deliberately NOT claimed. They are legacy and rare, and the mutual-exclusion argument
// above only holds inside 10.1016: isCellDoi returns a flat false outside it, so extending
// the prefix set would make this source claim any Cell Press content that ever appeared
// under one of those prefixes, with no discriminator to stop it. A missed legacy DOI costs
// one source in a race; a mis-claim breaks the pairing that keeps the registry coherent.
//
// Legacy 10.1016/S<ISSN>(yy)NNNNN-N DOIs carry no j.<token>, but they are still routed
// correctly: the ISSN is embedded in the DOI, so isCellDoi decides them offline in both
// directions and the complement is exact with no network access at all.
//
// ---------------------------------------------------------------------------
// The real design problem: most of ScienceDirect is paywalled and we have no access
// ---------------------------------------------------------------------------
//
// Behind the Cloudflare gate, most ScienceDirect content requires a subscription the user
// does not have, so the common outcome is: a tab opens, the challenge clears, pdfft returns
// an HTML paywall page, and the %PDF- check rejects it. That is an accepted outcome -- the
// value of this source is the free-to-read subset (gold OA, open archive, author
// manuscripts) that lives only on ScienceDirect -- but it has to be CHEAP, because every
// publisher source races in parallel and a slow failure holds a race slot open.
//
// Three signals were considered, and the decision on each is recorded here because the
// tempting answer is wrong in an invisible way.
//
// 1. Unpaywall says is_oa === false  ->  DO NOT SKIP. Attempt with a reduced budget.
//
//    is_oa is a statement about LICENSING, not about what the site will hand a browser.
//    Elsevier's "open archive" (free to read after an embargo, all rights reserved) and
//    promotional or editor-selected free-to-read articles have no OA licence, so Unpaywall
//    reports is_oa=false for them -- and they are precisely the subset that nothing except
//    this source can reach. Skipping on is_oa=false would therefore discard most of the
//    reason the source exists, to save a background tab. The failure is made cheap instead
//    of skipped: a likely-closed article gets CLOSED_BUDGET_MS rather than the full
//    challenge timeout, so it gives up early and frees the slot.
//
// 2. Unpaywall says is_oa === true with a free PDF somewhere ELSE  ->  SKIP IMMEDIATELY.
//
//    This is the safe direction of the same signal, and it is the one worth acting on. The
//    resolver already races unpaywall, openalex and core; when one of them holds a direct
//    PDF on a repository or PMC, that source wins in a fraction of the time a browser tab
//    needs, and this source can only ever lose. Returning null at once costs nothing (a
//    false positive here just means a cheaper source fetches the same paper) and it keeps
//    Chrome from opening tabs for papers that were never in doubt. A best_oa_location on
//    sciencedirect.com or linkinghub does NOT count as elsewhere: that is us, and reaching
//    it is the job.
//
// 3. Unpaywall is unreachable or says nothing  ->  attempt with the full budget.
//
//    Unknown must not degrade into "closed". An outage in a third-party API is not evidence
//    about a paper, and this source is the last route by construction.
//
// The access probe is memoized per DOI and never throws, in the same spirit as the PII
// resolver: a source that fails must fail quietly and let the race continue.

import { unpaywallSearch } from './academic-apis.js';
import { createLogger } from '../utils/logger.js';
import { isElsevierDoi, isCellDoi } from './cell-retrieval.js';
import { elsevierPii, normalizePii } from './elsevier-pii.js';

const logger = createLogger('sciencedirect-retrieval');

// Full budget for an article we have no reason to think is closed.
//
// Raised from 45 s once ScienceDirect's challenge became DETECTABLE. Measured 2026-07-28:
// sciencedirect.com serves Cloudflare's INTERACTIVE variant embedded in Elsevier's own page
// chrome -- ordinary title, none of the classic markers -- so it read as a cleared page, the
// extension fetched the interstitial, and the %PDF- check rejected it. A 45 s cap was
// harmless while the challenge was invisible, because the attempt was going to fail fast
// either way. Once the tab is surfaced for a human, that cap BECAME the failure: the request
// expired with "no reply within 45000 ms" before anyone could answer the puzzle.
//
// So this has to clear the extension's surface-the-tab moment plus however long a person
// takes, which is the same reasoning as HUMAN_SOLVE_BUDGET_MS: a limit that expires
// mid-solve throws away work the user has already started.
export const OPEN_BUDGET_MS = 60 * 60 * 1000;

// Budget for an article Unpaywall reports as not-OA. Deliberately still short: the common
// outcome is a paywall page, and this bounds how long that costs while the other sources are
// racing. The trade changed with the line above -- being wrong about "likely closed" now
// costs a LOST download rather than a slow one, since an interactive challenge cannot be
// solved in 20 s -- but giving every likely-paywalled article an hour-long slot would hold a
// race open for papers that are not coming.
export const CLOSED_BUDGET_MS = 20000;

/**
 * Does this DOI belong on ScienceDirect?
 *
 * The exact complement of isCellDoi inside the Elsevier prefix, so the two sources
 * partition the 10.1016 space and can never both claim a paper. `options` is forwarded
 * untouched, which is how the registry's guards keep the Crossref discriminator offline.
 *
 * The catch is belt-and-braces: isCellDoi documents that it never throws and absorbs its
 * own lookup failures, so no current input reaches it. It stays because that property is a
 * cross-module promise rather than something the caller can enforce, and the cost of it
 * being broken silently is that this matcher propagates into findPublisher.
 */
export async function isScienceDirectDoi(doi, options = {}) {
  if (!isElsevierDoi(doi)) return false;
  try {
    return !(await isCellDoi(doi, options));
  } catch (err) {
    logger.debug(`cell discriminator failed for ${doi}, declining: ${err.message}`);
    return false;
  }
}

/** DOI -> compact PII, via the shared Elsevier resolver. Memoized there, never throws. */
export async function scienceDirectPii(doi, options = {}) {
  return elsevierPii(doi, options);
}

/**
 * The article landing page: the page the bridge tab opens so the Cloudflare challenge
 * clears on the sciencedirect.com origin before the PDF is fetched same-origin. It is also
 * where the paywall is legible, which is what makes the fast-fail below possible.
 */
export function scienceDirectLandingUrl(pii) {
  const compact = normalizePii(pii);
  if (!compact) return null;
  return `https://www.sciencedirect.com/science/article/pii/${compact}`;
}

/**
 * The PDF endpoint. isDTMRedir=true is what ScienceDirect's own download button sends;
 * without it the endpoint bounces through an interstitial instead of serving bytes.
 */
export function scienceDirectPdfUrl(pii) {
  const compact = normalizePii(pii);
  if (!compact) return null;
  return `https://www.sciencedirect.com/science/article/pii/${compact}/pdfft?isDTMRedir=true`;
}

/** A best_oa_location that is Elsevier's own site is not a cheaper route -- it is this one. */
function isElsevierHost(url) {
  if (typeof url !== 'string') return false;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === 'sciencedirect.com'
    || host.endsWith('.sciencedirect.com')
    || host === 'elsevier.com'
    || host.endsWith('.elsevier.com');
}

/**
 * Default access probe: ask Unpaywall. Returns the raw facts, not a verdict, so the policy
 * lives in one place (classifyScienceDirectAccess) and a test can state the facts directly.
 */
async function probeViaUnpaywall(doi) {
  // unpaywallSearch takes no AbortSignal (it is an axios call with its own settings), so
  // the caller's signal is not forwarded. Cancellation is handled by the budget instead:
  // the probe is bounded by Unpaywall's own timeout and never gates a retry loop.
  const reply = await unpaywallSearch({ doi });
  const text = reply?.content?.[0]?.text;
  const parsed = text ? JSON.parse(text) : null;
  const result = parsed?.results?.[0];
  if (!result) return null;
  return {
    isOa: typeof result.is_oa === 'boolean' ? result.is_oa : null,
    pdfUrl: result.pdf_url || result.best_oa_location?.pdf_url || result.best_oa_location?.url || null,
  };
}

// doi -> access verdict. In-flight promises are stored too, so racing callers probe once.
const accessCache = new Map();

/** Test seam: forget every memoized access verdict. */
export function clearScienceDirectAccessCache() {
  accessCache.clear();
}

export const ACCESS_FREE_ELSEWHERE = 'free-elsewhere';
export const ACCESS_LIKELY_CLOSED = 'likely-closed';
export const ACCESS_UNKNOWN = 'unknown';

/**
 * How much of the bridge's time is this article worth?
 *
 *   free-elsewhere  a cheaper racing source already has a free PDF off Elsevier -> skip
 *   likely-closed   Unpaywall reports no OA licence -> attempt on the reduced budget
 *   unknown         no usable signal (including an outage) -> attempt on the full budget
 *
 * See the header for why is_oa=false is a budget signal and never a skip signal. Never
 * throws; a failed probe is "unknown", which is the attempt-anyway branch.
 */
export async function classifyScienceDirectAccess(doi, { probe = probeViaUnpaywall, signal } = {}) {
  if (typeof doi !== 'string' || !doi.trim()) return ACCESS_UNKNOWN;
  const key = doi.trim().toLowerCase();
  if (accessCache.has(key)) return accessCache.get(key);

  const pending = (async () => {
    let facts;
    try {
      facts = await probe(doi.trim(), { signal });
    } catch (err) {
      logger.debug(`access probe failed for ${doi}, attempting anyway: ${err.message}`);
      return ACCESS_UNKNOWN;
    }
    if (!facts) return ACCESS_UNKNOWN;
    if (facts.isOa === true && facts.pdfUrl && !isElsevierHost(facts.pdfUrl)) {
      return ACCESS_FREE_ELSEWHERE;
    }
    if (facts.isOa === false) return ACCESS_LIKELY_CLOSED;
    return ACCESS_UNKNOWN;
  })();

  accessCache.set(key, pending);
  const verdict = await pending;
  accessCache.set(key, verdict);
  return verdict;
}

/** Should the bridge be skipped entirely? True only for the safe direction of the signal. */
export function shouldSkipBridge(access) {
  return access === ACCESS_FREE_ELSEWHERE;
}

/** Milliseconds this article is allowed to hold a race slot for. */
export function bridgeBudgetMs(access) {
  return access === ACCESS_LIKELY_CLOSED ? CLOSED_BUDGET_MS : OPEN_BUDGET_MS;
}

// Markers specific to the ScienceDirect purchase interstitial. Matched case-insensitively
// against the first few KB of a non-PDF body, so a caller can tell "paywalled, stop" from
// "challenge did not clear, a retry might help" instead of burning the second URL pattern
// on an article we are never going to be served.
//
// Kept deliberately narrow, and the bias is towards missing a paywall rather than inventing
// one. A false positive here suppresses the retry on exactly the free-to-read articles this
// source exists for, which is the expensive direction to be wrong in; a false negative only
// costs one extra fetch. That rules out anything that also appears on a served article:
// "rights and content" is a link under every abstract including gold OA, and "checkAccess"
// is in the bundled page state on every article page. Both were considered and rejected.
const PAYWALL_MARKERS = [
  'get access to the full version of this article',
  'purchase pdf',
  'article-purchase',
  'subscribe to sciencedirect',
];

/**
 * Does this body look like ScienceDirect's paywall rather than a PDF or a challenge page?
 * Only ever consulted for bodies that already failed the %PDF- check; it decides whether to
 * retry, never whether to accept.
 */
export function isPaywallHtml(body) {
  if (!body) return false;
  // `Buffer` does not exist in a service worker, and this file is bundled into one. Reaching
  // for it unguarded made this function throw a ReferenceError there rather than return a
  // verdict -- latent only because accessGate.isRefusal has no caller yet. Feature-detect so
  // the Node side still gets the binary path and the worker gets the string path.
  const isBuffer = typeof Buffer !== 'undefined' && Buffer.isBuffer(body);
  const text = (isBuffer ? body.subarray(0, 8192).toString('latin1') : String(body).slice(0, 8192))
    .toLowerCase();
  return PAYWALL_MARKERS.some((marker) => text.includes(marker.toLowerCase()));
}
