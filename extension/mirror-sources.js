// Mirrors: Sci-Hub, LibGen and Anna's Archive.
//
// All three are wired. A mirror is skipped only when it is unreachable AT THE TIME, decided
// by probing rather than by a hardcoded belief about which domains work -- because the
// domains rotate constantly and a stale list is indistinguishable from an outage.
//
// VERIFICATION STATUS, stated honestly. The resolve chain is confirmed live: libgen walks
// index -> edition -> ads -> get.php and returns a keyed url, measured repeatedly. What has
// NOT been observed end to end is a mirror download completing THROUGH THE EXTENSION,
// because libgen rate-limits after a handful of probes and testing this needs many. The
// failures seen were all external (429/timeout/"not on libgen" for papers libgen genuinely
// lacks), not code -- but "not yet observed" is not "working", and the difference matters
// for anyone relying on this path.
//
// That distinction cost a wrong conclusion once already. Probing annas-archive.org/.se and
// libgen.is/.rs/.st on 2026-07-28 gave DNS failures and TCP timeouts, and I reported both
// networks as blocked. They were simply DEAD DOMAINS. The live sets, which this repo
// already configured, all answer:
//
//   libgen.bz .li .la .vg .gl            200
//   annas-archive.gd .pk .gl .li         200
//   annas-archive.org .se                DNS gaierror  (the stale ones I had tested)
//
// So availability is measured per run, and nothing here assumes a mirror is up or down.

import { credentialsFor, urlTier, TIER } from './allowlist.js';

// Sci-Hub publishes its rotating set as a CSV. Every host it names is intersected with the
// allowlist below, so a spoofed list can only REMOVE mirrors, never add one.
const SCIHUB_LIST_URL = 'https://cdn.lowyiyiu.com/scihub/';
const SCIHUB_FALLBACK = ['sci-hub.ru', 'sci-hub.st', 'sci-hub.su', 'sci-hub.red', 'sci-hub.box'];

// Kept in the same order as src/tools/libgen-retrieval.js and scihub-retrieval.js, which is
// roughly fastest-first as measured there.
const LIBGEN_MIRRORS = ['libgen.bz', 'libgen.li', 'libgen.la', 'libgen.vg', 'libgen.gl'];
const ANNAS_MIRRORS = ['annas-archive.gd', 'annas-archive.pk', 'annas-archive.gl', 'annas-archive.li'];

// A mirror gets this long to answer before the next is tried. Short on purpose: mirrors are
// raced against every other source, and one slow-but-not-dead host must not hold the race.
// 8s was too short for libgen, whose search hop measured 10.5s -- it aborted and the source
// reported "not on libgen" for a paper libgen has, which is a wrong answer rather than a
// slow one. But raising it multiplies: these are probed SEQUENTIALLY across 14 hosts, so
// the phase's worst case is minutes. The budget below is what actually bounds it.
const PROBE_TIMEOUT_MS_MIRROR = 12000;
/**
 * Whole-phase ceiling for one mirror source.
 *
 * Measured: probing every host at the old timeouts put the mirror phase past 170s, which a
 * user experiences as a hung download rather than as a slow one. Each source gets this long
 * to produce something, after which the ladder moves on -- a paper that needs three minutes
 * of mirror-walking is one the user would rather be told about.
 */
const SOURCE_BUDGET_MS_MIRROR = 45000;
const FETCH_TIMEOUT_MS_MIRROR = 20000;

/** Fetch text with a timeout, through the tier resolver. Never throws. */
async function getTextMirror(url, timeoutMs = FETCH_TIMEOUT_MS_MIRROR) {
  const credentials = credentialsFor(url);
  if (credentials === null) return null;
  try {
    const res = await fetch(url, { credentials, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) { lastMirrorError = `http ${res.status}`; return null; }
    return await res.text();
  } catch (err) {
    lastMirrorError = `${err.name}: ${err.message}`;
    return null;
  }
}

/**
 * The first mirror in `hosts` that answers, or null when none do.
 *
 * Sequential rather than parallel: the point is to use ONE mirror, and hitting five at once
 * to discard four is rude to hosts that are donating bandwidth.
 */
let lastMirrorError = null;

/**
 * The mirror PHASE's deadline, as an absolute timestamp, or 0 when no phase is running.
 *
 * Every mirror helper is bounded by its own budget AND by this. Without the second bound the
 * per-source budgets simply add up: a source allowed to start with a little time left ran its
 * own independent 45s walk, and libgen then did three further 20s hops on top, so a phase
 * meant to last 90s could run for minutes -- opening a tab at each step, which is what the
 * user saw as "it kept opening websites".
 *
 * Module-level rather than threaded through every signature because the helpers call each
 * other several levels deep; a parameter would have to be passed through functions that have
 * no other use for it, and any one omission silently restores the unbounded behaviour.
 */
let mirrorPhaseDeadline = 0;

function setMirrorPhaseDeadline(at) {
  mirrorPhaseDeadline = typeof at === 'number' && at > 0 ? at : 0;
}

/** The soonest of a local budget and the phase ceiling. */
function boundedDeadline(localBudgetMs) {
  const local = Date.now() + localBudgetMs;
  return mirrorPhaseDeadline > 0 ? Math.min(local, mirrorPhaseDeadline) : local;
}

/** True when the phase ceiling has passed, for the hops that have no budget of their own. */
function mirrorPhaseExhausted() {
  return mirrorPhaseDeadline > 0 && Date.now() > mirrorPhaseDeadline;
}

async function firstReachable(hosts, pathFor) {
  let lastError = null;
  const deadline = boundedDeadline(SOURCE_BUDGET_MS_MIRROR);
  for (const host of hosts) {
    // Stop walking once the budget is gone: 14 hosts at 12s each is minutes, and the
    // remaining ones are no more likely to answer than the ones that just did not.
    if (Date.now() > deadline) {
      lastMirrorError = `${lastError || 'no mirror answered'} (budget exhausted)`;
      return null;
    }
    if (urlTier(`https://${host}/`) !== TIER.ANONYMOUS) continue;
    const body = await getTextMirror(`https://${host}${pathFor(host)}`, PROBE_TIMEOUT_MS_MIRROR);
    if (body !== null) return { host, body };
  }
  if (lastError) lastMirrorError = lastError;
  return null;
}

/** Absolute https url from an href that may be relative, protocol-relative or absolute. */
function absolutize(href, pageUrl) {
  if (typeof href !== 'string' || !href) return null;
  let abs = href;
  if (abs.startsWith('//')) abs = `https:${abs}`;
  try {
    abs = new URL(abs, pageUrl).toString();
  } catch {
    return null;
  }
  return /^https:\/\//i.test(abs) ? abs : null;
}

/** Every href in a page. Regex rather than DOM: a service worker has no DOMParser. */
function hrefsIn(html) {
  return (html.match(/href\s*=\s*["']([^"']{4,300})["']/g) || [])
    .map((m) => m.replace(/^href\s*=\s*["']/, '').replace(/["']$/, ''));
}

// --- Sci-Hub --------------------------------------------------------------------------

export async function scihubMirrors() {
  let hosts = SCIHUB_FALLBACK;
  const body = await getTextMirror(`${SCIHUB_LIST_URL}?v=${Date.now()}`, PROBE_TIMEOUT_MS_MIRROR);
  if (body) {
    const parsed = body.split(/[\r\n]+/)
      .map((line) => line.replace(/^\uFEFF/, '').trim().replace(/\/+$/, ''))
      .filter((h) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h));
    if (parsed.length > 0) hosts = parsed;
  }
  // The intersection is the security boundary, not the list.
  return hosts.filter((h) => urlTier(`https://${h}/`) === TIER.ANONYMOUS);
}

export function scihubArticleUrl(host, doi) {
  return `https://${host}/${doi}`;
}

/**
 * Is this the "paper is not yet available in my database" page?
 *
 * Sci-Hub serves it as HTTP 200 with a similar-articles list and a link to the Sci-Net
 * request platform, so the status code says nothing. It is the ONE answer that lets the
 * probe skip a host WITHOUT opening a tab: no download link will ever render on this page,
 * whatever its JS does.
 *
 * The inverse test would be a bug. The mere ABSENCE of a pdf link in the static html proves
 * nothing -- the real link is often written by the page's own script or carried on a `src`
 * rather than an `href`, which is the entire reason a tab is used here at all. Skipping on
 * absence would silently lose papers Sci-Hub actually has, a worse outcome than the stray
 * tab this probe exists to avoid.
 *
 * Markers ported from src/publishers/scihub-retrieval.js, where they serve the same purpose.
 * Pure; never throws.
 */
export function isScihubUnavailableHtml(html) {
  if (typeof html !== 'string' || !html) return false;
  const h = html.toLowerCase();
  return (
    h.includes('not yet available in my database')
    || h.includes('sci-net.xyz')
    || ((h.includes('what can i do') && h.includes('similar')) && !h.includes('class="download"'))
  );
}

/**
 * Pick the PDF out of a Sci-Hub page's links. The href comes from an untrusted page, so the
 * caller MUST still put it through the tier resolver -- this chooses, it does not grant.
 */
export function pickScihubPdf(hrefs, pageUrl) {
  if (!Array.isArray(hrefs)) return null;
  for (const raw of hrefs) {
    const abs = absolutize(raw, pageUrl);
    if (!abs) continue;
    let path;
    try { path = new URL(abs).pathname; } catch { continue; }
    if (/\.pdf$/i.test(path) || /\/downloads?\//i.test(path)) return abs;
  }
  return null;
}

// --- LibGen ---------------------------------------------------------------------------

/**
 * LibGen, walked to a direct file url.
 *
 * Four hops, all confirmed live 2026-07-28 for 10.1016/j.jfineco.2019.05.005:
 *
 *   index.php?req=<doi>   -> edition.php?id=82046471
 *   edition.php?id=...    -> /ads.php?md5=<md5>&downloadname=...
 *   ads.php?md5=...       -> get.php?md5=<md5>&key=<key>
 *   get.php?...           -> the bytes
 *
 * The KEY on the last hop is per-session and is why the chain cannot be shortcut: a
 * constructed get.php url without it returns a 47-byte redirect stub, which is what a
 * naive "just build the url" implementation would have downloaded and stored.
 */
export async function libgenPdfUrl(doi) {
  if (!doi) return null;
  // A mirror that is merely rate-limiting right now returns nothing and the next is tried.
  // Observed live: the same DOI resolved, then returned null after repeated probing, then
  // resolved again three times in a row. That is the "skip only if unavailable AT THE TIME"
  // case, and it is why availability is never cached across runs.
  const search = await firstReachable(
    LIBGEN_MIRRORS,
    () => `/index.php?req=${encodeURIComponent(doi)}`,
  );
  if (!search) return null;
  const base = `https://${search.host}`;

  const edition = /edition\.php\?id=(\d+)/.exec(search.body);
  if (!edition) return null;

  // Each remaining hop is checked against the phase ceiling. These three run AFTER
  // firstReachable has already spent its own budget, and none of them used to be bounded at
  // all, so the chain could add another minute to a phase that was already over.
  if (mirrorPhaseExhausted()) return null;
  const editionBody = await getTextMirror(`${base}/edition.php?id=${edition[1]}`);
  if (!editionBody) return null;

  const ads = hrefsIn(editionBody).find((h) => /ads\.php\?md5=/i.test(h));
  if (!ads) return null;

  if (mirrorPhaseExhausted()) return null;
  const adsBody = await getTextMirror(absolutize(ads, base) || `${base}/${ads.replace(/^\/+/, '')}`);
  if (!adsBody) return null;

  // get.php CARRYING A KEY. setlang.php also matches a looser "download" pattern and is not
  // the file -- picking it returns the stub described above.
  const get = hrefsIn(adsBody).find((h) => /get\.php\?/i.test(h) && /key=/i.test(h));
  return get ? absolutize(get, base) : null;
}

// --- Anna's Archive --------------------------------------------------------------------

/**
 * Anna's Archive scidb page for a DOI.
 *
 * Returns the PAGE url rather than a file url: measured 2026-07-28, the scidb page carries
 * no download href in its server-rendered HTML (the viewer is built client-side), so there
 * is nothing to parse from a plain fetch. The extension resolves it the same way it handles
 * Mendeley and OUP -- open the page in a tab, let it hydrate, read the links out of the live
 * DOM -- which is a capability the bridge already has and a plain HTTP client does not.
 */
export async function annasArticleUrl(doi) {
  if (!doi) return null;
  // The DOI's slash stays LITERAL. encodeURIComponent would send 10.1016%2Fj..., which
  // Anna's happens to accept (measured: both forms return the same 108,784-byte page) but
  // which is not the form the site links to itself, and a mirror that is stricter about it
  // would fail for a reason nothing here would explain. Only the characters that genuinely
  // need escaping are escaped.
  const path = `/scidb/${doi.split('/').map(encodeURIComponent).join('/')}`;
  const hit = await firstReachable(ANNAS_MIRRORS, () => path);
  return hit ? `https://${hit.host}${path}` : null;
}

// --- availability probe -----------------------------------------------------------------

/**
 * Does this mirror have the paper? Answered WITHOUT opening a tab.
 *
 * Three-valued on purpose: 'present' | 'absent' | 'unknown'. Only a definitive negative is
 * 'absent' -- for sci-hub, the "not yet available in my database" page, which is
 * conclusive because no link will ever render there whatever its JS does. A host that is
 * down, rate-limiting or slow is 'unknown', and the caller must never treat that as a
 * reason to skip the source.
 *
 * Anna's and libgen can therefore NEVER answer 'absent': their resolvers return null both
 * for "this paper is not here" and for "no mirror answered", and those are not the same
 * claim. Collapsing them would let one rate-limited host be reported as the paper not
 * existing, so the ambiguous null is reported as the ambiguity it is.
 *
 * Sci-hub's host list rotates and comes off the network, so this walks hosts and takes the
 * FIRST that answers rather than probing all of them -- otherwise one mirror serialises
 * the whole parallel probe behind five 12-second timeouts.
 */
export async function probeMirror(name, doi) {
  if (!doi) return 'unknown';
  try {
    if (name === 'scihub') {
      for (const host of await scihubMirrors()) {
        const body = await getTextMirror(scihubArticleUrl(host, doi), PROBE_TIMEOUT_MS_MIRROR);
        if (body === null) continue;               // host down: ask the next one
        return isScihubUnavailableHtml(body) ? 'absent' : 'present';
      }
      return 'unknown';                            // nothing answered
    }
    if (name === 'annas') return (await annasArticleUrl(doi)) ? 'present' : 'unknown';
    if (name === 'libgen') return (await libgenPdfUrl(doi)) ? 'present' : 'unknown';
  } catch {
    return 'unknown';
  }
  return 'unknown';
}

/** Pick the file link out of a hydrated Anna's scidb page. */
export function pickAnnasPdf(hrefs, pageUrl) {
  if (!Array.isArray(hrefs)) return null;
  for (const raw of hrefs) {
    const abs = absolutize(raw, pageUrl);
    if (!abs) continue;
    let path;
    try { path = new URL(abs).pathname; } catch { continue; }
    // Anna's serves files from /scidb/dl/, and IPFS gateways from /ipfs/.
    if (/\.pdf$/i.test(path) || /\/scidb\/dl\//i.test(path) || /\/ipfs\//i.test(path)) return abs;
  }
  return null;
}
