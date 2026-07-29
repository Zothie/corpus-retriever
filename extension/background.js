// Fetches PDFs from allowlisted publishers using this browser's real session.
//
// This exists because Cloudflare's managed challenge on papers.ssrn.com cannot be
// satisfied from outside the browser: cf_clearance is bound to the TLS fingerprint,
// UA and IP that earned it, and headless Chrome is detected regardless. Only an
// in-browser fetch presents the right everything at once.

const NATIVE_HOST = 'com.repository.corpus_retriever';
const MAX_PDF_BYTES = 80 * 1024 * 1024;

// Bounds for fetch_links. That capability reads hrefs out of a page the user's
// cookies opened, so it is deliberately small: at most MAX_LINKS hrefs come back,
// none longer than MAX_LINK_CHARS, and the in-page collector stops after
// MAX_RAW_LINKS anchors so a page carrying a hundred thousand of them cannot make
// the worker allocate without bound. 50 * 2048 is ~100 kB, two orders of magnitude
// under the 1 MiB host-to-extension native-message cap, so no chunking is needed.
const MAX_LINKS = 50;
const MAX_LINK_CHARS = 2048;
const MAX_RAW_LINKS = 2000;

// Once a real challenge is showing the extension waits on the user rather than abandoning
// the download mid-solve, but that wait is a BUDGET (HUMAN_SOLVE_BUDGET_MS below), never
// unbounded: a wait that cannot end means the cleanup that closes the tab never runs, which
// is how tabs leaked into the user's session. A solved challenge mints the clearance cookie
// so later requests are fast and silent.
const CHALLENGE_POLL_MS = 750;
// How long to let a challenge resolve itself in a background tab before deciding whether a
// human is needed. Most fetches clear inside this window with nobody ever seeing the tab.
const AUTO_CLEAR_MS = 8000;
// How long to let a page finish rendering its own content before giving up on it. Unlike a
// challenge, nobody is waiting on a human here, so this is finite.
const HYDRATION_TIMEOUT_MS = 45000;
// The single budget for a wait a HUMAN may be sitting in front of. Tracks the client/host
// budgets, which are an hour precisely so a captcha can be solved by hand; at 100s the cap
// used to end a solve while it was still in progress.
//
// It is a BUDGET, never Infinity. An unbounded wait is what leaked tabs: withClearedTab
// closes its tabs in a finally, and a wait that never resolves means the finally never runs.
const HUMAN_SOLVE_BUDGET_MS = 3600000;
// How long a page may sit uncleared with NO challenge marker matched before it is surfaced
// anyway. Marker detection is best-effort, so this is what makes focus predictable rather
// than dependent on whether a given publisher's widget happens to be recognised.
const UNCLEARED_SURFACE_MS = 20000;
// How long chrome.scripting must keep refusing a tab that the browser already reports as
// fully loaded before the tab is treated as holding a non-scriptable document (Chrome's
// built-in PDF viewer) rather than as mid-navigation.
const DOCUMENT_CONFIRM_MS = 5000;
// How long after the extension asks for a url a NEW tab showing that url still counts as
// caused by us. A handoff Chrome performs in response to our navigation lands within a
// second or two; anything later is the user, and the whole call may now last an hour.
const REQUEST_MATCH_MS = 15000;
// How long after OUR navigation a new tab with no opener still counts as caused by us.
// Tight on purpose: this is the only thing separating a rel=noopener handoff from a tab the
// user opened by hand, and closing the user's tab is far worse than leaking one of ours.
const HANDOFF_WINDOW_MS = 1500;
// Hard cap on a single PDF fetch, in the page and in the worker alike. A response whose body
// never finishes arriving hangs body(), which means withClearedTab's cleanup never runs and
// the tab leaks -- the same failure shape as the unbounded challenge wait, reached a
// different way. Generous enough for an 80 MB PDF on a slow link; no human is waiting on
// this, so it does not need the solve budget.
const FETCH_TIMEOUT_MS = 180000;

// Chrome caps a single native message at 64 MiB extension -> host (and 1 MiB
// host -> extension). Base64 inflates a PDF by 4/3, so an 80 MB PDF becomes
// ~107 MB of payload and would exceed the cap on its own. The result is
// therefore streamed as a header message followed by fixed-size chunks; the
// host reassembles them in seq order. 256 KiB keeps every frame two orders of
// magnitude below both caps, so the same framing also works if a future
// revision ever needs the host to echo data back.
const CHUNK_CHARS = 256 * 1024;

// Reconnect backoff. The native host is legitimately absent until it is
// installed, so a fixed 1s retry would spin forever inside a service worker.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;
// A service worker is torn down after roughly 30s idle and its pending timers
// die with it, so setTimeout can only carry the short retries. Anything longer
// has to be an alarm, which survives teardown and wakes the worker back up.
// chrome.alarms clamps below 30s, so that is also the handover point.
const ALARM_MIN_MS = 30 * 1000;
// Scholar's own ceiling. A search fans out to five sources and returns as one response, so
// any single source that can block indefinitely blocks all of them.
const SCHOLAR_TIMEOUT_MS = 30 * 1000;
// Whole-phase ceiling for mirrors. Measured: walking every host at the per-probe timeouts
// put this phase past 170s. Mirrors are the last resort for a paper nothing else had, so
// giving up on them is a worse outcome than waiting -- but not by minutes.
const MIRROR_PHASE_BUDGET_MS = 90 * 1000;
// Room a single mirror host needs to be worth starting. Below this the tab would be opened
// only to be abandoned mid-hydration, which costs the user a visible window and returns
// nothing.
const MIRROR_HOST_MIN_MS = 15 * 1000;
const RECONNECT_ALARM = 'corpus-retriever-reconnect';
// Fires while the bridge is HEALTHY, so an evicted worker is revived. See connect().
const HEARTBEAT_ALARM = 'corpus-retriever-heartbeat';

// Must stay in sync with src/bridge/allowed-hosts.js. The socket is the trust
// boundary, so re-check here: a compromised local process must not be able to
// point this fetch at an arbitrary host.
//
// The block between the parity markers is byte-identical to the same block in
// src/bridge/allowed-hosts.js apart from that file's `export ` keywords.
// tests/allowed-hosts.test.mjs extracts this block, evaluates it standalone and
// runs the same adversarial vector table through both copies, so drift is a test
// failure rather than a silent security hole. Edit both or neither.
//
// The rationale for the two grant shapes -- and for why DigitalCommons is an
// explicit host list instead of an open .edu pattern -- is in the header comment
// of src/bridge/allowed-hosts.js. Do not restate it here; it would drift.

// Inlined rather than imported. An ES-module import of ./allowlist.js failed to
// register in Chrome ("does not provide an export named isAllowedNavigationUrl")
// even though the export is present and Node resolves every name -- so the worker
// was dead and the bridge socket never appeared. The import bought nothing here:
// background.js is the only consumer that must never fail to load. search-sources.js
// still imports allowlist.js, which is a module by nature and not the worker entry.
// tests/allowed-hosts.test.mjs enforces that this copy stays byte-identical.
// ---8<--- allowlist parity region ---8<---
const ALLOWED_HOSTS = [
  'ssrn.com',
  // Elsevier platforms fetched through the bridge. Each is a publisher-owned
  // domain whose whole subdomain tree serves that publisher, so a suffix match
  // is the right granularity and a path constraint would only be theatre.
  'cell.com',
  'data.mendeley.com',
  'sciencedirect.com',
  // Springer Nature, not Elsevier. Included because unlike ScienceDirect it hosts its
  // OWN open-access PDFs: in a 7-paper sample, 6 had no working pdf route outside
  // nature.com, so the bridge is the only way to reach them.
  'nature.com',
  // Publishers outside Elsevier and Springer Nature, all added for the same measured
  // reason: each answers a plain client with a wall (Cloudflare 403 for the three below,
  // an F5 "Client Challenge" for link.springer.com) AND hosts its own free PDFs with no
  // copy anywhere the captcha-free sources can reach. Measured 2026-07-26 over 40-DOI
  // samples per prefix; the per-publisher numbers are in each *-retrieval.js header.
  'link.springer.com',
  'onlinelibrary.wiley.com',
  'pubs.acs.org',
  'academic.oup.com',
  // elsevier.com is deliberately absent: linkinghub.elsevier.com is only ever a
  // redirect hop while resolving a DOI to a PII, and our own plain HTTP client
  // does that server-side. It never goes through the bridge, so it needs no
  // credentialed-fetch grant.
];

// DigitalCommons/bepress instances on third-party university domains. Exact host,
// bepress paths only. See the header comment for why this is not an open .edu rule.
// Every host below was verified live on 2026-07-26 by fetching https://<host>/ and
// confirming the bepress markers in the response ("bepress", "Digital Commons",
// "yui3-seed"). Three entries are the canonical targets of a redirect from an older
// name, and the old name is deliberately NOT listed because it only ever 301s here:
// repository.lsu.edu (was digitalcommons.lsu.edu), digitalcommons.lib.uconn.edu (was
// digitalcommons.uconn.edu) and oasis.library.unlv.edu (was digitalscholarship.unlv.edu).
// Coverage is knowingly partial -- see the header. Add a host only after checking it
// actually serves bepress; a guessed hostname is a grant handed to whoever registers it.
const PATH_CONSTRAINED_HOSTS = [
  { host: 'aquila.usm.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.calpoly.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.chapman.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.du.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.georgiasouthern.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.kennesaw.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.law.uw.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.lib.uconn.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.odu.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.pepperdine.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.unf.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.unl.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.unomaha.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.uri.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.usf.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.usu.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.wayne.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'docs.lib.purdue.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'ecommons.udayton.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'egrove.olemiss.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'engagedscholarship.csuohio.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'epublications.marquette.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'ideaexchange.uakron.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'ir.lib.uwo.ca', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'nsuworks.nova.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'oasis.library.unlv.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'openscholarship.wustl.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'opensiuc.lib.siu.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'repository.lsu.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'researchrepository.wvu.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'scholar.smu.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'scholarcommons.sc.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'scholarship.richmond.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'scholarsarchive.byu.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'scholarworks.uni.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'stars.library.ucf.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'surface.syr.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'thekeep.eiu.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'uknowledge.uky.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'via.library.depaul.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
];

// Percent-encoded path separators and dot segments. URL normalises a literal
// "../" but leaves "%2e%2e%2f" encoded, so under a PREFIX rule a path like
// "/context/..%2f..%2fwp-admin" would satisfy the prefix test here while an
// origin that decodes encoded slashes (Apache AllowEncodedSlashes On, and
// several app servers by default) resolves it to "/wp-admin". Whether that
// escape lands depends on the far end, which we cannot see, so refuse the
// encoding rather than reason about somebody else's server config.
const ENCODED_PATH_SEPARATOR = /%(2f|5c|2e)/i;

// Hosts we fetch WITHOUT the user's cookies.
//
// Mirrors, open-access APIs and search APIs. The user has no account on any of them, so
// sending credentials is a liability rather than a capability: it would attach whatever
// session Chrome happens to hold to a request that gains nothing from it.
//
// Kept SEPARATE from ALLOWED_HOSTS rather than merged with a flag, because the two lists
// answer different questions. ALLOWED_HOSTS is "may this be fetched AS THE USER", which is
// the dangerous grant and stays as narrow as it was. This list is "may this be fetched at
// all", which is a much weaker permission -- an anonymous fetch of a public API is close to
// what any web page can already do.
//
// Sci-Hub is here, but its tier is honest rather than absolute: clearing its captcha
// requires a real tab, and a tab is a full credentialed session no fetch option can strip.
// What the anonymous tier buys is that the BYTES are fetched without ambient authority and
// no publisher cookie is ever sent to a mirror.
const ANONYMOUS_HOSTS = [
  // Sci-Hub. The mirror set rotates, so the live list is polled from a CSV at runtime and
  // every entry is checked against this list before use -- a rotating list is not a licence
  // to fetch a host nobody vetted.
  'sci-hub.ru',
  'sci-hub.st',
  'sci-hub.su',
  'sci-hub.red',
  'sci-hub.box',
  // Where the live mirror list is published. Granted only so the list can be READ; every
  // host it names is then intersected with the entries above, so this cannot widen the
  // grant -- a spoofed list can only remove mirrors, never add one. Found by reading the
  // "Open in Sci-Hub" extension, which polls it rather than hardcoding domains that rotate.
  'cdn.lowyiyiu.com',
  // Mirrors.
  // The LIVE domains, not the historical ones. Measured 2026-07-28: libgen.is/.rs/.st and
  // annas-archive.org/.se are dead (DNS gaierror or TCP timeout) while every host below
  // answered 200. Probing the dead ones first produced a wrong conclusion -- that both
  // mirror networks were blocked from this machine -- so the live set is recorded here
  // explicitly and availability is decided per run rather than assumed.
  'libgen.bz',
  'libgen.li',
  'libgen.la',
  'libgen.vg',
  'libgen.gl',
  'annas-archive.gd',
  'annas-archive.pk',
  'annas-archive.gl',
  'annas-archive.li',
  // Open-access PUBLISHERS whose PDFs the OA resolvers hand back directly. These are not
  // walled and need no session -- they are here so an OA candidate is fetchable at all.
  //
  // This list is knowingly incomplete and always will be: Unpaywall and OpenAlex can return
  // a pdf on ANY repository or publisher that deposited one, and enumerating every OA host
  // on the internet is not possible. The consequence is honest -- an OA pdf on an unlisted
  // host is refused and the paper falls through to another source -- and the alternative
  // (trusting whatever host an API names) would let a compromised or spoofed API response
  // point a fetch anywhere. Measured 2026-07-28: journals.plos.org was refused this way,
  // which is what prompted adding these rather than relaxing the rule.
  'journals.plos.org',
  'plos.org',
  'www.frontiersin.org',
  'frontiersin.org',
  'www.mdpi.com',
  'mdpi.com',
  'peerj.com',
  'elifesciences.org',
  'zenodo.org',
  'osf.io',
  // Open-access APIs and their download hosts.
  'api.unpaywall.org',
  'api.openalex.org',
  'api.core.ac.uk',
  'core.ac.uk',
  'www.ebi.ac.uk',
  'europepmc.org',
  'pmc.ncbi.nlm.nih.gov',
  'ftp.ncbi.nlm.nih.gov',
  'eutils.ncbi.nlm.nih.gov',
  'api.crossref.org',
  // PMCID lookup lives on the main NCBI host, not on eutils.
  'www.ncbi.nlm.nih.gov',
  'doi.org',
  'dx.doi.org',
  // Search APIs. api.ssrn.com is a plain CORS API and is NOT the Cloudflare-challenged
  // papers.ssrn.com: measured 2026-07-28, a service-worker fetch returns 200 with results,
  // which is what removed the Python/curl_cffi dependency.
  'api.ssrn.com',
  'export.arxiv.org',
  'arxiv.org',
  'api.biorxiv.org',
  // Google Scholar. Reached with a TAB rather than a fetch -- it has no API, blocks
  // datacenter traffic, and serves consent/captcha interstitials, which is exactly the
  // case this extension exists for: from the user's own logged-in browser on a residential
  // IP it is an ordinary page. A headless fetcher needs Puppeteer for it; this does not.
  'scholar.google.com',
  // The preprint PDFs themselves, which is where searchBiorxiv's pdfUrl points. Granted
  // separately from api.biorxiv.org because they are different hosts and the API host
  // serves no files.
  'biorxiv.org',
  'medrxiv.org',
];

/** The two grants a URL can fall under, plus "no grant at all". */
const TIER = {
  CREDENTIALED: 'credentialed',
  ANONYMOUS: 'anonymous',
  NONE: null,
};

/**
 * Which tier a URL falls under. THE ONLY place a credential decision is made.
 *
 * Returning a tier rather than a boolean is the point. The previous shape let each call
 * site pass its own `credentials`, defaulting to 'include' -- fail-open, so one missed
 * argument anywhere would have been a silent credentialed fetch to a mirror. Deriving the
 * tier from the URL inside the fetch primitive means a caller CANNOT choose, and adding a
 * host to the wrong list is the only way to get it wrong.
 *
 * Checked credentialed-first so a host on both lists gets the stronger grant, and so the
 * anonymous list can never quietly downgrade a publisher.
 */
function urlTier(url) {
  if (typeof url !== 'string') return TIER.NONE;
  // An EXACT entry in the anonymous list beats the credentialed SUFFIX grant.
  //
  // api.ssrn.com is the case this exists for. ALLOWED_HOSTS grants 'ssrn.com' by suffix,
  // which would otherwise swallow api.ssrn.com and send the user's SSRN session to a
  // search API that neither needs nor should receive it. papers.ssrn.com is unaffected --
  // it is not an exact entry here, so it keeps the credentialed grant it has always had.
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (ANONYMOUS_HOSTS.includes(host)) {
      // Still has to clear the structural checks below.
      return anonymousTierFor(url);
    }
  } catch {
    return TIER.NONE;
  }
  if (isAllowedUrl(url)) return TIER.CREDENTIALED;
  return anonymousTierFor(url);
}

/**
 * ANONYMOUS or NONE, applying every structural check isAllowedUrl makes.
 *
 * An anonymous fetch still leaves the user's browser from the user's IP, so "no cookies"
 * is not a reason to relax the host parsing. Split out so the exact-match branch above and
 * the suffix branch here cannot drift into two different notions of a valid host.
 */
function anonymousTierFor(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return TIER.NONE;
  }
  if (u.protocol !== 'https:') return TIER.NONE;
  if (u.username || u.password) return TIER.NONE;
  if (u.port !== '') return TIER.NONE;
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) return TIER.NONE;
  return ANONYMOUS_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
    ? TIER.ANONYMOUS
    : TIER.NONE;
}

/** The fetch credentials a URL's tier permits, or null when it may not be fetched. */
function credentialsFor(url) {
  const tier = urlTier(url);
  if (tier === TIER.CREDENTIALED) return 'include';
  if (tier === TIER.ANONYMOUS) return 'omit';
  return null;
}

/** True when url is https and its host and path are covered by one of the two grants. */
function isAllowedUrl(url) {
  // Only accept a real string. Coercing via String() would let an array, a URL
  // object or anything with a friendly toString() through the gate, and the
  // caller would then hand the un-coerced value to the fetch layer.
  if (typeof url !== 'string') return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  // Reject embedded credentials: https://papers.ssrn.com@evil.com/ has host evil.com,
  // but the userinfo makes it easy to misread. Refuse outright.
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  // Fail closed on anything that is not a plain sequence of non-empty labels.
  // This drops the trailing-dot FQDN form ("ssrn.com."), leading/doubled dots
  // (".ssrn.com" would otherwise satisfy the endsWith test) and IPv6 literals,
  // which URL exposes bracketed as "[::1]".
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) return false;
  // Pin the port. The grants name hosts, not services; without this a caller
  // could aim a credentialed fetch at any port on a granted host.
  if (u.port !== '') return false;
  if (ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  // Path-constrained grant. u.pathname is already dot-segment normalised by URL,
  // so "/a/../cgi/viewcontent.cgi" simply IS "/cgi/viewcontent.cgi" and matching
  // it is correct rather than a bypass. Percent-encoding is NOT normalised,
  // which is the case ENCODED_PATH_SEPARATOR handles.
  const rule = PATH_CONSTRAINED_HOSTS.find((r) => host === r.host);
  if (!rule) return false;
  if (ENCODED_PATH_SEPARATOR.test(u.pathname)) return false;
  return rule.paths.some((p) => (p.endsWith('/') ? u.pathname.startsWith(p) : u.pathname === p));
}
// ---8<--- end allowlist parity region ---8<---

/**
 * May a tab be opened here?
 *
 * Deliberately looser than isAllowedUrl, and only for navigation. On a bepress host the
 * challenge has to be solved on the article's landing page, whose path is arbitrary
 * (/jate/vol15/iss2/1), while the byte-returning grant is pinned to /cgi/viewcontent.cgi.
 * Opening a tab returns nothing to the caller -- pageIsCleared reads only location.origin
 * and challenge markers -- so the capability being granted here is "show the user a page
 * on a host we already trust", not "read it". Every path that returns bytes still goes
 * through isAllowedUrl.
 */
function isAllowedNavigationUrl(url) {
  if (isAllowedUrl(url)) return true;
  if (typeof url !== 'string') return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (u.port !== '') return false;
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) return false;
  return PATH_CONSTRAINED_HOSTS.some((r) => host === r.host);
}







/**
 * Fetch from the service worker instead of the page.
 *
 * The in-page fetch is what gets us past the challenge, but it obeys the PAGE's CORS
 * rules, and SSRN's Delivery.cfm 302s to download.ssrn.com -- a different origin. The
 * page rejects that hop as an opaque "TypeError: Failed to fetch" with no status. The
 * worker is exempt from CORS for anything in host_permissions, and by the time this runs
 * the tab has already cleared the challenge and the cookies are in the jar, so the same
 * request succeeds here. Used only as the fallback for that specific failure.
 */
/**
 * The origin of a url, for a log line. Never the path or query.
 *
 * A redirected PDF url IS a credential: ScienceDirect lands on
 * pdf.sciencedirectassets.com/...?X-Amz-Signature=..., SSRN on download.ssrn.com with a
 * one-shot token. These strings travel over the socket into the desktop app's logs, and
 * "which host did we end up on" is the whole diagnostic value -- the signature is not.
 */
function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '(unparseable)';
  }
}

/**
 * Base64 a byte array, in 32 KB chunks.
 *
 * The chunking is not stylistic. `String.fromCharCode(...bytes)` spreads one argument per
 * byte, and a multi-megabyte paper -- which is most of them -- overflows the call stack and
 * throws, losing a download the user already waited a minute for.
 */
function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64ToBytes(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function workerFetch(url, maxBytes, forceAnonymous = false, timeoutMs = FETCH_TIMEOUT_MS) {
  // Credentials are DERIVED from the url, never passed in. The previous signature took a
  // `credentials` argument defaulting to 'include', so a call site that forgot it would
  // silently fetch as the user. credentialsFor() returns null for a url covered by neither
  // grant, which is refused outright rather than fetched anonymously -- an unlisted host is
  // not "safe to fetch without cookies", it is "not ours to fetch at all".
  const allowed = credentialsFor(url);
  if (allowed === null) return { ok: false, error: 'host not allowlisted' };
  // forceAnonymous only ever DOWNGRADES. It exists for publisher handoffs to object
  // storage, which answer "Access-Control-Allow-Origin: *" and so can never be paired with
  // credentials. It cannot upgrade an anonymous host to credentialed.
  const credentials = forceAnonymous ? 'omit' : allowed;
  try {
    // Bounded. An unbounded fetch that never delivers its body hangs the whole call, and the
    // tab cleanup runs only once the call returns.
    const res = await fetch(url, { credentials, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, error: `http ${res.status}` };
    // Refuse before buffering. arrayBuffer() reads the whole body into worker memory, so a
    // hostile or broken origin serving 500 MB OOM-kills the service worker mid-transfer --
    // which the desktop app cannot distinguish from Chrome being closed.
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, error: `response too large (${declared} bytes)` };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) return { ok: false, error: 'response too large' };
    if (buf.byteLength < 5) {
      const ct = res.headers.get('content-type') || '?';
      const cd = res.headers.get('content-disposition') || '';
      return {
        ok: false,
        error: `worker: response too short (${buf.byteLength} bytes, status ${res.status}, `
          + `type ${ct}${cd ? `, disposition ${cd}` : ''}, landed on ${safeOrigin(res.url)})`,
      };
    }
    const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 5));
    if (magic !== '%PDF-') return { ok: false, error: `not a pdf (starts with ${JSON.stringify(magic)})` };
    return { ok: true, base64: bytesToBase64(new Uint8Array(buf)), bytes: buf.byteLength };
  } catch (err) {
    return { ok: false, error: `worker fetch: ${err.name}: ${err.message}` };
  }
}


/**
 * Report what the tab is actually showing. Diagnostics only.
 *
 * Deliberately returns NO page text. An earlier version included the first 300 characters
 * of document.body.innerText, which is the content of a page opened with the user's
 * cookies, and it travelled into log lines and back to the caller. Title, byte count
 * and which challenge markers matched are enough to tell a challenge from a paywall from
 * a real article, without reading anything.
 */
function inPageProbe() {
  const pick = (sel) => (document.querySelector(sel) ? sel : null);
  return {
    // The full href is deliberately NOT returned. This probe travels over the socket into
    // the desktop app's logs, and a publisher url routinely carries a session token or a
    // presigned signature in its query string -- fetchPdf navigates AT exactly such urls.
    // Origin plus path answers "where did the tab end up" without carrying a credential.
    origin: location.origin,
    path: location.pathname.slice(0, 120),
    title: (document.title || '').slice(0, 120),
    readyState: document.readyState,
    contentType: document.contentType || null,
    bodyChars: (document.body && document.body.innerText || '').length,
    markers: [
      pick('#challenge-container'), pick('#captcha-container'),
      pick('#amzn-captcha-verify-button'), pick('[name="cf-turnstile-response"]'),
      pick('embed[type="application/pdf"]'), pick('iframe'),
    ].filter(Boolean),
    hasGoku: 'gokuProps' in window,
    hasWafList: 'awsWafCookieDomainList' in window,
  };
}

/**
 * Runs in the page, not here. Fetches the PDF same-origin so the request carries
 * Origin/Sec-Fetch-Site values Cloudflare accepts, then returns base64 over the
 * scripting bridge. Declared as a plain function because chrome.scripting
 * serialises it to the target frame; it must not close over anything.
 */
function inPageFetch(url, maxBytes, credentials, timeoutMs) {
  return (async () => {
    try {
      // `credentials` is decided by the CALLER via credentialsFor(), not chosen here. This
      // function is serialised into the page by chrome.scripting, so it cannot close over
      // the tier resolver and has to be told. It used to hardcode 'include', which meant an
      // in-page fetch of an anonymous-tier host would have carried cookies regardless of
      // what the tier said.
      // Bounded for the same reason as the worker copy: a body that never finishes arriving
      // would hang the call that owns the tab, and the tab is only closed once it returns.
      // The timeout is passed in because this function is serialised into the page and
      // cannot close over the constant.
      const res = await fetch(url, { credentials, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { ok: false, error: `http ${res.status}` };
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        return { ok: false, error: 'response too large' };
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength > maxBytes) return { ok: false, error: 'response too large' };
      if (buf.byteLength < 5) {
        // Report enough to tell an empty body apart from a redirect-to-download or a
        // challenge page, because all three otherwise look identical from out here.
        const ct = res.headers.get('content-type') || '?';
        const cd = res.headers.get('content-disposition') || '';
        return {
          ok: false,
          error: `response too short (${buf.byteLength} bytes, status ${res.status}, `
            + `type ${ct}${cd ? `, disposition ${cd}` : ''}, landed on ${safeOrigin(res.url)})`,
        };
      }
      const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 5));
      if (magic !== '%PDF-') return { ok: false, error: `not a pdf (starts with ${JSON.stringify(magic)})` };
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return { ok: true, base64: btoa(bin), bytes: buf.byteLength };
    } catch (err) {
      return { ok: false, error: `page: ${err.name}: ${err.message}` };
    }
  })();
}

/**
 * Runs in the page. Collects the absolute href of every anchor whose path ends
 * in .pdf, capped.
 *
 * Both halves of that description are the security design.
 *
 * The query is HARDCODED to a[href] and only URLs are returned -- never text,
 * attributes or innerHTML. A caller-supplied CSS selector would turn this into a
 * general DOM-reading primitive aimed at a tab holding the user's session, and
 * the socket is reachable by anything running locally.
 *
 * The .pdf filter is here rather than in the caller because it is also the
 * poll's termination condition, and because leaving it out makes the poll
 * useless: measured on data.mendeley.com, the PRE-hydration HTML already carries
 * a dozen same-origin navigation anchors (/, /about, /faq, ...). All of them are
 * same-origin and allowlisted, so a "stop when the list is non-empty" loop
 * returns chrome on the very first read, never waits for the file table, and
 * burns cap slots that the real file links then fall off the end of.
 *
 * The extension is the only place that can apply this filter, since it is the
 * only place that sees the DOM. The caller re-checks anyway (pickPdfLink).
 *
 * Serialised into the frame by chrome.scripting, so it closes over nothing.
 */
function inPagePdfLinks(maxRaw, maxChars) {
  const out = [];
  const anchors = document.querySelectorAll('a[href]');
  for (let i = 0; i < anchors.length && i < maxRaw; i += 1) {
    // The .href property is already resolved against the document base, so a
    // relative href comes back absolute without any string joining here.
    const href = anchors[i].href;
    if (typeof href !== 'string' || href.length === 0 || href.length > maxChars) continue;
    let u;
    try {
      u = new URL(href);
    } catch {
      continue;
    }
    // Two shapes are accepted, and neither can be recognised by extension alone:
    //
    //   .../file.pdf                      a plain PDF link
    //   .../files/<uuid>/file_downloaded  Mendeley Data, whose per-file download URLs
    //                                     carry no filename at all (measured: a dataset
    //                                     page exposes exactly this, so an extension
    //                                     test matched nothing and the source could
    //                                     never fire)
    //
    // The extension test still ignores the query string, so "archive.zip?name=paper.pdf"
    // is not mistaken for a PDF. What comes back is only a CANDIDATE: the caller fetches
    // it and the %PDF- check decides, which is what keeps a .csv or .zip in a mixed
    // dataset out of the vault.
    const isPdfPath = /\.pdf$/i.test(u.pathname);
    const isMendeleyFile = /\/public-files\/.*\/file_downloaded$/i.test(u.pathname);
    // ScienceDirect's real PDF url is /pdfft carrying a per-article md5 token that only
    // the rendered page knows -- a constructed one returns the HTML article instead, so
    // the link has to be read from the DOM like Mendeley's.
    const isScienceDirectPdf = /\/pdfft$/i.test(u.pathname);
    if (!isPdfPath && !isMendeleyFile && !isScienceDirectPdf) continue;
    out.push(href);
  }
  return out;
}

/**
 * Why the tab is not yet usable, or 'cleared' when it is.
 *
 * Returns a REASON rather than a boolean because focus depends on it. 'challenge:*' means a
 * human is definitely wanted; 'loading' and 'origin' mean the page is simply not there yet.
 * A boolean collapsed those into one state, and the surfacing rule could then only be "not
 * cleared after N ms", which surfaced tabs that were merely slow and hid tabs whose
 * challenge went unrecognised. See surfaceTab for the rule built on this.
 *
 * Runs in the page, serialised there by chrome.scripting, so it must not close over
 * anything -- every marker below is inline on purpose.
 *
 * Two challenge vendors, and they look nothing alike:
 *
 *   Cloudflare (papers.ssrn.com, cell.com) -- a "Just a moment..." style title plus a
 *   challenge form in the DOM.
 *
 *   AWS WAF (DigitalCommons/bepress) -- HTTP 202 with a ~3 kB body that has an ordinary
 *   title, readyState complete, and none of the Cloudflare markers. It defines
 *   window.gokuProps and window.awsWafCookieDomainList, renders
 *   <div id="challenge-container">, loads challenge.js from *.token.awswaf.com, then
 *   mints an aws-waf-token cookie and reloads. Without the checks below this function
 *   returns true on that interstitial, the in-page fetch pulls the challenge HTML, and
 *   the %PDF- test rejects it -- which surfaces as "closed access" rather than "still
 *   challenged", and is silent because the retry path only triggers on an HTTP 40x.
 */
function pageIsCleared(expectedOrigin) {
  // A brand new tab reports readyState 'complete' while still on about:blank, and a
  // challenge page can finish loading before its challenge actually resolves. Both look
  // ready to every check below, so the fetch would run in the wrong origin and come back
  // as an opaque "TypeError: Failed to fetch". Pin the origin before anything else.
  if (expectedOrigin && location.origin !== expectedOrigin) return 'origin';
  const t = document.title || '';
  if (/just a moment|attention required|verifying|are you a robot|enable javascript and cookies/i.test(t)) return 'challenge:cf-title';
  if (document.querySelector('#challenge-form, #cf-challenge-running, .cf-browser-verification')) return 'challenge:cf';
  // Cloudflare's INTERACTIVE variant as ScienceDirect serves it: embedded inside Elsevier's
  // own page chrome, so the title is just "ScienceDirect" and NONE of the markers around
  // this line match. Measured 2026-07-28 on a 403/1.2 MB article response: _cf_chl_opt,
  // #challenge-error-text and #captcha-box all present, every other check false. That is
  // why ScienceDirect returned null while the other nine publishers passed -- the page read
  // as cleared, the fetch pulled the interstitial HTML, and %PDF- rejected it.
  //
  // script[src*="/cdn-cgi/challenge-platform"] is deliberately NOT used even though it is
  // the obvious handle: Cloudflare injects that same path as a JS-detections beacon on
  // CLEARED pages under Bot Management, so it survives clearing. That is the
  // awsWafCookieDomainList failure exactly -- a marker that never goes away wedges the wait
  // for the whole hour budget. A missed detection costs one wasted attempt; prefer the miss.
  if ('_cf_chl_opt' in window) return 'challenge:cf-interactive';
  if (document.querySelector('#challenge-error-text, #captcha-box')) return 'challenge:cf-interactive-ui';
  // Cloudflare Turnstile. The interactive variant carries neither the classic markers nor
  // an English title -- its wrapper classes are obfuscated and the heading is localised --
  // so the only stable handles are the response input the widget injects and the script
  // that backs it. Without this the widget page reads as "cleared" and the fetch fires
  // while the user is still being asked to prove they are human.
  if (document.querySelector('[name="cf-turnstile-response"], [id^="cf-chl-widget"], .cf-turnstile')) return 'challenge:turnstile';
  if (document.querySelector('script[src*="challenges.cloudflare.com"]')) return 'challenge:turnstile-script';
  // AWS WAF. gokuProps carries the pending challenge's parameters and is set only on the
  // interstitial itself, so `in` is the right test -- it is absent once cleared.
  // awsWafCookieDomainList is deliberately NOT tested even though the same inline script
  // sets it: it survives on the page the WAF just cleared, so treating it as "challenge
  // running" left a solved bepress page looking permanently blocked and the wait never
  // ended. The challenge UI below is the reliable signal.
  if ('gokuProps' in window) return 'challenge:waf-goku';
  if (document.querySelector('#challenge-container')) return 'challenge:waf';
  // AWS WAF's INTERACTIVE captcha ("Let's confirm you are human"). It replaces the silent
  // token flow with a puzzle, and carries none of the markers above -- no gokuProps, no
  // challenge-container -- so without these the page reads as cleared and the fetch races
  // the captcha, which the origin answers with a 504.
  if (document.querySelector('#captcha-container, #amzn-captcha-verify-button, .amzn-captcha-state-container')) return 'challenge:waf-captcha';
  if (document.querySelector('script[src*="captcha.awswaf.com"], script[src*="token.awswaf.com"]')) return 'challenge:waf-captcha-script';
  // F5/Shape, which fronts link.springer.com and nature.com. Its interstitial is a
  // 3038-byte page titled "Client Challenge" whose assets live under /_fs-ch-<token>/,
  // and it carries NONE of the markers above. It normally resolves itself in a real
  // browser without a human -- which is why nature.com worked before this existed -- but
  // when it does not, the fetch used to fire against the interstitial and return its HTML,
  // which the %PDF- check rejects as an unexplained failure. Both handles are on the page
  // only while the challenge is pending, so neither can wedge a cleared page.
  if (/client challenge/i.test(t)) return 'challenge:f5';
  if (document.querySelector('link[href^="/_fs-ch-"], script[src^="/_fs-ch-"]')) return 'challenge:f5-assets';
  // 'interactive' is enough. Requiring 'complete' meant one hung subresource -- an ad or
  // an analytics beacon that never settles, which is routine on publisher pages -- left a
  // fully parsed, fully usable document reading as "challenged" until the budget expired.
  // Every challenge marker above is in the DOM by 'interactive', so nothing is lost.
  return document.readyState !== 'loading' ? 'cleared' : 'loading';
}

/**
 * Wait until the tab is cleared, surfacing it when -- and only when -- a human is needed.
 *
 * THE focus rule, in one place, for every publisher and every wait in this file:
 *
 *   1. A tab is created in the background and stays there while the page is merely loading
 *      or still clearing a challenge by itself. That is the common case and stealing focus
 *      for it would be intolerable while the user is working.
 *   2. It is surfaced as soon as a challenge marker is seen and AUTO_CLEAR_MS has passed,
 *      because a marker means a human is wanted.
 *   3. It is ALSO surfaced once UNCLEARED_SURFACE_MS have passed with the page still not
 *      cleared, whatever the reason. Marker detection is best-effort -- this is exactly the
 *      cell.com report, where a challenge was present, matched nothing, and the tab sat
 *      hidden waiting for a human who could not see it. A bounded fallback makes focus a
 *      function of "is this taking human-length time", not of "did a selector match".
 *
 * Rule 3 is what makes the behaviour CONSISTENT: every publisher that stalls gets surfaced
 * at the same 20s mark, so SSRN and cell.com now behave identically.
 *
 * The wait is always finite. `deadline` is capped by the caller at HUMAN_SOLVE_BUDGET_MS;
 * an Infinity deadline used to mean this promise could never settle, which kept
 * withClearedTab's finally from ever running and leaked the tab for the life of the browser.
 *
 * Resolves { cleared, reason, surfaced, nonScriptable }. nonScriptable is set when the
 * browser reports the tab fully loaded but executeScript keeps being refused for
 * DOCUMENT_CONFIRM_MS: that is Chrome's internal PDF viewer, which cannot be scripted and
 * would otherwise poll uselessly until the whole budget expired.
 */
function waitForTabCleared(tabId, deadline, expectedOrigin, opts = {}) {
  let pinnedOrigin = expectedOrigin || null;
  const startedAt = Date.now();
  const autoClearUntil = startedAt + (opts.autoClearMs === undefined ? AUTO_CLEAR_MS : opts.autoClearMs);
  const surfaceAt = startedAt + (opts.surfaceMs === undefined ? UNCLEARED_SURFACE_MS : opts.surfaceMs);
  return new Promise((resolve) => {
    let surfaced = false;
    let reason = 'unknown';
    let scriptingRefusedSince = null;
    const poll = async () => {
      if (Date.now() > deadline) return resolve({ cleared: false, reason, surfaced });
      let refused = false;
      try {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId },
          func: pageIsCleared,
          args: [pinnedOrigin],
        });
        // A frame that answers with nothing is not "still loading" -- executeScript resolved,
        // so there IS a frame, it just did not run our function. Count it with the refusals
        // rather than as a distinct 'unknown' state, so it terminates on the
        // DOCUMENT_CONFIRM_MS timescale instead of polling out the full hour in silence.
        if (!r || typeof r.result !== 'string') {
          refused = true;
          reason = 'no-result';
        } else {
          reason = r.result;
          if (reason === 'cleared') return resolve({ cleared: true, reason, surfaced });
          scriptingRefusedSince = null;
        }
        // The origin pin exists so a tab still on about:blank is not mistaken for the
        // loaded page. It must NOT outlive a handoff the ORIGIN chose: ScienceDirect's
        // target=_blank PDF hop and the OUP/ACS watermark host land on a different origin,
        // and against a fixed pin this function could then never return cleared -- a
        // permanent false "challenged" that burned the whole budget.
        //
        // Re-pin only to a url that still passes the tier gate, so an arbitrary redirect
        // cannot make the extension adopt a host it was never granted.
        if (reason === 'origin') {
          try {
            const t = await chrome.tabs.get(tabId);
            if (t && typeof t.url === 'string' && urlTier(t.url) !== TIER.NONE) {
              const o = new URL(t.url).origin;
              if (o !== pinnedOrigin) pinnedOrigin = o;
            }
          } catch { /* tab gone; the deadline and the caller's cleanup cover it */ }
        }
      } catch {
        // Tab navigating, mid-challenge, or holding a document no extension may script.
        refused = true;
        reason = 'unscriptable';
      }
      if (refused) {
        if (scriptingRefusedSince === null) scriptingRefusedSince = Date.now();
        if (Date.now() - scriptingRefusedSince > DOCUMENT_CONFIRM_MS) {
          // Distinguish "still navigating" from "loaded but unscriptable". Only the second
          // is terminal, and only the browser can tell us which it is.
          let loaded = false;
          try {
            const t = await chrome.tabs.get(tabId);
            loaded = !!t && t.status === 'complete';
          } catch {
            // Tab is gone. Nothing left to wait for, and the caller's cleanup handles it.
            return resolve({ cleared: false, reason: 'tab-gone', surfaced });
          }
          if (loaded) return resolve({ cleared: false, reason: 'unscriptable', surfaced, nonScriptable: true });
        }
      }
      const now = Date.now();
      const wantsHuman = typeof reason === 'string' && reason.startsWith('challenge:');
      if (!surfaced && ((wantsHuman && now > autoClearUntil) || now > surfaceAt)) {
        surfaced = true;
        try { await chrome.tabs.update(tabId, { active: true }); } catch { /* tab gone */ }
      }
      setTimeout(poll, CHALLENGE_POLL_MS);
    };
    poll();
  });
}

/**
 * Opens a background tab on `landing`, waits for any bot-check challenge to clear
 * -- surfacing the tab for a human under the rule documented on waitForTabCleared -- and
 * then runs `body(tabId, deadline, expectedOrigin, requestUrl)` inside that cleared session.
 * `requestUrl` lets the body declare a url it is about to navigate at, which is half of the
 * tab-provenance rule below.
 *
 * A service-worker fetch cannot do the work directly: its origin is
 * chrome-extension://, so the request goes out cross-site and Cloudflare 403s it
 * even with a valid cf_clearance cookie. Measured against papers.ssrn.com, both the
 * Delivery.cfm endpoint and the plain abstract page. Running in the page makes the
 * request same-origin and indistinguishable from the user clicking Download.
 *
 * Both capabilities share this because they need identical challenge handling; a
 * second copy would inevitably diverge and the divergence would be a silent hole.
 */

/**
 * Wait for a tab to stop loading.
 *
 * pageIsCleared cannot be used here: navigating at a PDF gives the tab a document that
 * never reports readyState 'complete' the way an HTML page does, and executeScript may
 * not run in it at all. chrome.tabs.get reports the browser's own view of the load.
 */
function waitForTabSettled(tabId, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = async () => {
      if (Date.now() > deadline) return resolve(false);
      try {
        const t = await chrome.tabs.get(tabId);
        if (t && t.status === 'complete') return resolve(true);
      } catch {
        return resolve(false);
      }
      setTimeout(poll, 300);
    };
    setTimeout(poll, 300);
  });
}

// Every tab id any in-flight withClearedTab call currently owns.
//
// Adoption by url is what lets a handoff tab be found when Chrome gives it no openerTabId,
// but the same rule let two CONCURRENT calls for the same url adopt each other's tabs --
// measured: call A closed call B's live tab mid-fetch, and removed one tab twice. Sources
// race in save_to_vault and the message handler does not serialise, so two calls for one
// url is ordinary rather than exotic. A tab another call is using is as off-limits as one
// the user opened.
const tabsOwnedByAnyCall = new Set();

async function withClearedTab(landing, body, budgetMs = HUMAN_SOLVE_BUDGET_MS) {
  let tabId = null;
  // Every tab this call is responsible for: the one created below, plus anything that tab
  // opens. A publisher handoff can arrive as a new tab rather than a navigation --
  // ScienceDirect's "View PDF" anchor is target="_blank", and the OUP/ACS watermark host is
  // reached the same way -- and such a tab is outside tabId, so nothing used to close it.
  //
  // Two provenance rules, and NOTHING else may ever be added. Both answer "did this call
  // cause this tab to exist", which is the only question that keeps the user's own tabs
  // safe. A url-pattern rule (close anything on pdf.sciencedirectassets.com) would be
  // easier and is deliberately rejected: it would close the tab the user opened on the same
  // publisher while a fetch happened to be running.
  //
  //   1. openerTabId chains back to a tab already owned.
  //   2. The tab's url is one this call itself asked for, and it appeared while the call
  //      was running. Rule 1 alone missed the reported ScienceDirect leak: Chrome does not
  //      set openerTabId for a rel="noopener" link or for a handoff Chrome opens in a NEW
  //      WINDOW, so the adoption never fired. Recording the urls we requested closes that
  //      without widening the rule to urls we never asked for.
  //
  // The LANDING url is deliberately NOT registered under rule 2. We own the tab we created
  // for it by construction, so url-matching buys nothing there -- and a landing url is an
  // ordinary article page the user may plausibly have open themselves, which rule 2 would
  // then close. Only navigation TARGETS are registered: the PDF url and the presigned
  // object-storage url the origin redirects to, neither of which a user arrives at by hand.
  const owned = new Set();
  // url -> when we asked for it. A TIMESTAMP, not just membership: the call can now last an
  // hour while a human solves a captcha, and a bare set would make a url adoptable for that
  // whole hour -- long enough that the user could plausibly open the same PDF themselves and
  // have it closed under them. A handoff Chrome performs in response to our navigation
  // appears within seconds, so the match is only honoured inside REQUEST_MATCH_MS.
  const requested = new Map();
  // When this call last asked Chrome to go somewhere. A handoff lands within milliseconds
  // of that; anything later is the user.
  let lastNavigationAt = 0;
  const requestUrl = (u) => {
    if (typeof u === 'string' && u) {
      requested.set(u, Date.now());
      lastNavigationAt = Date.now();
    }
  };
  const wasRequestedRecently = (u) => {
    if (typeof u !== 'string' || !u) return false;
    const at = requested.get(u);
    return at !== undefined && Date.now() - at < REQUEST_MATCH_MS;
  };
  // Every tab id that came into existence WHILE this call ran. The final sweep is limited to
  // these, so a tab that predates the call can never be adopted no matter what url it is
  // showing -- that is what keeps the sweep from being a url-pattern rule in disguise.
  const seen = new Set();
  const adopt = (tab) => {
    if (!tab || typeof tab.id !== 'number') return;
    if (tabsOwnedByAnyCall.has(tab.id)) return;
    if (typeof tab.openerTabId === 'number' && owned.has(tab.openerTabId)) {
      owned.add(tab.id);
      return;
    }
    // URL adoption requires an OPENER, even though this fires only for new tabs.
    //
    // Measured: with a bare url match, a tab the USER opened by hand on the same paper
    // while a download was running got adopted and closed in the finally. A handoff Chrome
    // performs for us always carries an openerTabId -- what it does not always carry is a
    // useful one at onCreated time, which is why the url check exists at all. Requiring the
    // opener to be present, even if not yet ours, is what separates "Chrome opened this
    // because of us" from "the user opened this".
    //
    // With no opener, only a tab created in the INSTANT after we navigated counts.
    //
    // A rel=noopener handoff carries no openerTabId, so provenance alone cannot tell it
    // from a tab the user opened -- and measured, a bare url match closed a tab the user
    // opened by hand on the same paper mid-download. What does separate them is time:
    // Chrome performs the handoff within milliseconds of our own navigation, while a human
    // reaching for a new tab is orders of magnitude slower. HANDOFF_WINDOW_MS is therefore
    // deliberately tight, and the 15s url window is the outer bound rather than the test.
    if (typeof tab.openerTabId !== 'number' && Date.now() - lastNavigationAt > HANDOFF_WINDOW_MS) {
      return;
    }
    // pendingUrl is what a tab created for a navigation carries before it commits; url is
    // empty at that point, so both have to be checked or the match is always missed.
    if (wasRequestedRecently(tab.pendingUrl) || wasRequestedRecently(tab.url)) owned.add(tab.id);
  };
  // A tab already owned that navigates to a url we asked for tells us nothing new, but a
  // tab created BEFORE its url was known (Chrome commits the navigation afterwards) does:
  // onCreated saw an empty url, so the match has to be retried on the first update.
  const adoptOnUpdate = (id, info, tab) => {
    if (owned.has(id)) return;
    if (tabsOwnedByAnyCall.has(id)) return;
    // chrome.tabs.onUpdated is GLOBAL: it fires for every tab in every window, including
    // tabs that existed long before this call. Without the `seen` filter, a tab of the
    // user's own that merely navigated to a url we also requested would be adopted and then
    // closed in the finally -- the exact rule this file must never have. Same filter the
    // final sweep uses, for the same reason.
    if (!seen.has(id)) return;
    // `seen` means "created while this call ran", which is NOT provenance: a tab the user
    // opened by hand mid-download is created during the call too. Measured -- with only the
    // seen filter, opening the same paper manually got that tab closed. An opener chain
    // into a tab we already own is the only thing that separates a handoff Chrome performed
    // for us from a tab the user opened themselves.
    // Same rule as adopt: an owned opener, or a tab that appeared in the instant after we
    // navigated. `seen` alone is not provenance -- a tab the user opens mid-download is
    // also "created while this call ran".
    const byOpener = typeof tab?.openerTabId === 'number' && owned.has(tab.openerTabId);
    if (!byOpener && Date.now() - lastNavigationAt > HANDOFF_WINDOW_MS) return;
    const u = (info && info.url) || (tab && tab.url);
    if (wasRequestedRecently(u)) owned.add(id);
  };
  const note = (tab) => { if (tab && typeof tab.id === 'number') seen.add(tab.id); };
  // Registered before the create so a tab spawned during the first navigation is seen.
  chrome.tabs.onCreated.addListener(note);
  chrome.tabs.onCreated.addListener(adopt);
  chrome.tabs.onUpdated.addListener(adoptOnUpdate);
  try {
    // Background tab: most fetches clear without a challenge, and stealing focus on every
    // download would be intolerable while the user is working. waitForTabCleared owns the
    // decision to surface it -- see the focus rule documented there.
    const tab = await chrome.tabs.create({ url: landing, active: false });
    tabId = tab.id;
    owned.add(tabId);
    tabsOwnedByAnyCall.add(tabId);
    // The tab must actually be ON the target origin before it counts as cleared.
    let expectedOrigin = null;
    try { expectedOrigin = new URL(landing).origin; } catch { /* validated upstream */ }

    // ONE wait with ONE budget. It used to be two, the second with an Infinity deadline so
    // a human was never rushed -- but an Infinity deadline means the promise can never
    // settle, so the finally below never ran and the tab lived for the rest of the browser
    // session. That is the leak. The hour-long budget still outlasts any real captcha and
    // both peers' timeouts, and it guarantees cleanup.
    const deadline = Date.now() + budgetMs;
    const clear = await waitForTabCleared(tabId, deadline, expectedOrigin);
    // A non-scriptable document is a CLEARED tab, not a failed one. It means the landing url
    // was itself a PDF, so Chrome handed the tab to its internal viewer, which no extension
    // may script -- pageIsCleared can never answer for it and waiting longer cannot help.
    // The body still runs: an in-page fetch is refused there, but the worker fallback shares
    // the same cookie jar and the bytes are already in the tab's cache. Treating this as a
    // hard failure would break every url whose landing page is the file itself.
    if (!clear.cleared && !clear.nonScriptable) {
      return { ok: false, error: `page did not clear (${clear.reason})` };
    }

    return await body(tabId, deadline, expectedOrigin, requestUrl);
  } catch (err) {
    // Tagged: inPageFetch formats its own failures identically, and telling the two apart
    // is the difference between "the page refused the request" and "driving the tab threw".
    // Probe as well, because a throw here skips every retry below and the message alone
    // does not say what the tab was showing when it happened.
    let probe = null;
    if (tabId !== null) {
      try {
        const [pr] = await chrome.scripting.executeScript({ target: { tabId }, func: inPageProbe });
        probe = pr && pr.result;
      } catch (e) {
        probe = { probeFailed: `${e.name}: ${e.message}` };
      }
    }
    return { ok: false, error: `tab: ${err.name}: ${err.message} PAGE=${JSON.stringify(probe)}` };
  } finally {
    chrome.tabs.onCreated.removeListener(note);
    chrome.tabs.onCreated.removeListener(adopt);
    chrome.tabs.onUpdated.removeListener(adoptOnUpdate);
    // A handoff tab can be created in a NEW WINDOW rather than in the current one, and
    // Chrome may commit its url a beat after the call returns. Sweep the live tab list once
    // against the same two provenance rules before giving up on anything.
    //
    // This is a SWEEP, not a widening: a tab qualifies only by opener chain or by a url
    // this call itself requested. It exists because the two listeners are edge-triggered
    // and can miss a tab whose url was empty at every event they saw.
    try {
      const all = (await chrome.tabs.query({})).filter((t) => t && seen.has(t.id));
      // Two passes so a grandchild whose parent was adopted in this same sweep is caught;
      // one pass would depend on the order chrome.tabs.query happens to return.
      for (let pass = 0; pass < 2; pass += 1) for (const t of all) adopt(t);
    } catch {
      // No tabs permission at runtime, or the browser is shutting down. The listeners
      // already own the common cases.
    }
    // Close on EVERY outcome, success or not. Leaving a failed tab open was meant to make
    // the origin's response inspectable, but the inspection already happened: both the
    // catch above and fetchPdf's tail run inPageProbe and fold the result into the error
    // string, so the tab held nothing the caller does not already have. What it did do was
    // accumulate -- ScienceDirect and OUP fail routinely (paywall, then a navigate at a PDF
    // that ends on pdf.sciencedirectassets.com or watermark02.silverchair.com), so the
    // user's daily Chrome collected a tab per attempt.
    //
    // Nothing here can close a tab a human is mid-solve on: every challenge wait runs to
    // completion (cleared, or the full HUMAN_SOLVE_BUDGET_MS spent) before control can
    // reach this point, so by the time this runs the tab is either cleared or the hour is
    // up. There is no path that cancels a wait early.
    for (const id of owned) {
      // Released whether or not the remove succeeds: leaving an id in the registry would
      // make that tab permanently unadoptable by any later call.
      tabsOwnedByAnyCall.delete(id);
      try {
        await chrome.tabs.remove(id);
      } catch {
        // Already gone: the tab was closed by the user, or by Chrome after it turned the
        // navigation into a download.
      }
    }
  }
}

/** Fetches the PDF from inside a cleared tab on its own origin. */
async function fetchPdf({ url, referer, budgetMs }) {
  // urlTier, not isAllowedUrl: the latter answers only for the CREDENTIALED grant, so an
  // anonymous-tier host (a mirror, an OA repository) was refused as unlisted despite being
  // granted. The credentials themselves are still derived per-url inside the fetch, so
  // widening the gate here does not widen what is sent.
  if (urlTier(url) === TIER.NONE) return { ok: false, error: 'host not allowlisted' };
  // The landing page shares the PDF's origin, so clearing the challenge there
  // also clears it for the fetch. Fall back to the PDF url when none was given.
  // The landing page is only ever navigated to, so it is checked against the looser
  // navigation rule: on bepress the challenge lives on the article page, whose path the
  // byte-returning grant deliberately does not cover.
  const landing = (typeof referer === 'string' && isAllowedNavigationUrl(referer)) ? referer : url;

  // Downloads Chrome starts BY ITSELF while this call navigates.
  //
  // The navigate branches below point the tab AT the pdf to make it a document request. When
  // the response carries a Content-Disposition (libgen's get.php, publisher watermark hosts)
  // Chrome does not render it -- it SAVES it, and no code here asked for that. Left alone the
  // user gets a file they did not request, under Chrome's own name, whether or not this call
  // ends up succeeding: that is the "it downloaded a pdf but kept opening websites" report.
  //
  // Watched rather than guessed at: only ids that appear while this call is navigating are
  // touched, so a download the user started themselves is never in scope.
  const strays = new Set();
  const noteStray = (item) => {
    if (item && typeof item.id === 'number') strays.add(item.id);
  };
  chrome.downloads.onCreated.addListener(noteStray);

  try {
  return await withClearedTab(landing, async (tabId, deadline, expectedOrigin, requestUrl) => {
    // One attempt: try in the page, and fall back to the worker when the page refuses
    // a cross-origin hop. Both paths are needed on every attempt, not just the first --
    // the in-page fetch is what carries the cleared session, but a redirect off-origin
    // (Delivery.cfm -> download.ssrn.com, or a bepress PDF host) is blocked by the
    // page's CORS rules and surfaces only as an opaque "TypeError: Failed to fetch".
    // The worker is exempt for hosts in host_permissions and shares the same cookie jar.
    let workerNote = 'worker=not-tried';
    let navigated = false;
    // Whether a reload has already been spent on this request. A 403 that persists AFTER
    // one is a refusal rather than a challenge, which is what routes OUP to the navigate
    // branch instead of looping.
    let reloaded = false;
    const runFetchOn = async (target) => {
      // Refuse before touching the page: the tier resolver is the gate, and a url covered
      // by neither grant must not be fetched from anywhere.
      const targetCredentials = credentialsFor(target);
      if (targetCredentials === null) return { ok: false, error: 'host not allowlisted' };
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: inPageFetch,
        args: [target, MAX_PDF_BYTES, targetCredentials, FETCH_TIMEOUT_MS],
      });
      const inPage = (r && r.result) || { ok: false, error: 'in-page fetch returned nothing' };
      if (inPage.ok || !/Failed to fetch/i.test(inPage.error || '')) return inPage;
      // The page refused a cross-origin hop. Retry from the worker, which CORS does not
      // bind -- but only accept a real answer. A worker request does not carry whatever
      // the tab just solved, so on a WAF-fronted origin it comes back as the challenge
      // itself (202 text/html, empty body). Returning that would replace a diagnosable
      // in-page failure with a misleading one, so keep the original in that case.
      const viaWorker = await workerFetch(target, MAX_PDF_BYTES);
      if (viaWorker.ok) return viaWorker;
      workerNote = `worker=${viaWorker.error}`;
      // Last resort: omit credentials. A publisher that hands off to object storage
      // (Mendeley -> S3) gets a response carrying "Access-Control-Allow-Origin: *",
      // which CORS refuses to pair with credentials:'include' -- so the credentialed
      // attempt above can never succeed there no matter what is permitted. Those
      // handoff URLs are presigned and need no cookies, and the request is already
      // allowlisted, so retrying without them costs nothing and reaches the bytes.
      const anon = await workerFetch(target, MAX_PDF_BYTES, true);
      if (anon.ok) return anon;
      // Carry both worker outcomes into the error: the in-page failure alone says
      // nothing about why neither credentialed nor anonymous worker fetch worked.
      return { ok: false, error: `${inPage.error} [${workerNote}] [anon=${anon.error}]` };
    };
    const runFetch = () => runFetchOn(url);

    let result = await runFetch();
    const trace = [`first=${result.ok ? 'ok' : result.error}`];

    // Escalate until something works or there is nothing left to try. The failure mode
    // changes between attempts on a WAF-fronted origin -- a 504 becomes an opaque fetch
    // refusal after the reload -- so these cannot be independent one-shot branches in a
    // fixed order; each pass has to react to whatever the CURRENT error is.
    for (let attempt = 0; attempt < 3 && !result.ok; attempt += 1) {
      const err = result.error || '';

      // A 403 that SURVIVED a reload of an already-cleared page is not a challenge, so
      // reloading again cannot help -- measured on OUP, whose trace was three identical
      // "reload|solved=true" passes against a page that was never challenged. That origin
      // serves its PDF only to a navigation, exactly like ScienceDirect below, so fall
      // through to the navigate branch instead of spending the remaining attempts.
      // Deliberately narrow: only once a reload has already been tried and the page came
      // back cleared, so a genuine challenge still gets its reloads first. That ordering is
      // what keeps DigitalCommons working -- its AWS WAF path legitimately depends on
      // reload-and-wait, and it reaches this only after that has already been spent.
      //
      // Accepted cost: navigating at a PDF makes Chrome download it, so a 403 that ends in
      // a navigation can leave one stray file in the user's Downloads folder on a path that
      // previously never navigated. Bounded to one per request by `navigated` (the same
      // guard the Failed-to-fetch branch below relies on), and it is the only way OUP's
      // watermark handoff yields bytes at all -- a download that succeeds plus a stray copy
      // beats no download.
      const refusedAfterClearedReload = reloaded
        && /^(page: |worker: )?.*http 403/.test(err)
        && !navigated;

      if (/^(page: |worker: )?.*http (401|403|504)/.test(err) && !refusedAfterClearedReload) {
        // A human is wanted, or the WAF is holding the sub-resource request. Surface the
        // tab and reload so whatever it wants renders where it can be answered.
        trace.push(`a${attempt}:reload`);
        reloaded = true;
        try { await chrome.tabs.reload(tabId); } catch { /* tab gone */ }
        // Bounded by the SAME deadline withClearedTab established, never extended past it.
        // This reload happened because the origin wanted something, so a human may well be
        // watching -- but the tab is surfaced by waitForTabCleared under the one focus rule
        // rather than unconditionally here. Unconditional surfacing was half of the
        // inconsistency: this branch stole focus even for a 504 no human can answer.
        // autoClearMs 0 because the page has already had its grace period; if it comes back
        // challenged after a reload, a human is wanted now.
        const solved = await waitForTabCleared(tabId, deadline, expectedOrigin, { autoClearMs: 0 });
        trace.push(`solved=${solved.cleared}:${solved.reason}`);
        if (!solved.cleared) break;
        result = await runFetch();
        continue;
      }

      // A fetch that returns HTML where a PDF was asked for is the same problem as one
      // that is refused outright: the origin serves these urls to a NAVIGATION, not to a
      // background request. ScienceDirect marks its "View PDF" anchor target="_blank" and
      // answers a fetch of the very same url with the article page instead of the file.
      if ((/not a pdf \(starts with/i.test(err) || refusedAfterClearedReload) && !navigated) {
        trace.push(`a${attempt}:navigate-${refusedAfterClearedReload ? '403' : 'html'}`);
        navigated = true;
        try {
          // Record the url BEFORE navigating. If the origin turns this into a target=_blank
          // handoff or Chrome opens the PDF in a new window, the resulting tab may carry no
          // openerTabId -- the url we asked for is then the only honest provenance signal.
          requestUrl(url);
          await chrome.tabs.update(tabId, { url });
          const settled = await waitForTabSettled(tabId);
          trace.push(`settled=${settled}`);
          // Re-fetch the url the tab ENDED on, not the one we asked for. ScienceDirect
          // redirects to a presigned pdf.sciencedirectassets.com link that is one-shot:
          // the navigation spends it, and asking for the original url again mints a new
          // request the origin answers with 403. The settled url is already fetched and
          // sits in the tab's cache, so this reads it back instead of buying a new one.
          //
          // The settled url is chosen by the ORIGIN, not by us: it is wherever that origin
          // decided to redirect. So it is re-checked before being fetched. Without this,
          // any host in the grant could 302 the tab at an arbitrary url and have the
          // extension fetch it with the user's cookies. That was tolerable while every
          // grant was a publisher we trust; it stops being tolerable the moment mirrors
          // like Sci-Hub and LibGen are in the list, where the redirect target is
          // attacker-chosen by design. Falling back to the ORIGINAL url is safe -- it is
          // the one the caller asked for and was already checked.
          let settledUrl = url;
          try {
            const t = await chrome.tabs.get(tabId);
            if (t && typeof t.url === 'string' && t.url) {
              if (urlTier(t.url) !== TIER.NONE) {
                settledUrl = t.url;
                // The redirect target counts as requested by this call: we caused the tab to
                // go there. pdf.sciencedirectassets.com is reached exactly this way, and it
                // is the reported leak -- Chrome may render it in the internal PDF viewer or
                // hand it to a new tab with no opener, both invisible to the opener chain.
                requestUrl(t.url);
              } else {
                trace.push('settled-url-refused');
              }
            }
          } catch { /* tab gone; fall back to the original */ }
          if (settledUrl !== url) trace.push('refetch-settled-url');
          result = await runFetchOn(settledUrl);
        } catch (e) {
          trace.push(`navthrew=${e.name}`);
          break;
        }
        continue;
      }

      if (/Failed to fetch/i.test(err) && !navigated) {
        // Once only. Navigating at a PDF makes Chrome download it, so repeating this
        // litters the user's Downloads folder with a copy per attempt while telling us
        // nothing new -- if the document request did not help the first time, it will
        // not help the second.
        // AWS WAF answers a top-level navigation but refuses the equivalent background
        // request, same-origin included. Navigating AT the PDF makes it a document
        // request; the bytes are then in the tab's cache for an immediate re-fetch.
        navigated = true;
        trace.push(`a${attempt}:navigate`);
        try {
          requestUrl(url);
          await chrome.tabs.update(tabId, { url });
          const settled = await waitForTabSettled(tabId);
          trace.push(`settled=${settled}`);
          result = await runFetch();
        } catch (e) {
          trace.push(`navthrew=${e.name}`);
          break;
        }
        continue;
      }

      break;
    }

    // Whatever it ended on, say what the tab was showing.
    if (!result.ok) {
      let probe = null;
      try {
        const [pr] = await chrome.scripting.executeScript({ target: { tabId }, func: inPageProbe });
        probe = pr && pr.result;
      } catch (e) {
        probe = { probeFailed: `${e.name}: ${e.message}` };
      }
      result = { ...result, error: `${result.error} PAGE=${JSON.stringify(probe)}` };
    }

    // Always carry the trace on a failure: without it a bare error says nothing about
    // which branches ran, which is exactly what has been missing.
    if (!result.ok && !/TRACE=/.test(result.error || '')) {
      result = { ...result, error: `${result.error} TRACE=${trace.join('|')}` };
    }
    return result;
  }, budgetMs);
  } finally {
    chrome.downloads.onCreated.removeListener(noteStray);
    // Erase, do not merely forget. The bytes this function returns are saved deliberately by
    // downloadToBrowser under the paper's real title; a copy Chrome saved on its own is a
    // duplicate at best and, when the retrieval failed, a file for a paper the user was told
    // could not be found. Either way it is not theirs and it is not named like anything they
    // asked for.
    //
    // removeFile before erase: erase alone drops the history row and ORPHANS the file on
    // disk, which is the opposite of cleaning up. Both are best-effort -- a download the user
    // cancelled, or one already gone, throws and is nothing to report.
    for (const id of strays) {
      await chrome.downloads.removeFile(id).catch(() => {});
      await chrome.downloads.erase({ id }).catch(() => {});
    }
  }
}

/**
 * Same-origin PDF href harvest from a cleared tab.
 *
 * Exists for data.mendeley.com, whose served HTML contains no file references at
 * all (measured 2026-07-26: zero .pdf urls, zero /public-files/ paths, no
 * __NEXT_DATA__, the string "download" appears 0 times) and whose public API is
 * 401/404 unauthenticated. The file list only exists in the DOM after hydration,
 * so it has to be read from a real tab -- and because hydration is asynchronous,
 * read repeatedly rather than once on load.
 *
 * Four filters keep this from being a general enumeration primitive:
 *   - the requested url must be allowlisted, exactly as for fetch_pdf;
 *   - only anchors whose path ends in .pdf are collected at all (in the page,
 *     see inPagePdfLinks -- which is also what makes the poll terminate on the
 *     file table rather than on the site navigation);
 *   - a returned link must be same-origin with the requested url, so a cleared
 *     privileged page cannot be used to point the caller anywhere else;
 *   - each returned link must itself pass isAllowedUrl, so the same-origin rule
 *     cannot be leaned on if the allowlist is ever narrowed.
 * The link set is then deduplicated and capped at MAX_LINKS.
 */
/**
 * Read Google Scholar results out of a rendered page.
 *
 * Serialised into the tab by chrome.scripting, so it must not close over anything.
 *
 * Scholar has no API and is the one index that genuinely needs a browser: it blocks
 * datacenter traffic outright and answers consent and captcha interstitials, which is why
 * a headless fetcher drives it with Puppeteer. From the user's own logged-in Chrome on a
 * residential IP it is an ordinary page, so a tab plus a DOM read is enough.
 *
 * The selectors are Scholar's long-standing result markup: .gs_ri wraps each result, .gs_rt
 * the title, .gs_a the author/venue/year line, .gs_rs the snippet, and .gs_or_ggb the
 * right-hand link to a free full text when one exists.
 */
function inPageScholarResults(maxResults) {
  const out = [];
  const nodes = document.querySelectorAll('.gs_ri');
  for (let i = 0; i < nodes.length && out.length < maxResults; i += 1) {
    const el = nodes[i];
    const titleEl = el.querySelector('.gs_rt');
    if (!titleEl) continue;
    // The title carries a [PDF]/[HTML]/[BOOK] badge as a leading span; drop it so the
    // stored title is the paper's, not Scholar's annotation of where it lives.
    const badge = titleEl.querySelector('.gs_ct1, .gs_ctg2');
    const title = (titleEl.textContent || '')
      .replace(badge ? (badge.textContent || '') : '', '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!title) continue;
    const link = titleEl.querySelector('a');
    // "Authors - Venue, Year - publisher.com", with the year the last 4-digit run.
    const meta = (el.querySelector('.gs_a')?.textContent || '').replace(/\s+/g, ' ').trim();
    const yearMatch = meta.match(/\b(1[6-9]\d{2}|20\d{2})\b/g);
    const parts = meta.split(' - ');
    // "Cited by N" lives in the result's footer links.
    let cited = null;
    // Scoped to the whole result block: "Cited by N" lives in .gs_fl, a sibling of .gs_ri
    // under the shared .gs_r container. Measured on a live page: "Cited by 316".
    const row = el.closest('.gs_r') || el.parentElement || el;
    for (const a of row.querySelectorAll('a')) {
      const m = (a.textContent || '').match(/Cited by (\d+)/);
      if (m) { cited = Number(m[1]); break; }
    }
    out.push({
      title,
      url: link ? link.href : null,
      // Scholar does not publish DOIs; the resolver downstream can still find one by title.
      doi: null,
      pdfUrl: (row.querySelector('.gs_or_ggb a') || {}).href || null,
      authors: parts[0]
        ? parts[0].split(',').map((a) => a.trim()).filter(Boolean).slice(0, 30)
        : [],
      year: yearMatch ? yearMatch[yearMatch.length - 1] : null,
      abstract: (el.querySelector('.gs_rs')?.textContent || '').replace(/\s+/g, ' ').trim() || null,
      venue: parts[1] ? parts[1].replace(/,?\s*(1[6-9]\d{2}|20\d{2})\s*$/, '').trim() || null : null,
      citationCount: cited,
      source: 'scholar',
    });
  }
  return out;
}

/**
 * Search Google Scholar in a tab.
 *
 * Uses the same withClearedTab machinery as PDF retrieval, so a consent screen or captcha
 * surfaces to the user and the tab is closed on every exit -- including failure.
 */
async function searchScholar({ query, maxResults = 10, page = 1, filters = {} }) {
  const u = new URL('https://scholar.google.com/scholar');
  u.searchParams.set('q', filters.author ? `${query} author:"${filters.author}"` : query);
  u.searchParams.set('hl', 'en');
  if (Number.isFinite(filters.yearFrom)) u.searchParams.set('as_ylo', String(filters.yearFrom));
  if (Number.isFinite(filters.yearTo)) u.searchParams.set('as_yhi', String(filters.yearTo));
  // Scholar paginates in TENS, so the page size and the clamp below must agree or page 2
  // starts past the end of page 1. Asking for more than 10 is a page-1-only request.
  const perPage = 10;
  if (page > 1) u.searchParams.set('start', String((page - 1) * perPage));

  const target = u.toString();
  // urlTier, not isAllowedUrl: the latter answers only for the CREDENTIALED grant, and
  // Scholar is anonymous-tier, so it was refused as unlisted despite being granted.
  if (urlTier(target) === TIER.NONE) {
    return { source: 'scholar', error: 'host not allowlisted', results: [] };
  }

  try {
    // Bounded SEPARATELY from the human-solve budget. Scholar is one source among five in a
    // search, and a search is not a download: nobody is sitting waiting to solve a captcha
    // for it. Without this, Scholar's rate-limit redirect (google.com/sorry/index, which is
    // not allowlisted and so can never report cleared) burned the full hour with a tab open
    // while the whole search response waited on it.
    const results = await withClearedTab(target, async (tabId) => {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: inPageScholarResults,
        args: [Math.min(Math.max(1, maxResults), perPage)],
      });
      return (r && r.result) || [];
    }, SCHOLAR_TIMEOUT_MS);
    // withClearedTab answers {ok:false, error} for a page that never cleared -- a consent
    // interstitial, a captcha, or the rate-limit page. Coercing that to [] reported it as
    // "no results", which is the lie this whole audit keeps finding.
    if (results && results.ok === false) {
      return { source: 'scholar', error: results.error || 'scholar did not clear', results: [] };
    }
    return { source: 'scholar', results: Array.isArray(results) ? results : [] };
  } catch (err) {
    return { source: 'scholar', error: `${err.name}: ${err.message}`, results: [] };
  }
}

/**
 * Retrieve one paper, trying every source the extension has.
 *
 * This is what makes the extension self-sufficient for downloads. It runs the same three-phase
 * ladder the server used, with one deliberate change: mirrors go LAST rather than racing in
 * the parallel phase. Mirrors have no bot-check, so in a flat race they routinely beat the
 * publisher and an unsigned mirror copy silently displaces the authentic file -- and %PDF-
 * is a five-byte check, not an integrity guarantee.
 */
// --- source circuit breaker ---------------------------------------------------------
//
// A source that failed for a GLOBAL reason -- every mirror domain dead, DNS gone, the whole
// service down -- will fail the same way for the next paper, and the one after. Retrying it
// costs the user the full per-source budget every single time: measured, walking every
// mirror host put the mirror phase past 170s, and most of that was spent on hosts that were
// never going to answer.
//
// So a globally-failed source is parked for 30 minutes. The distinction that matters is
// GLOBAL versus PER-PAPER: "not on libgen" means libgen is healthy and simply lacks that
// paper, and parking it would lose every subsequent paper it does have. Only failures that
// say nothing about the paper count -- no host answered, DNS failure, a budget spent
// without one reachable mirror.
//
// State lives in chrome.storage.session so it survives the service worker being evicted,
// which happens constantly, while a browser restart clears it -- a genuinely fresh chance.
const OUTAGE_PARK_MS = 30 * 60 * 1000;
const OUTAGE_KEY = 'sourceOutages';

/** Failures that say the SOURCE is down, rather than that this paper is absent. */
function isGlobalFailure(error) {
  if (typeof error !== 'string') return false;
  return /no reachable|no mirror answered|budget exhausted|Failed to fetch|NetworkError|ERR_NAME_NOT_RESOLVED|getaddrinfo|ENOTFOUND|TimeoutError|AbortError/i.test(error);
}

/** Sources currently parked, as { name: expiryMs }. Never throws. */
async function parkedSources() {
  try {
    const v = await chrome.storage?.session?.get(OUTAGE_KEY);
    const map = v?.[OUTAGE_KEY];
    if (!map || typeof map !== 'object') return {};
    // Drop expired entries on read, so the record cannot grow without bound.
    const now = Date.now();
    return Object.fromEntries(Object.entries(map).filter(([, until]) => until > now));
  } catch {
    return {};
  }
}

async function parkSource(name, error) {
  if (!isGlobalFailure(error)) return;
  try {
    const map = await parkedSources();
    map[name] = Date.now() + OUTAGE_PARK_MS;
    await chrome.storage?.session?.set({ [OUTAGE_KEY]: map });
  } catch {
    // Storage unavailable: the breaker is an optimisation, never a correctness requirement.
  }
}

/**
 * The paper's title, for naming the downloaded file.
 *
 * Crossref knows the title for any registered DOI. Looked up CONCURRENTLY with the
 * retrieval by the caller, never before it: retrieval takes seconds at best and up to a
 * minute when it reaches the publisher phase, so a metadata request running alongside costs
 * no wall-clock time. Sequentially it would add a round trip to every download.
 *
 * Never throws. A download must not fail because its filename could not be prettified.
 */
async function paperTitle(doi) {
  if (!doi) return null;
  try {
    const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
    // The single decision point. A literal here would put the choice back at the call site,
    // which is the shape that let cookies reach hosts that had no business seeing them.
    const credentials = credentialsFor(url);
    if (credentials === null) return null;
    const res = await fetch(url, {
      credentials,
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const t = (await res.json())?.message?.title;
    const title = Array.isArray(t) ? t[0] : t;
    return typeof title === 'string' && title.trim() ? title.trim() : null;
  } catch {
    return null;
  }
}

/**
 * A filesystem-safe filename for a paper.
 *
 * Falls back to the DOI form whenever the title is missing or sanitises down to nothing --
 * a paper whose title is in a script the filesystem mangles must still download. Chrome
 * sanitises again on its side; this is about producing something reasonable, not about
 * trusting the result.
 */
function pdfFilename(title, doi, pdfUrl) {
  const clean = (title || '')
    // Path separators and the characters Windows forbids.
    .replace(/[\\/:*?"<>|]/g, ' ')
    // Control characters, which are legal on Linux and a trap everywhere else.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Long enough to stay recognisable, short enough that the whole path fits.
    .slice(0, 120)
    // A trailing dot or space is silently stripped by Windows, which turns two different
    // papers into one filename.
    .replace(/[. ]+$/, '');
  if (clean) return `${clean}.pdf`;
  if (doi) return `${doi.replace(/[\\/:*?"<>|]/g, '-')}.pdf`;
  // A pasted url has no DOI and therefore no Crossref title, so its own basename is the only
  // thing that distinguishes it. Without this every such download lands as paper.pdf, and
  // the second one becomes "paper (1).pdf" -- a folder of files named after nothing.
  const base = pdfUrlBasename(pdfUrl);
  return base ? `${base}.pdf` : 'paper.pdf';
}

/** The last path segment of a url, sanitised, with any .pdf suffix removed. */
function pdfUrlBasename(pdfUrl) {
  if (!pdfUrl) return null;
  try {
    const last = new URL(pdfUrl).pathname.split('/').filter(Boolean).pop();
    if (!last) return null;
    return decodeURIComponent(last)
      .replace(/\.pdf$/i, '')
      .replace(/[\\/:*?"<>|]/g, '-')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f]/g, ' ')
      .trim()
      .slice(0, 120)
      .replace(/[. ]+$/, '') || null;
  } catch {
    return null;
  }
}

/**
 * Hand bytes we already hold to Chrome's download manager.
 *
 * The BYTES, not the resolved url. A Chrome download is a fresh request that does not carry
 * the challenge the tab session cleared, so handing it a url would fail on exactly the ten
 * bot-walled publishers this bridge exists for -- it would work only for open-access pdfs,
 * which never needed a bridge.
 */
async function downloadToBrowser(base64, filename) {
  // Slimmed HERE, and deliberately not one level up in runDownload.
  //
  // runDownload is shared by the popup and the native bridge so the two cannot drift, and
  // the bridge must hand Corpus Studio the PUBLISHER'S bytes: the app runs its own qpdf
  // over everything it ingests. Slimming in the shared path would optimise the same file
  // twice and leave the app storing bytes that match neither the publisher's original nor
  // its own output. This function is the last step only the popup reaches, so it is the
  // one place where "slim it" means "slim the copy nobody else will optimise".
  //
  // slimPdf never throws and returns the original on every failure path, so a download can
  // never be lost to an optimisation that did not work out.
  const slimmed = await slimPdf(base64ToBytes(base64));
  // A DATA url, not a blob url.
  //
  // URL.createObjectURL DOES NOT EXIST in an MV3 service worker -- there is no Blob URL
  // store outside a document. Calling it threw TypeError on every single download, which
  // the popup reported as a failed retrieval, and nothing ever reached chrome://downloads.
  //
  // Chrome's download manager accepts a data url directly, and there is nothing to revoke
  // afterwards: a data url is the bytes, not a handle to them, so it dies with the string.
  const url = `data:application/pdf;base64,${bytesToBase64(slimmed)}`;
  let id;
  try {
    id = await chrome.downloads.download({ url, filename, saveAs: false });
  } catch (err) {
    return { ok: false, error: `${err.name}: ${err.message}` };
  }
  // download() resolves as soon as an id is assigned -- when the transfer STARTS, not when
  // it ends. Reporting success there would say "Saved" for a file that may still fail, so
  // the wait is on the terminal state.
  return await new Promise((resolve) => {
    const finish = (out) => {
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      resolve(out);
    };
    const onChanged = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === 'complete') finish({ ok: true, downloadId: id, filename });
      else if (delta.state.current === 'interrupted') {
        finish({ ok: false, error: `download interrupted (${delta.error?.current || 'unknown'})` });
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    // A ceiling, because a download the user pauses would otherwise hold this open
    // forever. Writing bytes we already hold to local disk is fast; a minute is generous.
    const timer = setTimeout(() => finish({ ok: false, error: 'download did not finish' }), 60000);
    // The state may already be terminal: a small pdf can complete before the listener is
    // attached, and nothing would ever fire.
    chrome.downloads.search({ id }, (items) => {
      const state = items?.[0]?.state;
      if (state === 'complete') finish({ ok: true, downloadId: id, filename });
      else if (state === 'interrupted') finish({ ok: false, error: 'download interrupted' });
    });
  });
}

/**
 * Retrieve one paper and put it in the browser's Downloads folder.
 *
 * Shared by the native host and the popup so the two cannot drift: a download started from
 * the toolbar and one started by Corpus Studio must produce the same file, the same name and
 * the same failure text. Never throws -- both callers report, neither can handle.
 */
async function runDownload(request) {
  try {
    // Retrieval and the title lookup run CONCURRENTLY. Retrieval is the slow half (seconds,
    // or a minute through the publisher phase), so the metadata request alongside it is
    // free -- sequentially it would tax every download.
    const [got, title] = await Promise.all([
      retrievePaper(request),
      paperTitle(request.doi),
    ]);
    if (!got.ok) return { ok: false, error: got.error, attempts: got.attempts };
    const filename = pdfFilename(title, request.doi, request.pdfUrl);
    const saved = await downloadToBrowser(got.base64, filename);
    if (!saved.ok) return { ok: false, error: saved.error, attempts: got.attempts };
    return {
      ok: true,
      filename: saved.filename,
      bytes: got.bytes,
      source: got.source,
      title: title || null,
    };
  } catch (err) {
    return { ok: false, error: `${err.name}: ${err.message}` };
  }
}

/**
 * What the popup's field accepts, turned into a retrieval request.
 *
 * Refused BEFORE anything runs: a failed retrieval takes up to a minute and spending that on
 * a typo is worse than refusing instantly. Returns null for anything unrecognised.
 */
function parseDownloadInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const doi = extractDoi(text);
  if (doi) return { doi };
  // arXiv, in the shapes people actually paste. Its pdf url is constructible, so no
  // resolver is involved.
  const arxiv = /arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?$/i.exec(text)
    || /^arxiv:\s*(.+)$/i.exec(text);
  const bare = /^\d{4}\.\d{4,5}(v\d+)?$/i.test(text)
    || /^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/i.test(text);
  if (arxiv) return { pdfUrl: `https://arxiv.org/pdf/${arxiv[1].trim()}` };
  if (bare) return { pdfUrl: `https://arxiv.org/pdf/${text}` };
  // A direct link is tried as-is; the %PDF- check rejects it if it turns out to be a
  // landing page, and the allowlist refuses a host the extension does not carry.
  if (/^https:\/\/\S+$/i.test(text)) return { pdfUrl: text };
  return null;
}

// The popup's only channel. It runs in its own page, so it cannot call these functions
// directly -- and it must not, because the popup closes the moment focus moves and a
// download running in it would die with it. The worker owns the work; the popup only asks.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'popup_download') return undefined;
  const request = parseDownloadInput(msg.identifier);
  if (!request) {
    sendResponse({
      ok: false,
      error: 'Enter a DOI (10.xxxx/yyyy), a doi.org link, an arXiv id, or a direct https PDF link.',
    });
    return undefined;
  }
  runDownload({ ...request, email: msg.email }).then(sendResponse);
  // Keeps the channel open for the async reply. Without it the popup gets undefined
  // immediately and every download looks like it failed.
  return true;
});

async function retrievePaper({ doi, pdfUrl, email, coreApiKey }) {
  const attempts = [];

  // The publisher's own bytes, unaltered. Corpus Studio runs its own qpdf over whatever it
  // is handed and hashes the result, so recompressing here would store a file matching
  // neither the publisher's nor the app's -- for no gain, since the app optimises anyway.
  const deliver = (source, url, buf) => ({
    ok: true,
    source,
    url,
    base64: bytesToBase64(new Uint8Array(buf)),
    bytes: buf.byteLength,
    attempts,
  });

  // ---8<--- mirror phase (stripped for the store build) ---8<---
  // PHASE 1 -- mirrors, first. They hold the paywalled majority, they answer without a
  // challenge and without a human, and they cost nothing when they miss.
  //
  // Bounded as a GROUP, not just per source: three sources at 45s each is over two minutes
  // before the publisher phase has even started, and a download that takes minutes with no
  // output is indistinguishable from one that has hung.
  const mirrorDeadline = Date.now() + MIRROR_PHASE_BUDGET_MS;
  const parked = await parkedSources();
  // The try opens BEFORE the doi gate so the ceiling is set and cleared by the same block.
  // Setting it outside meant a pdfUrl-only retrieval (no doi) skipped the phase without ever
  // running the finally, leaving the ceiling at a timestamp that is then in the past
  // forever -- every later call would skip its mirrors outright and never say why.
  try {
    // Publish the ceiling so every mirror helper is bounded by the PHASE, not only by its
    // own budget.
    setMirrorPhaseDeadline(mirrorDeadline);
    // Ask every tab-free source at once, before the sequential walk begins. The hints only
    // reorder and skip WITHIN a phase -- no source moves between phases, and no phase is
    // skipped, so a probe that learned nothing costs the ladder nothing but the wait.
    let hints = { has: {}, ruledOut: [] };
    if (doi) {
      hints = await probeAvailability(doi, { email, coreApiKey });
      // The same headroom idiom the loop below uses. A probe that walked the mirrors long
      // enough to spend the phase has left nothing to reorder, and acting on its hints would
      // then skip sources on evidence the ladder no longer has time to overturn. So an
      // exhausted budget proceeds UNHINTED -- never unmirrored.
      if (Date.now() + MIRROR_HOST_MIN_MS > mirrorDeadline) hints = { has: {}, ruledOut: [] };
    }
    // Set once a source the probe was CONFIDENT about has failed anyway. From that moment the
    // probe's negatives are worth nothing: a 429 or a challenge page read as "does not hold
    // this paper" is exactly the misread the asymmetry exists to make cheap, and it stays
    // cheap only if the rest of the ladder still runs in full.
    let hintFailed = false;
    if (doi) {
    const ladder = [
      ['scihub', async () => {
        // PROBE FIRST, open a tab second -- the pattern libgen and annas already use.
        //
        // This used to call fetchLinks (which opens a TAB) once per host, for every host in
        // a list that is five long and comes off the network, so it can be longer. A DOI
        // sci-hub does not carry therefore cost the user a visible window per mirror, one
        // after another, and the group budget could not be consulted until all of them had
        // been walked. That is the reported symptom: websites still opening after the PDF
        // had already been saved.
        //
        // A plain fetch tells us whether the host is up and whether it has the article at
        // all. Only a host that answers with something PDF-shaped earns a tab, because the
        // tab exists solely to run the page's JS and resolve the real file url.
        for (const host of await scihubMirrors()) {
          if (Date.now() + MIRROR_HOST_MIN_MS > mirrorDeadline) {
            return { ok: false, error: 'mirror phase budget exhausted' };
          }
          const page = scihubArticleUrl(host, doi);
          const body = await getTextMirror(page, PROBE_TIMEOUT_MS_MIRROR);
          // Host down, or rate-limiting: try the next one, still without a tab.
          if (body === null) continue;
          // Skip ONLY on a definitive "not in my database" answer.
          //
          // The test is deliberately NOT "did the static html contain a pdf link". The whole
          // reason a tab exists here is that the link may be written by the page's own JS or
          // carried on a `src` rather than an `href`, so absence proves nothing and skipping
          // on it would silently lose papers Sci-Hub actually has -- a worse bug than the
          // stray tab this probe is here to prevent. Only the not-found page is conclusive,
          // because for it no link will EVER render, whatever the JS does.
          if (isScihubUnavailableHtml(body)) continue;
          // A captcha or DDoS interstitial is not an article page, and opening it spends the
          // user's attention on a robot check for a paper this mirror may not even hold.
          // Measured: sci-hub.ru served the same "proverka na robota" page for a real doi and
          // an invented one, so the page carries no information about the paper at all.
          if (isMirrorChallengeHtml(body)) continue;
          // The POSITIVE test, and the one that actually decides. A tab exists here only to
          // run the page's JS and resolve the file url, so it is worth opening only when the
          // page already shows a file to resolve. The robot check shows none.
          if (!scihubPageOffersPdf(body)) continue;
          // The tab inherits what is LEFT of the phase, not fetchLinks' one-hour default.
          // That default is there so a human can solve a publisher captcha; no human is
          // waiting on a mirror, and inheriting it let one host hold a tab open long after
          // the ninety-second phase was over -- the "it kept opening websites" report.
          const remaining = mirrorDeadline - Date.now();
          if (remaining < MIRROR_HOST_MIN_MS) {
            return { ok: false, error: 'mirror phase budget exhausted' };
          }
          const links = await fetchLinks({ url: page, budgetMs: remaining });
          const pick = links.ok ? pickScihubPdf(links.links, page) : null;
          if (pick) {
            const r = await fetchValidatedPdf(pick, { timeoutMs: 45000 });
            if (r.ok) return r;
          }
        }
        return { ok: false, error: 'no sci-hub mirror served it' };
      }],
      ['annas', async () => {
        const page = await annasArticleUrl(doi);
        if (!page) return { ok: false, error: 'no reachable annas mirror' };
        // Same bound as sci-hub: annasArticleUrl has already spent part of the phase
        // walking mirrors, so the tab gets what is left rather than the one-hour default.
        const remaining = mirrorDeadline - Date.now();
        if (remaining < MIRROR_HOST_MIN_MS) {
          return { ok: false, error: 'mirror phase budget exhausted' };
        }
        const links = await fetchLinks({ url: page, budgetMs: remaining });
        const pick = links.ok ? pickAnnasPdf(links.links, page) : null;
        return pick ? fetchValidatedPdf(pick, { timeoutMs: 45000 }) : { ok: false, error: 'no file link' };
      }],
      ['libgen', async () => {
        const u = await libgenPdfUrl(doi);
        if (!u) return { ok: false, error: `not on libgen (${lastMirrorError || 'no detail'})` };
        // Through the TAB path, not a worker fetch. libgen's get.php answers with a
        // Content-Disposition and no CORS headers, and a worker fetch of it fails with an
        // opaque "Failed to fetch" even though the host is granted -- while the same url
        // downloads fine from Node. The tab path is what every walled publisher already
        // uses and is not bound by CORS.
        //
        // Bounded by what is LEFT of the mirror budget, not by fetchPdf's default hour.
        // That default exists so a human can solve a publisher captcha; no human is
        // involved here, and inheriting it let a single mirror hold a tab open for an hour
        // inside a phase that is supposed to last ninety seconds.
        // Checked AFTER the resolver, not just before it: libgenPdfUrl walks several hops of
        // its own, so the budget that was sufficient when this source started can be gone by
        // the time there is a url to fetch. A budget of ~0 still opens a tab, fails its first
        // poll and closes it -- a window that flashes at the user for no reason.
        const remaining = mirrorDeadline - Date.now();
        if (remaining < MIRROR_HOST_MIN_MS) {
          return { ok: false, error: 'mirror phase budget exhausted' };
        }
        const out = await fetchPdf({
          url: u,
          referer: `https://${new URL(u).host}/`,
          budgetMs: remaining,
        });
        return out.ok && out.base64
          ? { ok: true, base64: out.base64, bytes: out.bytes }
          : { ok: false, error: out.error || 'libgen produced no pdf' };
      }],
    ];
    // A confirmed hit goes to the front of its own phase; everything else keeps its measured
    // order behind it.
    const promoted = ladder.filter(([name]) => hints.has[name])
      .concat(ladder.filter(([name]) => !hints.has[name]));
    for (const [name, run] of promoted) {
      // Headroom, not a bare comparison. With 1ms left a bare `> mirrorDeadline` still lets
      // a source START, and annas/libgen then run their own independent 45s budgets and open
      // tabs the whole way -- so the phase overran by minutes while the user watched mirror
      // tabs keep appearing. A source that cannot finish is not worth beginning.
      if (Date.now() + MIRROR_HOST_MIN_MS > mirrorDeadline) {
        attempts.push({ source: name, error: 'skipped: mirror phase budget exhausted' });
        continue;
      }
      if (parked[name]) {
        const mins = Math.ceil((parked[name] - Date.now()) / 60000);
        attempts.push({ source: name, error: `skipped: last attempt hit a global outage (${mins}m left)` });
        continue;
      }
      if (!hintFailed && hints.ruledOut.includes(name)) {
        attempts.push({ source: name, error: 'skipped: the probe ruled it out' });
        continue;
      }
      try {
        const r = await run();
        if (r.ok && r.buf) return deliver(name, 'mirror', r.buf);
        // The tab path returns base64 already encoded rather than an ArrayBuffer.
        if (r.ok && r.base64) {
          return { ok: true, source: name, url: 'mirror', base64: r.base64, bytes: r.bytes, attempts };
        }
        attempts.push({ source: name, error: r.error || 'no pdf' });
        await parkSource(name, r.error);
      } catch (err) {
        attempts.push({ source: name, error: `${err.name}: ${err.message}` });
        await parkSource(name, `${err.name}: ${err.message}`);
      }
      if (hints.has[name]) hintFailed = true;
    }
    }
  } finally {
    // On EVERY exit, including the returns that deliver a pdf. A ceiling left set would
    // bound the next call's mirror phase to this call's deadline -- already in the past --
    // so mirrors would be skipped wholesale for the rest of the worker's life.
    // Release THIS call's deadline, not every live one: a second retrieval may still be
    // inside its own mirror phase, and clearing the lot would un-bound it.
    clearMirrorPhaseDeadline(mirrorDeadline);
  }
  // ---8<--- end mirror phase ---8<---

  // PHASE 2 -- cheap and parallel: a direct url the caller already has, plus every OA API.
  // None of these opens a tab or involves a human.
  const cheap = [];
  if (pdfUrl && urlTier(pdfUrl) !== TIER.NONE) cheap.push({ source: 'direct', url: pdfUrl });
  // A refused url must SAY it was refused. Dropped silently, a pasted link to a host the
  // extension does not carry ends as a bare "no source produced a valid pdf" with an empty
  // attempts log, which reads as "the paper does not exist" rather than "I will not go there".
  else if (pdfUrl) attempts.push({ source: 'direct', error: 'host not allowlisted' });
  if (doi && email) {
    try {
      for (const c of await resolveOaCandidates(doi, { email, coreApiKey })) {
        if (c.pdfUrl && urlTier(c.pdfUrl) !== TIER.NONE) {
          cheap.push({ source: c.source, url: c.pdfUrl });
        }
      }
    } catch (err) {
      attempts.push({ source: 'oa', error: `${err.name}: ${err.message}` });
    }
  }
  const raced = await Promise.all(cheap.map(async (c) => {
    const r = await fetchValidatedPdf(c.url);
    if (!r.ok) attempts.push({ source: c.source, error: r.error });
    return r.ok ? { ...c, buf: r.buf } : null;
  }));
  const oaWin = raced.find(Boolean);
  if (oaWin) return deliver(oaWin.source, oaWin.url, oaWin.buf);

  // PHASE 3 -- the publisher that owns this DOI, if any. May open a tab, may wait on a human.
  if (doi) {
    const entry = await findPublisher(doi, pdfUrl || null).catch(() => null);
    if (entry) {
      try {
        const id = entry.resolveId
          ? await entry.resolveId(doi, pdfUrl || null, {})
          : entry.extractId(doi, pdfUrl || null);
        if (id) {
          const landing = entry.landingUrl(id);
          const direct = entry.pdfUrl(id);
          const out = direct
            ? await fetchPdf({ url: direct, referer: landing })
            // No constructible pdf url (Mendeley, OUP, ACS): read the link out of the
            // rendered page, then fetch it down the ordinary path.
            : await (async () => {
              const links = await fetchLinks({ url: landing });
              if (!links.ok || !links.links.length) {
                return { ok: false, error: links.error || 'no pdf links on the page' };
              }
              const pick = entry.preferPdfLink
                ? links.links.find((l) => entry.preferPdfLink.test(l))
                : links.links[0];
              return pick
                ? fetchPdf({ url: pick, referer: landing })
                : { ok: false, error: 'no link matched this publisher' };
            })();
          if (out.ok && out.base64) {
            return { ok: true, source: entry.name, url: direct || landing,
              base64: out.base64, bytes: out.bytes, attempts };
          }
          attempts.push({ source: entry.name, error: out.error || 'publisher produced no pdf' });
        } else {
          attempts.push({ source: entry.name, error: 'could not resolve an identifier' });
        }
      } catch (err) {
        attempts.push({ source: entry.name, error: `${err.name}: ${err.message}` });
      }
    }
  }

  return { ok: false, error: 'no source produced a valid pdf', attempts };
}

/** Fetch a url and accept it only if the bytes really are a pdf. Never throws. */
async function fetchValidatedPdf(url, { timeoutMs = 25000 } = {}) {
  const credentials = credentialsFor(url);
  if (credentials === null) return { ok: false, error: 'host not allowlisted' };
  try {
    const res = await fetch(url, { credentials, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, error: `http ${res.status}` };
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_PDF_BYTES) {
      return { ok: false, error: `too large (${declared})` };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_PDF_BYTES) return { ok: false, error: 'too large' };
    if (buf.byteLength < 5) return { ok: false, error: `too short (${buf.byteLength})` };
    const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 5));
    if (magic !== '%PDF-') return { ok: false, error: `not a pdf (${JSON.stringify(magic)})` };
    return { ok: true, buf, bytes: buf.byteLength };
  } catch (err) {
    return { ok: false, error: `${err.name}: ${err.message}` };
  }
}

async function fetchLinks({ url, budgetMs }) {
  // urlTier, not isAllowedUrl: the latter answers only for the CREDENTIALED grant, so an
  // anonymous-tier host (a mirror, an OA repository) was refused as unlisted despite being
  // granted. The credentials themselves are still derived per-url inside the fetch, so
  // widening the gate here does not widen what is sent.
  if (urlTier(url) === TIER.NONE) return { ok: false, error: 'host not allowlisted' };
  const origin = new URL(url).origin;

  return withClearedTab(url, async (tabId, deadline, expectedOrigin) => {
    const hydrationDeadline = Date.now() + HYDRATION_TIMEOUT_MS;
    // Poll rather than read once: the page hydrates after load, so the first read
    // legitimately finds nothing. Bounded by the same challenge budget the clear
    // used, so the total stays under the callers' timeouts.
    for (;;) {
      let raw = [];
      try {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId },
          func: inPagePdfLinks,
          args: [MAX_RAW_LINKS, MAX_LINK_CHARS],
        });
        if (r && Array.isArray(r.result)) raw = r.result;
      } catch {
        // Tab navigating (the hydration can replace the document); retry.
      }
      const links = [];
      for (const href of raw) {
        if (links.length >= MAX_LINKS) break;
        if (typeof href !== 'string' || href.length > MAX_LINK_CHARS) continue;
        let u;
        try {
          u = new URL(href);
        } catch {
          continue;
        }
        if (u.origin !== origin) continue;
        if (!isAllowedUrl(href)) continue;
        if (links.includes(href)) continue;
        links.push(href);
      }
      if (links.length > 0) return { ok: true, links };
      // `deadline` is the hour-long human budget, far too long to bound hydration polling:
      // this loop would spin for an hour with no error and nothing to diagnose. Hydration
      // is a page finishing its own render, which no human is involved in, so it gets its
      // own much shorter budget.
      if (Date.now() > hydrationDeadline) {
        // Nothing matched. Report how the page represents its files at all -- a dataset
        // page may expose them as buttons or non-.pdf urls, and the filter cannot be
        // fixed without seeing what is actually there.
        let shape = null;
        try {
          const [sr] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => ({
              anchors: document.querySelectorAll('a[href]').length,
              buttons: document.querySelectorAll('button').length,
              // COUNTS ONLY. These used to return 12 arbitrary hrefs, plus anchor text for
              // anything pdf-ish and every download button's label -- read from a page
              // opened with the user's cookies, and sent over the socket into the desktop
              // app's logs. A publisher URL routinely carries a session token in its query
              // string, so that was an exfiltration path, and it contradicted this file's
              // own promise of "only URLs, never text" a few hundred lines up. The counts
              // answer the only question the diagnostic is for: did the page render links
              // at all, and did any of them look like a download.
              anchorCount: document.querySelectorAll('a[href]').length,
              pdfishCount: Array.from(document.querySelectorAll('a[href]'))
                .filter((a) => /pdf/i.test(a.href)).length,
              downloadishCount: Array.from(document.querySelectorAll('a,button'))
                .filter((e) => /download/i.test(e.textContent || '')).length,
            }),
          });
          shape = sr && sr.result;
        } catch (e) {
          shape = { shapeFailed: `${e.name}: ${e.message}` };
        }
        let probe = null;
        try {
          const [pr] = await chrome.scripting.executeScript({ target: { tabId }, func: inPageProbe });
          probe = pr && pr.result;
        } catch (e) {
          probe = { probeFailed: `${e.name}: ${e.message}` };
        }
        return {
          ok: false,
          error: `no same-origin pdf links appeared in ${HYDRATION_TIMEOUT_MS} ms `
            + `(raw hrefs seen: ${raw.length}) SHAPE=${JSON.stringify(shape)} `
            + `PAGE=${JSON.stringify(probe)}`,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, CHALLENGE_POLL_MS));
    }
  }, budgetMs);
}

/** Emits the header message, then the base64 body as CHUNK_CHARS-sized frames. */
function sendResult(port, id, result) {
  if (!result.ok) {
    port.postMessage({ type: 'fetch_pdf_result', id, ok: false, error: result.error });
    return;
  }
  const { base64, bytes } = result;
  const chunks = Math.ceil(base64.length / CHUNK_CHARS);
  port.postMessage({ type: 'fetch_pdf_result', id, ok: true, bytes, chunks });
  for (let seq = 0; seq < chunks; seq += 1) {
    port.postMessage({
      type: 'fetch_pdf_chunk',
      id,
      seq,
      base64: base64.slice(seq * CHUNK_CHARS, (seq + 1) * CHUNK_CHARS),
    });
  }
}

// MV3 service workers idle out after ~30s, so connect lazily per request rather
// than holding a port open and assuming it survives.
let activePort = null;
// Persisted, because the worker restarts constantly under MV3 and module state does not
// survive. Without this the backoff resets to 1s on every wake, so a user who installed
// from the Web Store WITHOUT the desktop app -- the default state for most of them --
// replays 1s/2s/4s/8s/16s and a console warning on each wake, forever. session storage is
// the right scope: a browser restart genuinely is a fresh chance for the host to be there.
let reconnectDelayMs = RECONNECT_BASE_MS;
// Guarded against overwriting a NEWER value. This read resolves a microtask after the
// top-level connect(), so a disconnect can already have doubled the delay by the time it
// lands -- applying the persisted value then would walk the backoff backwards. Only ever
// raise it, which is the direction that matters: the point is not to hammer a host that
// is not there.
chrome.storage?.session?.get('reconnectDelayMs').then((v) => {
  if (Number.isFinite(v?.reconnectDelayMs) && v.reconnectDelayMs > reconnectDelayMs) {
    reconnectDelayMs = v.reconnectDelayMs;
  }
}).catch(() => { /* first run, or storage unavailable */ });
let reconnectTimer = null;

function scheduleReconnect() {
  const delay = reconnectDelayMs;
  // Capped exponential backoff. Without the cap this hammers connectNative once
  // a second forever whenever the host is not installed, which is the default
  // state on any machine that has only loaded the extension.
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
  chrome.storage?.session?.set({ reconnectDelayMs }).catch(() => {});
  // An alarm is ALWAYS armed, whatever the delay. A setTimeout dies with the service
  // worker, and MV3 kills the worker after ~30s idle -- so on the common path (a
  // connection that succeeded once, leaving reconnectDelayMs at 1s) a later teardown
  // scheduled a timeout that was never going to fire. Nothing else would wake the worker,
  // and the bridge stayed dead until the browser restarted, which the user experiences as
  // "Chrome is closed" forever. The alarm is the only wake source that survives.
  //
  // Chrome clamps alarms to 30s minimum (60s before Chrome 120), so a sub-30s delay still
  // fires late. Late is survivable; never is not.
  // Armed BEFORE the pending-timer check, not after. Returning early when a fast retry was
  // already queued skipped the alarm entirely -- and connect() clears the alarm on success,
  // so a "retry pending -> connect succeeds -> port drops -> worker dies" sequence left no
  // wake source at all. That is the original bug, reachable through a different door.
  chrome.alarms.create(RECONNECT_ALARM, {
    delayInMinutes: Math.max(delay, ALARM_MIN_MS) / 60000,
  });
  if (reconnectTimer !== null) return;
  if (delay < ALARM_MIN_MS) {
    // Race the alarm for the fast retries, so a transient failure recovers in a second
    // rather than in thirty -- while the alarm above still covers a worker death.
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }
}

function connect() {
  if (activePort) return;
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (err) {
    console.warn('connectNative failed:', err.message);
    scheduleReconnect();
    return;
  }
  activePort = port;
  // A pending alarm from an earlier failure would otherwise fire against a live
  // port and be a no-op, but clearing keeps the wake schedule honest.
  chrome.alarms.clear(RECONNECT_ALARM);
  // A RECURRING heartbeat, armed once a connection is live.
  //
  // Every alarm scheduleReconnect creates is one-shot, and connect() clears it on success --
  // so a healthy extension had NO armed wake source at all. That is survivable only while
  // the worker lives, and MV3 evicts an idle worker holding a native port: the port dies
  // with no listener alive to see it, onDisconnect never runs, and nothing reschedules.
  // The bridge is then dead until the browser restarts, which is the exact failure the
  // reconnect work set out to end -- reachable through idle eviction rather than through
  // the early-return that was fixed first.
  //
  // connect() is a no-op when the port is already alive, so a periodic wake costs nothing.
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
  // The pending fast-retry has to go too. It was never cleared, so a timer left over from
  // a previous failure kept scheduleReconnect returning early forever -- meaning the next
  // real disconnect queued no timeout of its own.
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  port.onMessage.addListener(async (msg) => {
    // Traffic proves the host is alive, so stop treating it as unreachable.
    reconnectDelayMs = RECONNECT_BASE_MS;
    chrome.storage?.session?.set({ reconnectDelayMs }).catch(() => {});
    if (!msg) return;

    // Reload the extension so a code change takes effect without the user going to
    // chrome://extensions. chrome.runtime.reload() restarts THIS extension only -- the
    // browser, its windows and every other extension are untouched. The port drops as a
    // result, which the host reads as a disconnect and the reconnect logic handles.
    if (msg.type === 'reload_extension') {
      try {
        port.postMessage({ type: 'reload_extension_result', id: msg.id, ok: true });
      } catch {
        // The port is about to go anyway.
      }
      setTimeout(() => chrome.runtime.reload(), 50);
      return;
    }

    if (msg.type === 'download') {
      const out = await runDownload(msg);
      try {
        port.postMessage({ type: 'download_result', id: msg.id, ...out });
      } catch (err) {
        console.warn('failed to deliver download result:', err.message);
      }
      return;
    }

    if (msg.type === 'retrieve') {
      // The full ladder, in one worker: OA APIs race first, then the ten publishers (which
      // may open a tab and may need a human), then mirrors last so an unsigned mirror copy
      // cannot displace the authentic publisher file.
      let payload;
      try {
        const out = await retrievePaper(msg);
        payload = out.ok
          ? { type: 'retrieve_result', id: msg.id, ok: true, source: out.source, url: out.url,
            base64: out.base64, bytes: out.bytes, attempts: out.attempts }
          : { type: 'retrieve_result', id: msg.id, ok: false, error: out.error, attempts: out.attempts };
      } catch (err) {
        payload = { type: 'retrieve_result', id: msg.id, ok: false, error: `${err.name}: ${err.message}` };
      }
      try {
        port.postMessage(payload);
      } catch (err) {
        console.warn('failed to deliver retrieval result:', err.message);
      }
      return;
    }

    if (msg.type === 'search') {
      // Search runs entirely in the worker: every endpoint is a plain JSON or Atom API on
      // the anonymous tier, so no tab and no page is involved. Errors are reported per
      // source rather than thrown, so one database being down costs its own results and
      // not the whole query.
      let payload;
      try {
        // Scholar is handled HERE rather than in searchAll: it needs a tab and
        // chrome.scripting, which the inlined fetch-only adapters have no access to.
        const wanted = Array.isArray(msg.sources) ? msg.sources : null;
        const wantsScholar = !wanted || wanted.includes('scholar');
        const fetchSources = wanted ? wanted.filter((x) => x !== 'scholar') : null;
        // .catch attached AT CREATION, not at the await. If searchAll rejects below, this
        // promise is never awaited, and an unhandled rejection in a worker is a silent
        // death indistinguishable from Chrome being closed.
        const scholarPromise = wantsScholar
          ? searchScholar({
            query: msg.query,
            maxResults: msg.limit || 25,
            page: msg.page || 1,
            filters: msg.filters && typeof msg.filters === 'object' ? msg.filters : {},
          }).catch((err) => ({ source: 'scholar', error: `${err.name}: ${err.message}`, results: [] }))
          : null;
        const groups = await searchAll(fetchSources, {
          query: msg.query,
          maxResults: msg.limit || 25,
          page: msg.page || 1,
          filters: msg.filters && typeof msg.filters === 'object' ? msg.filters : {},
        });
        if (scholarPromise) groups.push(await scholarPromise);
        payload = { type: 'search_result', id: msg.id, ok: true, groups };
      } catch (err) {
        payload = { type: 'search_result', id: msg.id, ok: false, error: `${err.name}: ${err.message}` };
      }
      try {
        port.postMessage(payload);
      } catch (err) {
        console.warn('failed to deliver search results:', err.message);
      }
      return;
    }

    // Wrapped because an unhandled rejection in this listener kills the service worker,
    // and a dead worker is indistinguishable from a closed browser to the desktop app.
    // fetchLinks can throw before it reaches its own try -- new URL(url) on a malformed
    // url -- and fetchPdf likewise.
    if (msg.type === 'fetch_links') {
      // Small reply, so no chunking: one result frame carries the whole array.
      let result;
      try {
        result = await fetchLinks(msg);
      } catch (err) {
        result = { ok: false, error: `${err.name}: ${err.message}` };
      }
      try {
        port.postMessage(
          result.ok
            ? { type: 'fetch_links_result', id: msg.id, ok: true, links: result.links }
            : { type: 'fetch_links_result', id: msg.id, ok: false, error: result.error }
        );
      } catch (err) {
        console.warn('failed to deliver links:', err.message);
      }
      return;
    }

    if (msg.type !== 'fetch_pdf') return;
    // Same reasoning as fetch_links above: a throw here is a silent worker death.
    let result;
    try {
      result = await fetchPdf(msg);
    } catch (err) {
      result = { ok: false, error: `${err.name}: ${err.message}` };
    }
    try {
      sendResult(port, msg.id, result);
    } catch (err) {
      // A throw partway through the chunk loop leaves the host waiting for
      // frames counted in the header, so tell it to give up on this id. If the
      // port itself is dead this throws too, and onDisconnect covers the host.
      console.warn('failed to deliver result:', err.message);
      try {
        port.postMessage({ type: 'fetch_pdf_abort', id: msg.id, error: err.message });
      } catch {
        // Port is gone; the host sees onDisconnect.
      }
    }
  });

  port.onDisconnect.addListener(() => {
    // Host exited, was never installed, or Chrome tore down the worker.
    const err = chrome.runtime.lastError;
    if (err) console.warn('native host disconnected:', err.message);
    if (activePort === port) activePort = null;
    scheduleReconnect();
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  // Both wake sources call the same thing: connect() is a no-op when a port is already
  // alive, so the heartbeat costs nothing while healthy and revives an evicted worker.
  if (alarm.name === RECONNECT_ALARM || alarm.name === HEARTBEAT_ALARM) connect();
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// Alarms this extension registered under its previous name.
//
// Alarms survive an extension update, and the names are the only handle on them. After the
// rename the old pair keeps firing on a worker whose onAlarm no longer matches them, so they
// wake it for nothing and never clear themselves. Clearing by name is idempotent and costs
// one call on a name that is already gone.
// Not `.catch()` on the result: clear() is callback-style as well as promise-returning
// depending on how it is reached, so assuming a thenable here throws at TOP LEVEL and takes
// the whole worker down with it -- registration included.
try {
  for (const stale of ['paper-bridge-reconnect', 'paper-bridge-heartbeat']) {
    chrome.alarms.clear(stale);
  }
} catch { /* nothing to clear, or no alarms permission */ }

// ---8<--- search sources (inlined) ---8<---
// Inlined rather than imported: background.js is a CLASSIC service worker, so a dynamic
// import() throws at runtime -- and a worker that throws while handling a message dies
// silently, taking the bridge socket with it. That failure already cost several reload
// cycles once. chrome-extension/search-sources.js remains the editable copy and is what the
// tests import; tests/search-parity.test.mjs asserts the two stay identical.

// Every source returns this shape, so a caller never branches on which database answered.
// Fields a given source cannot supply are null rather than absent, so consumers can read
// them without guarding.
/**
 * @typedef {object} SearchResult
 * @property {string} title
 * @property {string|null} doi
 * @property {string|null} url          landing page
 * @property {string|null} pdfUrl       direct PDF when the source names one
 * @property {string[]} authors
 * @property {string|null} year
 * @property {string|null} abstract
 * @property {string} source            which database answered
 */

const SSRN_PAGE_SIZE = 50;

/**
 * A search's filters. Every field is optional; an absent one is not sent upstream.
 *
 * `unsupported` on a result group is what makes these honest: an index that cannot express
 * a filter says so, and the caller applies it locally rather than believing the upstream
 * already did. Filtering after the fact discards most of a page, so the difference matters.
 *
 * @typedef {object} SearchFilters
 * @property {string} [author]      one name; SSRN cannot express this (400)
 * @property {number} [yearFrom]
 * @property {number} [yearTo]
 * @property {boolean} [titleOnly]  restrict matching to the title
 * @property {string} [doi]         exact identifier lookup, bypassing text search
 */

/** ISO date for a year bound, or null. Crossref wants full dates, not bare years. */
function isoFrom(year) {
  return Number.isFinite(year) ? `${String(year).padStart(4, '0')}-01-01` : null;
}
function isoTo(year) {
  return Number.isFinite(year) ? `${String(year).padStart(4, '0')}-12-31` : null;
}

/**
 * Fetch JSON through the tier resolver.
 *
 * Never throws: a search source that is down must cost its own result set and nothing
 * else, because sources are queried together and one 503 should not empty the page.
 */
async function getJson(url) {
  const credentials = credentialsFor(url);
  if (credentials === null) return { ok: false, error: 'host not allowlisted' };
  try {
    const res = await fetch(url, { credentials, headers: { accept: 'application/json' } });
    if (!res.ok) return { ok: false, error: `http ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: `${err.name}: ${err.message}` };
  }
}

/** Fetch text through the tier resolver. Same never-throw contract as getJson. */
async function getText(url) {
  const credentials = credentialsFor(url);
  if (credentials === null) return { ok: false, error: 'host not allowlisted' };
  try {
    const res = await fetch(url, { credentials });
    if (!res.ok) return { ok: false, error: `http ${res.status}` };
    return { ok: true, data: await res.text() };
  } catch (err) {
    return { ok: false, error: `${err.name}: ${err.message}` };
  }
}

/**
 * The earliest four-digit year among several date strings, as a string.
 *
 * Exists because PubMed's dates disagree with each other; see the call site.
 */
function earliestYear(...dates) {
  const years = dates
    .map((d) => ((typeof d === 'string' ? d : '').match(/\d{4}/) || [])[0])
    .filter(Boolean)
    .map(Number)
    .filter((y) => y >= 1500 && y <= 2200);
  return years.length ? String(Math.min(...years)) : null;
}

/** Strip the <em> tags SSRN wraps around query matches, and any other markup. */
function stripTags(s) {
  return typeof s === 'string' ? s.replace(/<[^>]*>/g, '').trim() : '';
}

/**
 * Pull one XML element's text content, without a DOM.
 *
 * Deliberately small and deliberately not a parser. arXiv's Atom is machine-generated and
 * regular, and the fields wanted here are flat -- writing or bundling an XML parser to read
 * five fields would be more code and more risk than this. If arXiv ever nests these, this
 * returns null rather than wrong data, because the pattern simply stops matching.
 */
function xmlText(xml, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (!m) return null;
  const text = m[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

// --- SSRN ----------------------------------------------------------------------------

/**
 * SSRN via its own JSON API.
 *
 * `accept: application/json` is REQUIRED and is the one header that genuinely matters --
 * without it the API answers XML. That was true for the Python client and is still true
 * here, so it is set explicitly rather than left to the default.
 */
async function searchSsrn(query, maxResults, page, filters = {}) {
  const wanted = Math.min(maxResults, SSRN_PAGE_SIZE);
  const u = new URL('https://api.ssrn.com/papers/v1/papers/search/advanced');
  // SSRN answers 500 for a long `text`: measured 240 chars fine, 300 a server error. A
  // truncated query returns something useful; an untruncated one returns nothing at all.
  u.searchParams.set('text', query.length > 240 ? query.slice(0, 240) : query);
  // Measured 2026-07-28: text_fields=title narrows the same query from 10,000 to 3,835,
  // so the title restriction is real rather than cosmetic.
  u.searchParams.set('text_fields', filters.titleOnly ? 'title' : 'title-abstract-keywords');
  u.searchParams.set('search_mode', 'fuzzy');
  u.searchParams.set('page', String(page));
  // SSRN expresses recency as named windows, not as a range, so an explicit yearFrom can
  // only be approximated. Anything narrower is left to the caller's local filter.
  const yearsBack = Number.isFinite(filters.yearFrom)
    ? new Date().getFullYear() - filters.yearFrom
    : null;
  u.searchParams.set(
    'date',
    yearsBack !== null && yearsBack <= 1 ? 'last_year'
      : yearsBack !== null && yearsBack <= 3 ? 'last_3_years'
        : 'all_time',
  );

  const res = await getJson(u.toString());
  if (!res.ok) return { source: 'ssrn', error: res.error, results: [], unsupported: ['author'] };

  const rows = res.data?.papers || res.data?.data || [];
  const results = rows.slice(0, wanted).map((p) => ({
    // The API marks query matches with <em>; a title carrying markup would be stored and
    // displayed verbatim, so it is stripped at the boundary rather than at every consumer.
    title: stripTags(p.title),
    doi: p.doi || (p.id ? `10.2139/ssrn.${p.id}` : null),
    url: p.id ? `https://papers.ssrn.com/sol3/papers.cfm?abstract_id=${p.id}` : null,
    pdfUrl: null,
    authors: Array.isArray(p.authors)
      // full_name is the field SSRN actually sends; `name`/`first_name` were a guess and
      // produced an EMPTY author list on every row, which also made the local author filter
      // reject everything. Measured: [{"id":502167,"full_name":"Lei Gao"}, ...].
      ? p.authors
        .map((a) => stripTags(a.full_name || a.name || `${a.first_name || ''} ${a.last_name || ''}`))
        .filter(Boolean)
      : [],
    year: p.approved_date ? String(p.approved_date).slice(0, 4) : null,
    // SSRN hosts working papers, so there is no journal to report. `downloads` is the only
    // popularity signal it sends and is NOT a citation count, so it is deliberately not
    // mapped to one -- a download total shown as citations would misrepresent the paper.
    venue: null,
    citationCount: null,
    // SSRN sends NO `abstract` field -- measured, 0 of 50 rows have the key while 50 of 50
    // have `snippets`, an array of <em>-marked excerpts matching the query. Reading
    // p.abstract left every SSRN record blank, the same bug class as reading `name`
    // instead of `full_name` for authors.
    abstract: Array.isArray(p.snippets) && p.snippets.length
      ? stripTags(p.snippets.join(' ')) || null
      : null,
    source: 'ssrn',
  }));
  // author stays unsupported, and folding the name into `text` was tried and rejected.
  // Measured: text_fields=author/authors/all are all 400, and putting a surname in the text
  // query matches TITLES rather than author lists -- "Damodaran" returns papers about his
  // method, including "The Impact of the Damodar Valley Project", while adding "Han" to a
  // topic query narrowed 10,000 hits to 1,060 without changing how many of the top rows
  // actually carry that author. Pushing it up would look like it worked and quietly return
  // papers ABOUT someone instead of BY them, which is worse than filtering locally.
  const unsupported = ['author'];
  if (Number.isFinite(filters.yearTo) || (yearsBack !== null && yearsBack > 3)) {
    unsupported.push('year');
  }
  return { source: 'ssrn', results, unsupported };
}

// --- arXiv ---------------------------------------------------------------------------

/**
 * arXiv via its Atom API.
 *
 * https works even though the documentation advertises http (verified 2026-07-28, identical
 * response). That matters: the allowlist refuses non-https, so the documented URL would
 * have been unusable from here.
 */
async function searchArxiv(query, maxResults, page, filters = {}) {
  const u = new URL('https://export.arxiv.org/api/query');
  // Field prefixes and a submittedDate range, both confirmed live against the API.
  // Quotes are STRIPPED, not escaped. JSON.stringify turns `say "hi"` into
  // `"say \"hi\""` and arXiv answers 400 -- so a quoted phrase, the most natural academic
  // query, silently removed arXiv from every search. Measured: escaped inner quotes 400,
  // a plain quoted phrase 200.
  const quote = (v) => `"${String(v).replace(/["\\]/g, ' ').trim()}"`;
  const terms = [`${filters.titleOnly ? 'ti' : 'all'}:${quote(query)}`];
  if (filters.author) terms.push(`au:${quote(filters.author)}`);
  const from = Number.isFinite(filters.yearFrom) ? `${filters.yearFrom}0101` : null;
  const to = Number.isFinite(filters.yearTo) ? `${filters.yearTo}1231` : null;
  if (from || to) {
    terms.push(`submittedDate:[${from || '19910101'} TO ${to || '20991231'}]`);
  }
  u.searchParams.set('search_query', terms.join(' AND '));
  u.searchParams.set('start', String((page - 1) * maxResults));
  u.searchParams.set('max_results', String(maxResults));

  const res = await getText(u.toString());
  if (!res.ok) return { source: 'arxiv', error: res.error, results: [] };

  const entries = res.data.split('<entry>').slice(1);
  const results = entries.map((e) => {
    const id = xmlText(e, 'id');
    const absId = id ? id.replace(/^https?:\/\/arxiv\.org\/abs\//, '') : null;
    const doiTag = xmlText(e, 'arxiv:doi');
    return {
      title: xmlText(e, 'title') || '',
      // arXiv preprints usually have no journal DOI, so fall back to arXiv's own DOI
      // namespace, which resolves and gives every result a stable identifier.
      doi: doiTag || (absId ? `10.48550/arXiv.${absId.replace(/v\d+$/, '')}` : null),
      url: id,
      pdfUrl: absId ? `https://arxiv.org/pdf/${absId}` : null,
      // Present once a preprint has appeared somewhere; absent while it is only on arXiv.
      venue: xmlText(e, 'arxiv:journal_ref'),
      citationCount: null,
      authors: (e.match(/<name>([^<]*)<\/name>/g) || [])
        .map((n) => n.replace(/<\/?name>/g, '').trim())
        .filter(Boolean),
      year: (xmlText(e, 'published') || '').slice(0, 4) || null,
      abstract: xmlText(e, 'summary'),
      source: 'arxiv',
    };
  }).filter((r) => r.title);
  return { source: 'arxiv', results };
}

// --- PubMed --------------------------------------------------------------------------

/**
 * PubMed via NCBI eutils: esearch for ids, then esummary for the records.
 *
 * Two round trips is how the API works -- esearch returns only PMIDs. They are sequential
 * by necessity, so a failure in the first short-circuits rather than issuing a second
 * request with nothing to ask for.
 */
async function searchPubmed(query, maxResults, page, filters = {}) {
  const s = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi');
  s.searchParams.set('db', 'pubmed');
  // eutils field tags, confirmed live: [au] for author, [dp] for a date range, [ti] to
  // restrict to the title.
  const parts = [filters.titleOnly ? `${query}[ti]` : query];
  if (filters.author) parts.push(`${filters.author}[au]`);
  if (Number.isFinite(filters.yearFrom) || Number.isFinite(filters.yearTo)) {
    parts.push(`${filters.yearFrom || 1800}:${filters.yearTo || 3000}[dp]`);
  }
  s.searchParams.set('term', parts.join(' AND '));
  s.searchParams.set('retmax', String(maxResults));
  s.searchParams.set('retstart', String((page - 1) * maxResults));
  s.searchParams.set('retmode', 'json');

  const ids = await getJson(s.toString());
  if (!ids.ok) return { source: 'pubmed', error: ids.error, results: [] };
  const idList = ids.data?.esearchresult?.idlist || [];
  if (idList.length === 0) return { source: 'pubmed', results: [] };

  const sum = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi');
  sum.searchParams.set('db', 'pubmed');
  sum.searchParams.set('id', idList.join(','));
  sum.searchParams.set('retmode', 'json');

  const recs = await getJson(sum.toString());
  if (!recs.ok) return { source: 'pubmed', error: recs.error, results: [] };

  const uids = recs.data?.result?.uids || [];
  const results = uids.map((uid) => {
    const r = recs.data.result[uid] || {};
    const doi = (r.articleids || []).find((a) => a.idtype === 'doi')?.value || null;
    return {
      title: stripTags(r.title),
      doi,
      url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
      pdfUrl: null,
      // Both were being dropped though esummary sends them, and Corpus Studio's record has
      // fields for both: fulljournalname e.g. "Frontiers in plant science", pmcrefcount the
      // PMC citation count.
      venue: r.fulljournalname || r.source || null,
      citationCount: Number.isFinite(r.pmcrefcount) ? r.pmcrefcount : null,
      authors: (r.authors || []).map((a) => a.name).filter(Boolean),
      // PubMed carries THREE dates -- pubdate (print), epubdate (electronic) and
      // sortpubdate -- and [dp] matches ANY of them. Measured: a row answering 2021:2023
      // can print in 2025 with epubdate 2023, and another prints 2023 with epubdate 2026.
      // So neither field alone is "the" year, and picking one made in-range papers look
      // out of range either way. The EARLIEST is reported, because that is when the work
      // first appeared and it is the bound a reader means by "published before".
      year: earliestYear(r.epubdate, r.pubdate, r.sortpubdate),
      // esummary carries no abstract; efetch would, at another round trip per search.
      // Left null rather than paid for, since consumers treat it as optional.
      abstract: null,
      source: 'pubmed',
    };
  }).filter((r) => r.title);
  return { source: 'pubmed', results };
}

// --- bioRxiv -------------------------------------------------------------------------

/**
 * bioRxiv, searched through Crossref.
 *
 * bioRxiv's own API cannot do this. It addresses papers by DOI or by date interval and has
 * no text search at all, and the interval endpoint pages 30 rows at a time over 376,724
 * records (measured 2026-07-28) -- so "fetch recent postings and filter locally" finds
 * nothing for almost any query. That was the first implementation and it returned zero
 * results against the live API, which is precisely the silent failure the live check exists
 * to catch: no error, just an empty page.
 *
 * Crossref indexes bioRxiv and does have real query support. Preprints are typed
 * `posted-content`, which is what separates them from the Cold Spring Harbor JOURNALS that
 * share the 10.1101 prefix (verified: those journal hits are absent from bioRxiv's own API,
 * and a posted-content hit is present in it).
 *
 * The two filters must be split, which is not obvious and was found by measurement.
 * Combining them (`prefix:10.1101,type:posted-content`) collapses a query from 43,230 hits
 * to 1 -- a Crossref quirk, not a real narrowing. Filtering by PREFIX server-side and type
 * client-side fails differently and worse: relevance ranking fills the whole first page
 * with CSH journal articles, so the client-side pass sees zero preprints and the source
 * silently returns nothing. So: type server-side, prefix client-side.
 */
async function searchBiorxiv(query, maxResults, filters = {}) {
  const u = new URL('https://api.crossref.org/works');
  // Crossref splits the query by field and the date bounds into `filter`, both measured.
  if (filters.titleOnly) u.searchParams.set('query.bibliographic', query);
  else u.searchParams.set('query', query);
  if (filters.author) u.searchParams.set('query.author', filters.author);
  const filterParts = ['type:posted-content'];
  const from = isoFrom(filters.yearFrom);
  const to = isoTo(filters.yearTo);
  if (from) filterParts.push(`from-pub-date:${from}`);
  if (to) filterParts.push(`until-pub-date:${to}`);
  u.searchParams.set('filter', filterParts.join(','));
  // Over-fetch: posted-content spans every preprint server, and only the 10.1101 ones are
  // bioRxiv/medRxiv.
  // Over-fetch hard. Of 100 posted-content rows only 44/64/14/0 were 10.1101 across four
  // measured queries, so a 100 ceiling routinely returned far fewer than asked with no
  // signal. Crossref allows rows=1000.
  u.searchParams.set('rows', String(Math.min(Math.max(maxResults * 12, 100), 400)));

  const res = await getJson(u.toString());
  if (!res.ok) return { source: 'biorxiv', error: res.error, results: [] };

  const rows = (res.data?.message?.items || [])
    .filter((it) => typeof it.DOI === 'string' && it.DOI.startsWith('10.1101/'));
  const results = rows.slice(0, maxResults).map((it) => {
    const doi = it.DOI || null;
    // The 10.1101 prefix covers bioRxiv AND medRxiv, and the two do not serve each other's
    // papers: measured, a medRxiv DOI on biorxiv.org/...full.pdf is 403 while medrxiv.org
    // returns the file. Crossref names the server in institution[0].name, so use it rather
    // than assuming. A query for "covid vaccine effectiveness" was 21/21 medRxiv.
    const server = ((it.institution || [])[0]?.name || '').toLowerCase().includes('medrxiv')
      ? 'medrxiv'
      : 'biorxiv';
    return {
      title: stripTags(Array.isArray(it.title) ? it.title[0] : it.title),
      doi,
      url: doi ? `https://www.${server}.org/content/${doi}v1` : (it.URL || null),
      pdfUrl: doi ? `https://www.${server}.org/content/${doi}v1.full.pdf` : null,
      authors: (it.author || [])
        .map((a) => [a.given, a.family].filter(Boolean).join(' ').trim())
        .filter(Boolean),
      year: it.issued?.['date-parts']?.[0]?.[0]
        ? String(it.issued['date-parts'][0][0])
        : null,
      venue: it['group-title'] || (it.institution || [])[0]?.name || null,
      citationCount: Number.isFinite(it['is-referenced-by-count'])
        ? it['is-referenced-by-count']
        : null,
      // Crossref abstracts arrive as JATS XML when present at all.
      abstract: it.abstract ? stripTags(it.abstract) : null,
      source: 'biorxiv',
    };
  }).filter((r) => r.title);
  return { source: 'biorxiv', results };
}

// --- entry point ---------------------------------------------------------------------

const SEARCH_SOURCES = ['ssrn', 'arxiv', 'pubmed', 'biorxiv'];

/**
 * Query one source. Never throws; a failed source reports `error` and an empty list.
 */
async function searchOne(source, { query, maxResults = 10, page = 1, filters = {} }) {
  // A DOI is an EXACT identifier, so text-searching it is both slower and worse: Crossref
  // answers /works/<doi> directly and definitively, while a text query for the same string
  // returns whatever happens to mention it. This is checked first so every source collapses
  // to the one authoritative answer.
  const doi = filters.doi || extractDoi(query);
  if (doi) return lookupByDoi(doi, source);

  if (typeof query !== 'string' || !query.trim()) {
    return { source, error: 'empty query', results: [] };
  }
  // Per-source ceilings, measured rather than shared. SSRN_PAGE_SIZE is SSRN's own page
  // size and applying it everywhere throttled the others for no reason: arXiv served 200 in
  // one call and PubMed 500 when asked.
  const CAPS = { ssrn: SSRN_PAGE_SIZE, arxiv: 200, pubmed: 500, biorxiv: 200 };
  const n = Math.min(Math.max(1, maxResults), CAPS[source] || SSRN_PAGE_SIZE);
  switch (source) {
    case 'ssrn': return searchSsrn(query, n, page, filters);
    case 'arxiv': return searchArxiv(query, n, page, filters);
    case 'pubmed': return searchPubmed(query, n, page, filters);
    case 'biorxiv': return searchBiorxiv(query, n, filters);
    default: return { source, error: `unknown source: ${source}`, results: [] };
  }
}

/** A DOI anywhere in a string, normalised. Accepts a bare DOI, a doi.org url, or "doi:". */
function extractDoi(text) {
  if (typeof text !== 'string') return null;
  const m = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i.exec(text.trim());
  return m ? m[1].replace(/[.,;)\]]+$/, '') : null;
}

/**
 * Resolve one identifier through Crossref, which indexes every registered DOI regardless of
 * publisher. Only ONE source answers so the same paper is not returned four times.
 */
async function lookupByDoi(doi, source) {
  if (source !== 'biorxiv') return { source, results: [] };
  const res = await getJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  const it = res.ok ? res.data?.message : null;
  if (!it) return { source, error: res.ok ? 'no such DOI' : res.error, results: [] };
  return {
    source,
    results: [{
      title: stripTags(Array.isArray(it.title) ? it.title[0] : it.title),
      doi: it.DOI || doi,
      url: it.URL || `https://doi.org/${doi}`,
      pdfUrl: null,
      authors: (it.author || [])
        .map((a) => [a.given, a.family].filter(Boolean).join(' ').trim())
        .filter(Boolean),
      year: it.issued?.['date-parts']?.[0]?.[0] ? String(it.issued['date-parts'][0][0]) : null,
      abstract: it.abstract ? stripTags(it.abstract) : null,
      source: 'crossref',
    }],
  };
}

/**
 * Query several sources at once.
 *
 * Promise.all is safe here precisely because searchOne never rejects -- one database being
 * down costs its own results and nothing else.
 */
async function searchAll(sources, opts) {
  // An EMPTY array means "none of these", not "all of them". Scholar is dispatched
  // separately (it needs a tab), so asking for sources:['scholar'] leaves this an empty
  // list -- and treating that as the default set ran every fetch source anyway.
  const list = (Array.isArray(sources) ? sources : SEARCH_SOURCES)
    .filter((s) => SEARCH_SOURCES.includes(s));
  return Promise.all(list.map((s) => searchOne(s, opts)));
}

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
async function unpaywallPdfUrl(doi, { email }) {
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
async function openAlexPdfUrl(doi) {
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
async function corePdfUrl(doi, { apiKey } = {}) {
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
async function pmcPdfUrl(doi, { email }) {
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
const OA_SOURCES = ['unpaywall', 'openalex', 'pmc', 'core'];

/**
 * Resolve a DOI through every OA source at once.
 *
 * Concurrent rather than sequential: they are independent, none is authoritative, and the
 * whole point of the OA tier is that it is cheap. Returns every candidate found, in
 * OA_SOURCES order, so the caller can try them in preference order and fall through to the
 * next when one fails the %PDF- check.
 */
async function resolveOaCandidates(doi, { email, coreApiKey } = {}) {
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

// "Who has this paper?", asked of every tab-free source at once.
//
// This exists to make the DOWNLOAD faster, not to report to the user. Today a paper the
// mirrors do not have costs three sequential probe walks before open access is tried at
// all; this asks everyone simultaneously and lets the ladder skip what it can.
//
// TAB-FREE ONLY. Publishers are deliberately absent: Mendeley, OUP and ACS can answer only
// by opening a real tab, and several tabs at once is the exact behaviour the user reported
// as a bug. Five publisher resolvers also funnel through doi.org, and the extension's rate
// limiter is a no-op stub, so parallelising them would concentrate load on one host.
//
// THE HINTS ARE NOT TRUTH. `ruledOut` means a source gave a DEFINITIVE negative -- a page
// that says outright it does not hold the paper, or an OA API that resolved with no pdf. A
// timeout, a 429 or a dead host is `unknown`, never `absent`. That asymmetry is what makes
// probing unpaced safe: a false negative then costs latency, because the ladder re-checks
// everything.
//
// This file names no mirror. It is inlined OUTSIDE the store build's fence, so a mirror name
// written here would survive the strip and the build would refuse to zip; the list is read
// from the fenced module at call time and is simply absent in the store package.

/** @returns {string[]} the probeable non-OA sources, empty when that tier is not built in. */
function probeableMirrors() {
  return typeof MIRROR_PROBE_NAMES === 'undefined' ? [] : MIRROR_PROBE_NAMES;
}

/**
 * @returns {Promise<{has: Record<string,string|true>, ruledOut: string[]}>} never throws
 */
async function probeAvailability(doi, { email, coreApiKey } = {}) {
  const hints = { has: {}, ruledOut: [] };
  if (!doi) return hints;

  const names = probeableMirrors();
  const settled = await Promise.allSettled([
    resolveOaCandidates(doi, { email, coreApiKey }),
    ...names.map((name) => probeMirror(name, doi)),
  ]);

  const [oa, ...mirrors] = settled;
  if (oa.status === 'fulfilled' && Array.isArray(oa.value)) {
    for (const c of oa.value) {
      if (c && c.source && c.pdfUrl) hints.has[c.source] = c.pdfUrl;
    }
  }
  mirrors.forEach((r, i) => {
    // A rejected probe is `unknown` by omission -- see the asymmetry note above.
    if (r.status !== 'fulfilled') return;
    if (r.value === 'present') hints.has[names[i]] = true;
    else if (r.value === 'absent') hints.ruledOut.push(names[i]);
  });
  return hints;
}

// Recompress a downloaded PDF with qpdf compiled to WebAssembly, before it reaches
// the user's Downloads folder.
//
// THE FLAGS BELOW ARE A CONTRACT, NOT A STARTING POINT. Corpus Studio chose qpdf over
// ghostscript on measured evidence: across 20 test papers ghostscript MOVED ITEM
// GEOMETRY in 19 of them, while qpdf moved it in 0. Geometry is what every
// evidence-span highlight is anchored to, so an optimiser that shifts text silently
// breaks the feature the corpus exists for. Every edit qpdf declines to make -- image
// downsampling, dropping thumbnails, stripping structure trees -- is in that same
// class. Do NOT add --remove-metadata, downsampling, or anything else here without
// re-running that measurement.
//
// The slimmer is also OPTIONAL BY CONSTRUCTION: a download must never fail because an
// optimisation did. Every failure path returns the original bytes untouched, which is
// the same guard src/main/pipeline/stages/optimize.ts applies on the app side.

const QPDF_ARGS = [
  '--object-streams=generate',
  '--recompress-flate',
  '--compression-level=9',
  '--optimize-images',
  '--remove-unreferenced-resources=yes'
];

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

function looksLikePdf(bytes) {
  if (bytes.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i += 1) {
    if (bytes[i] !== PDF_MAGIC[i]) return false;
  }
  return true;
}

/**
 * Recompress `bytes`, or return `bytes` unchanged.
 *
 * NEVER throws and never returns anything but a Uint8Array: callers hand the result
 * straight to the download, so a rejection here would cost the user a paper they had
 * already waited for.
 *
 * `runQpdf` is a parameter so the decision logic below can be exercised without wasm.
 * Production callers pass one argument and get runQpdfWasm.
 */
async function slimPdf(bytes, runQpdf = runQpdfWasm) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return bytes;

  let out;
  try {
    out = await runQpdf(bytes, QPDF_ARGS);
  } catch (err) {
    console.warn('[slim-pdf] qpdf failed, keeping the original:', err && err.message);
    return bytes;
  }

  if (!(out instanceof Uint8Array) || out.length === 0) return bytes;

  // Not smaller means there was nothing to win. Handing back a LARGER file for no gain
  // is a regression, so the original stands.
  if (out.length >= bytes.length) return bytes;

  // Output that is not a PDF means the run went wrong in a way its exit code did not
  // report. Saving that would corrupt the user's file.
  if (!looksLikePdf(out)) {
    console.warn('[slim-pdf] qpdf output is not a PDF, keeping the original');
    return bytes;
  }

  return out;
}

// Pull the qpdf glue in AT TOP LEVEL, during the worker's initial evaluation.
//
// This cannot be deferred. MV3 permits importScripts ONLY while the service worker is
// first evaluating; call it later, from inside an async function, and Chrome refuses with
// "NetworkError: The script ... failed to load" even though the file is present and
// fetchable (verified: fetch of the same url returns 200 and the right 43,376 bytes).
//
// Lazy-loading it was the obvious design and it silently did nothing: slimPdf caught the
// NetworkError, returned the original bytes, and every download looked like a PDF qpdf
// could not improve. No unit test could see it, because they all inject the runner.
//
// Wrapped because a throw at top level would take the WHOLE worker down -- the ladder, the
// bridge, the popup -- to save a few kilobytes on a download. If the glue is missing,
// slimming is simply unavailable and slimPdf keeps returning originals.
try {
  self.importScripts(chrome.runtime.getURL('vendor/qpdf.js'));
} catch (err) {
  console.warn('[slim-pdf] qpdf glue did not load, downloads will not be slimmed:', err);
}

/**
 * The in-flight or settled qpdf module load. A PROMISE, not the module: two downloads
 * that overlap must share one instantiation rather than each paying for 1.3 MB of wasm.
 *
 * A FAILED load is cached too, deliberately. If wasm cannot instantiate in this browser
 * -- the CSP is wrong, the vendored files are missing, the platform refuses -- it will
 * be just as unavailable on the next download, so retrying spends seconds of every
 * subsequent paper to arrive at the same "no". One failure, then slimPdf's fallback
 * quietly keeps the originals.
 */
let qpdfModulePromise = null;

function loadQpdf() {
  if (qpdfModulePromise) return qpdfModulePromise;
  qpdfModulePromise = (async () => {
    if (typeof Module !== 'function') throw new Error('qpdf glue is not loaded');
    // The worker has no meaningful script directory, so the glue's default
    // `scriptDir + "qpdf.wasm"` resolves to nothing. locateFile must be explicit.
    return await Module({ locateFile: () => chrome.runtime.getURL('vendor/qpdf.wasm') });
  })();
  return qpdfModulePromise;
}

/**
 * Run qpdf over `bytes` in MEMFS and return what it wrote.
 *
 * THROWS on any failure. The fallback belongs to slimPdf alone -- keeping the decision
 * in one place is what makes "the original always survives" checkable.
 */
async function runQpdfWasm(bytes, args) {
  const qpdf = await loadQpdf();
  const input = '/in.pdf';
  const output = '/out.pdf';

  try {
    qpdf.FS.writeFile(input, bytes);
    const code = qpdf.callMain([...args, input, output]);

    // qpdf exits 3 on warnings and still writes a valid file; treating 3 as a failure
    // would skip every PDF with a minor spec violation, which is most of them.
    // emscripten returns undefined when main did not report a code at all.
    if (code !== 0 && code !== 3 && code !== undefined) {
      throw new Error(`qpdf exited ${code}`);
    }

    return qpdf.FS.readFile(output);
  } finally {
    // MEMFS lives as long as the module, and the module is reused across every
    // download, so leftovers accumulate megabytes per paper. Each unlink is guarded
    // on its own because either file may never have been written.
    try {
      qpdf.FS.unlink(input);
    } catch (err) {
      /* never written */
    }
    try {
      qpdf.FS.unlink(output);
    } catch (err) {
      /* never written */
    }
  }
}

// ---8<--- mirror sources (inlined) ---8<---
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
/**
 * Fetch a mirror page as text, or null.
 *
 * `info` is an optional out-parameter: when given, `info.finalUrl` is set to the url the
 * response actually came from. A redirect is the only way Anna's says "I do not have this
 * paper" -- it answers 200 for every /scidb/ url and bounces the misses to /search -- and a
 * caller that sees only the body cannot tell a hit from a miss.
 *
 * An out-parameter rather than a richer return value, because the body is returned as a
 * plain string to several callers that type-check it (`typeof html !== 'string'`). Wrapping
 * it would make those checks fail silently, which is a worse bug than the one being fixed.
 */
async function getTextMirror(url, timeoutMs = FETCH_TIMEOUT_MS_MIRROR, info = null) {
  const credentials = credentialsFor(url);
  if (credentials === null) return null;
  try {
    const res = await fetch(url, { credentials, signal: AbortSignal.timeout(timeoutMs) });
    if (info) info.finalUrl = res.url || url;
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
// Every retrieval currently inside its mirror phase, by its own deadline.
//
// A SET, not one slot and not a counter. One slot let two overlapping retrievals -- the
// popup and the bridge, or a second click, nothing serialises them -- corrupt each other:
// B's set overwrote A's, then B's finally zeroed it and A ran on with no ceiling at all.
// A counter fixed that but could only ever LOWER the ceiling, so when the earlier phase
// ended the later one stayed pinned to a deadline already in the past and reported "budget
// exhausted" for mirrors that would have answered.
//
// Holding them all means the ceiling is the earliest deadline STILL LIVE, and it rises again
// as phases finish. Conservative in the right direction: it can end a phase early, never
// extend one past its own budget.
const mirrorPhaseDeadlines = new Set();

function currentMirrorCeiling() {
  let earliest = 0;
  for (const at of mirrorPhaseDeadlines) {
    if (earliest === 0 || at < earliest) earliest = at;
  }
  return earliest;
}

/**
 * Enter a mirror phase with `at`, or leave the one that had it.
 *
 * Callers pass the SAME value on the way out as on the way in, so the right entry is
 * removed when several are live.
 */
function setMirrorPhaseDeadline(at) {
  if (typeof at === 'number' && at > 0) mirrorPhaseDeadlines.add(at);
  else mirrorPhaseDeadlines.clear();
}

function clearMirrorPhaseDeadline(at) {
  if (typeof at === 'number' && at > 0) mirrorPhaseDeadlines.delete(at);
  else mirrorPhaseDeadlines.clear();
}

/** The soonest of a local budget and the phase ceiling. */
function boundedDeadline(localBudgetMs) {
  const local = Date.now() + localBudgetMs;
  const ceiling = currentMirrorCeiling();
  return ceiling > 0 ? Math.min(local, ceiling) : local;
}

/** True when the phase ceiling has passed, for the hops that have no budget of their own. */
function mirrorPhaseExhausted() {
  const ceiling = currentMirrorCeiling();
  return ceiling > 0 && Date.now() > ceiling;
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
    const info = {};
    const body = await getTextMirror(
      `https://${host}${pathFor(host)}`, PROBE_TIMEOUT_MS_MIRROR, info,
    );
    if (body !== null) return { host, body, finalUrl: info.finalUrl };
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

async function scihubMirrors() {
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

function scihubArticleUrl(host, doi) {
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
function isScihubUnavailableHtml(html) {
  if (typeof html !== 'string' || !html) return false;
  const h = html.toLowerCase();
  return (
    h.includes('not yet available in my database')
    || h.includes('sci-net.xyz')
    || ((h.includes('what can i do') && h.includes('similar')) && !h.includes('class="download"'))
  );
}

/**
 * Is this a challenge page rather than an article page?
 *
 * Measured 2026-07-29: sci-hub.ru answered EVERY doi -- real and invented alike -- with an
 * identically sized "проверка на робота" captcha, and sci-hub.st answered 403 with a
 * DDoS-Guard interstitial. Neither is an article, and neither becomes one when opened.
 *
 * This matters because the ladder's rule is "open a tab only on evidence the paper is
 * there". A challenge page is not that evidence, but it is not the "not in my database"
 * page either, so it slipped between the two and earned a tab -- one that shows the user a
 * captcha for a paper the mirror may not even hold.
 *
 * A tab CAN legitimately be the answer to a challenge elsewhere in this extension: the
 * publisher phase opens one precisely so a human can clear Cloudflare. The difference is
 * that a publisher is known to hold the paper, while a mirror serving a captcha has told us
 * nothing at all -- so spending the user's attention on it buys nothing.
 */
function isMirrorChallengeHtml(html) {
  if (typeof html !== 'string' || !html) return false;
  // Only the head of the document: a challenge page is small and says what it is at once,
  // while an article page carries the paper's title and abstract further down. Scanning a
  // whole body for English phrases would silently drop a paper whose abstract used one --
  // losing a paper the mirror HAS, which is worse than the stray tab this prevents.
  const head = html.slice(0, 4096).toLowerCase();

  // NOT keyed on altcha. Measured 2026-07-29: sci-hub loads altcha.min.js on EVERY page,
  // article pages included -- it sat at offset 988 of a page carrying a real
  // /storage/.../kucsko2013.pdf link, and <altcha-widget> at 25420 of the same page. Keying
  // on either skipped papers sci-hub demonstrably has, which is the exact failure this
  // function must not cause. The widget is how a challenge is PRESENTED, not evidence that
  // one is being demanded.
  if (head.includes('ddos-guard')) return true;

  // Sci-Hub's own robot check: no <title> at all and no storage link, where a real article
  // page has both. The absence of a title is the cheap half; the link is the substantive
  // half, and pickScihubPdf is what ultimately decides whether there is anything to fetch.
  if (/проверка на робота|вы робот|are you a robot|are you are robot/.test(head)) return true;

  // Cloudflare's wording is ordinary English, so it counts only inside the <title>.
  return /<title>[^<]*(just a moment|checking your browser|attention required|ddos-guard)/i
    .test(head);
}


/**
 * Does this Sci-Hub page actually offer the paper?
 *
 * The POSITIVE test, and the reliable one. Measured 2026-07-29: an article page carries a
 * <title> naming the paper and a /storage/.../<name>.pdf link; the robot check carries
 * neither, and an invented DOI returns a page byte-identical in shape to a real one that is
 * being challenged. So presence of the file is the only thing that separates them.
 *
 * Preferred over hunting for captcha markers because those keep turning out to be present on
 * ordinary pages too -- altcha.min.js loads on every Sci-Hub page, article pages included,
 * and keying on it skipped papers the mirror demonstrably had.
 *
 * The href still goes through the tier resolver before it is fetched: this decides whether
 * to bother opening a tab, it grants nothing.
 */
function scihubPageOffersPdf(html) {
  if (typeof html !== 'string' || !html) return false;
  // Every shape a Sci-Hub article page has used to point at the file. The storage host is
  // the current one; embed/iframe/onclick are older mirror layouts still in the wild, and
  // pickScihubPdf already accepts all of them -- this must not be stricter than the parser
  // that runs next, or it would veto pages that parser could have handled.
  return (
    /\/storage\/[^"'\s]+\.pdf/i.test(html)
    || /(?:src|href)\s*=\s*["'][^"']*\.pdf/i.test(html)
    || /location\.href\s*=\s*["'][^"']+\.pdf/i.test(html)
    || /\/downloads?\//i.test(html)
  );
}


/**
 * Pick the PDF out of a Sci-Hub page's links. The href comes from an untrusted page, so the
 * caller MUST still put it through the tier resolver -- this chooses, it does not grant.
 */
function pickScihubPdf(hrefs, pageUrl) {
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
async function libgenPdfUrl(doi) {
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
async function annasArticleUrl(doi) {
  if (!doi) return null;
  // The DOI's slash stays LITERAL. encodeURIComponent would send 10.1016%2Fj..., which
  // Anna's happens to accept (measured: both forms return the same 108,784-byte page) but
  // which is not the form the site links to itself, and a mirror that is stricter about it
  // would fail for a reason nothing here would explain. Only the characters that genuinely
  // need escaping are escaped.
  const path = `/scidb/${doi.split('/').map(encodeURIComponent).join('/')}`;
  const hit = await firstReachable(ANNAS_MIRRORS, () => path);
  if (!hit) return null;
  // Reachable is not the same as HAS IT, and conflating the two opened a tab for every DOI.
  //
  // Anna's answers 200 for any /scidb/ url, so firstReachable -- which only asks whether a
  // host responded -- said yes even for papers it does not hold. The caller then opened a
  // tab to read links that were never going to be there. The user saw a window appear for a
  // paper already downloaded from another source.
  if (!isAnnasRecordUrl(hit.finalUrl)) return null;
  // A challenge page KEEPS the /scidb/ path, so the url test alone would read it as a hit
  // and open a tab onto a robot check for a paper nobody has established is there.
  if (isMirrorChallengeHtml(hit.body)) return null;
  return `https://${hit.host}${path}`;
}

/**
 * Does this scidb response describe a record Anna's actually holds?
 *
 * Measured live 2026-07-29. Anna's answers 200 for EVERY /scidb/ url, so the status code is
 * worthless here. What it does instead is REDIRECT: a paper it does not hold bounces to
 * `/search?index=journals&q="doi:..."`, while a paper it holds stays on /scidb/.
 *
 * The final url is the test, deliberately, and not the page's wording. Two earlier attempts
 * at this were wrong for instructive reasons:
 *
 *   - "does the html contain a download link" rejects EVERYTHING, because the viewer is
 *     built client-side and no href exists in the server-rendered html even for a hit --
 *     which is the whole reason this path needs a tab at all.
 *   - "does it say Redirecting" only works on an UNFOLLOWED response. Followed, the stub
 *     becomes a 591 KB search-results page with no such wording and plenty of md5s in the
 *     results, so that check passed the miss straight through.
 *
 * `url` is the FINAL url after redirects; `html` is unused for the verdict and kept only so
 * callers need not care which they have.
 */
function isAnnasRecordUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    return new URL(url).pathname.startsWith('/scidb/');
  } catch {
    return false;
  }
}

// --- availability probe -----------------------------------------------------------------

/**
 * The mirrors the availability probe may ask, published from HERE rather than named by the
 * probe itself.
 *
 * availability.js is not mirror code and is inlined OUTSIDE the store build's fence, so a
 * mirror name written there would survive the strip and the build would refuse to zip. It
 * reads this list at call time instead: in the store package the whole fenced region is
 * gone, the list is undefined, and the probe simply covers open access only.
 */
const MIRROR_PROBE_NAMES = ['scihub', 'annas', 'libgen'];

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
async function probeMirror(name, doi) {
  if (!doi) return 'unknown';
  try {
    if (name === 'scihub') {
      for (const host of await scihubMirrors()) {
        const body = await getTextMirror(scihubArticleUrl(host, doi), PROBE_TIMEOUT_MS_MIRROR);
        if (body === null) continue;               // host down: ask the next one
        // A captcha says nothing about the paper -- measured, sci-hub.ru served the same
        // robot check for a real doi and an invented one -- so it is not a verdict either
        // way. Ask the next mirror rather than reporting a presence nobody established.
        if (isMirrorChallengeHtml(body)) continue;
        if (isScihubUnavailableHtml(body)) return 'absent';
        // A page offering no file is either a challenge or something we cannot read. Neither
        // is a verdict about the paper, so ask the next mirror rather than claiming presence.
        if (!scihubPageOffersPdf(body)) continue;
        return 'present';
      }
      return 'unknown';                            // nothing answered
    }
    if (name === 'annas') {
      // Not annasArticleUrl: it collapses "no mirror answered" and "answered, does not hold
      // it" into the same null, and those are different claims. Only the second is a
      // definitive negative worth acting on.
      const path = `/scidb/${doi.split('/').map(encodeURIComponent).join('/')}`;
      const hit = await firstReachable(ANNAS_MIRRORS, () => path);
      if (!hit) return 'unknown';
      // A challenge keeps the /scidb/ path but proves nothing either way.
      if (isMirrorChallengeHtml(hit.body)) return 'unknown';
      return isAnnasRecordUrl(hit.finalUrl) ? 'present' : 'absent';
    }
    // libgen stays two-valued: libgenPdfUrl returns null both for "not indexed" and for
    // "the mirror chain broke half way", and nothing in its response separates them.
    if (name === 'libgen') return (await libgenPdfUrl(doi)) ? 'present' : 'unknown';
  } catch {
    return 'unknown';
  }
  return 'unknown';
}

/** Pick the file link out of a hydrated Anna's scidb page. */
function pickAnnasPdf(hrefs, pageUrl) {
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
// ---8<--- end mirror sources ---8<---

// GENERATED by scripts/bundle-publishers.mjs -- do not edit.
//
// The ten publisher resolvers, concatenated from src/tools/*-retrieval.js so the classic
// service worker can carry them without importing. Editing this file is pointless: rerun
// the script. tests/publisher-bundle.test.mjs asserts it matches its sources.
//
// createLogger is shimmed to console because the modules only ever call logger.debug on a
// failed lookup, and a worker has no winston.
function createLogger() {
  return { debug() {}, info() {}, warn(...a) { console.warn(...a); }, error(...a) { console.warn(...a); } };
}
const logger = createLogger();
// The modules rate-limit doi.org lookups. In the extension those are ordinary fetches from
// the user's own browser at human frequency, so the limiter is a no-op rather than a port.
const paperRateLimiter = { acquire: async () => {} };

// --- src/publishers/doi-path-safety.js ---
// Is a DOI safe to paste into a URL path?
//
// Springer, Wiley and ACS all address an article by embedding the DOI whole in a path
// (/content/pdf/<doi>.pdf, /doi/pdfdirect/<doi>, /doi/<doi>). A DOI is attacker-influenced
// -- whatever reaches the bridge socket supplies it -- and the resulting URL is fetched
// with the user's real cookies, so the embedding has to be checked rather than trusted.
//
// The prefix check alone is not enough. Measured: "10.1007/../../x" satisfies /^10\.1007\//
// and builds https://link.springer.com/content/pdf/10.1007/../../x.pdf, which the URL
// parser normalises to /content/x.pdf. "10.1007/a/../../../etc" reaches /content/etc.pdf,
// and the percent-encoded form "10.1007/%2e%2e/x" is left encoded here but is decoded by
// some origins. None of these leave the granted host, so this is not a cross-origin
// escape, but each defeats the path the publisher entry intended to request and turns a
// paper download into "fetch an arbitrary path on this publisher as the user".
//
// Refused rather than normalised on purpose: a DOI containing a dot segment is not a real
// DOI, so there is nothing to preserve by rewriting it, and rewriting invites a mismatch
// between what was validated and what is later built.

// Percent-encoded separators and dot segments. URL leaves these encoded, so a check on the
// parsed pathname would not see them while the far end may still decode them -- the same
// reasoning as ENCODED_PATH_SEPARATOR in src/bridge/allowed-hosts.js.
const doi_path_safety$ENCODED_SEPARATOR = /%(2f|5c|2e)/i;

/**
 * True when a DOI can be embedded in a URL path without changing which path is requested.
 *
 * Rejects whitespace and the query/fragment delimiters (which would smuggle parameters
 * onto the request), any dot segment, doubled or trailing slashes, backslashes, and any
 * percent-encoding of those. Accepts an ordinary DOI, whose single "/" separates the
 * registrant prefix from the suffix.
 */
function isSafeDoiPathSegment(doi) {
  if (typeof doi !== 'string') return false;
  const value = doi.trim();
  if (!value) return false;
  if (/[?#\s\\]/.test(value)) return false;
  if (doi_path_safety$ENCODED_SEPARATOR.test(value)) return false;
  if (value.includes('//')) return false;
  if (value.endsWith('/')) return false;
  // Any "." that stands alone as a path segment. A DOI has plenty of dots INSIDE segments
  // ("10.1007", "acs.est.0c02765"), so this must match the segment, not the character.
  if (value.split('/').some((segment) => segment === '.' || segment === '..')) return false;
  return true;
}

// --- src/publishers/elsevier-pii.js ---
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






// A PII is "S" plus 16 alphanumerics. The last character is a check digit that can be X,
// and the ninth character of the ISSN part can also be X (0304-405X is a real Elsevier
// ISSN), so the pattern cannot be "S plus digits".
const elsevier_pii$COMPACT_PII = /^S[0-9X]{16}$/i;

// Punctuated form: S<4 digits>-<4 alnum>(<2 digits>)<5 digits>-<check>.
const elsevier_pii$PUNCTUATED_PII = /^S\d{4}-[0-9X]{4}\(\d{2}\)\d{5}-[0-9X]$/i;

/** Strip punctuation and upper-case, giving the canonical compact PII, or null. */
function normalizePii(raw) {
  if (typeof raw !== 'string') return null;
  const stripped = raw.trim().replace(/[-()]/g, '').toUpperCase();
  return elsevier_pii$COMPACT_PII.test(stripped) ? stripped : null;
}

/**
 * Compact PII -> the punctuated spelling cell.com uses in its own links.
 * Returns null for anything that is not a valid compact PII, so a caller cannot
 * accidentally build a URL around a malformed identifier.
 */
function punctuatePii(pii) {
  const compact = normalizePii(pii);
  if (!compact) return null;
  const m = compact.match(/^S([0-9X]{4})([0-9X]{4})(\d{2})(\d{5})([0-9X])$/i);
  if (!m) return null;
  return `S${m[1]}-${m[2]}(${m[3]})${m[4]}-${m[5]}`;
}

/** True for either spelling of a PII. */
function isPii(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return elsevier_pii$COMPACT_PII.test(v) || elsevier_pii$PUNCTUATED_PII.test(v);
}

/**
 * Pull a PII out of any Elsevier-shaped URL, without a network call.
 *
 * Covers the three forms we actually see: linkinghub's /retrieve/pii/<PII>, ScienceDirect's
 * /science/article/pii/<PII>, and cell.com's ?pii=<PII> query form. Returns the compact
 * spelling or null.
 */
function piiFromUrl(url) {
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
const elsevier_pii$piiCache = new Map();

/** Test seam: drop everything memoized. */
function clearPiiCache() {
  elsevier_pii$piiCache.clear();
}

/**
 * Record a PII we obtained for free.
 *
 * Crossref's works record carries resource.primary.URL, which for Elsevier is the very
 * linkinghub URL the doi.org redirect would have produced. When the cell.com matcher has
 * already paid for a Crossref lookup, seeding the cache here means the subsequent
 * elsevierPii() call costs nothing. Never overwrites a real cached value with null.
 */
function seedPii(doi, pii) {
  if (typeof doi !== 'string') return;
  const compact = normalizePii(pii);
  if (!compact) return;
  elsevier_pii$piiCache.set(doi.trim().toLowerCase(), compact);
}

/** Synchronous peek at the memo. Returns the PII, or null/undefined when not resolved. */
function cachedPii(doi) {
  if (typeof doi !== 'string') return undefined;
  const hit = elsevier_pii$piiCache.get(doi.trim().toLowerCase());
  return hit instanceof Promise ? undefined : hit;
}

/**
 * Default resolver: ask Crossref where the DOI points, and fall back to following doi.org.
 *
 * A resolver's job is to produce the final URL, not to parse it -- elsevierPii extracts
 * the PII. Keeping the split here means an injected resolver is just "what does this DOI
 * redirect to", which is the thing a test can state without knowing PII syntax.
 */
async function elsevier_pii$resolveViaDoiOrg(doi, { signal } = {}) {
  // CROSSREF FIRST, because in a browser it is the only one of the two that can work.
  //
  // The doi.org hop below redirects to linkinghub.elsevier.com, and elsevier.com is
  // deliberately NOT allowlisted -- it is only ever a redirect target, and the Node client
  // follows it server-side where CORS does not apply. Inside the extension's service worker
  // it does apply, and a redirect target needs its OWN host_permissions grant, which
  // doi.org's does not extend to. So the request was refused every time:
  //
  //   Access to fetch at 'https://linkinghub.elsevier.com/retrieve/pii/S0092867414006047'
  //   (redirected from 'https://doi.org/10.1016/j.cell.2014.05.010') has been blocked by
  //   CORS policy
  //
  // It failed QUIETLY: the caller memoises null, the publisher reports "could not resolve
  // an identifier", and the paper is simply not found. And it was the only path for exactly
  // the DOIs the offline Cell table can classify, since deciding offline skips the Crossref
  // lookup that would have produced the same PII for free.
  //
  // Crossref carries the identical linkinghub url in resource.primary.URL, is already
  // allowlisted, and serves CORS headers. Measured 2026-07-29: it returns
  // .../pii/S0092867414006047 for the DOI above.
  await paperRateLimiter.acquire('crossref', { signal }).catch(() => {});
  try {
    const res = await fetch(`https://api.crossref.org/works/${encodeURI(doi)}`, { signal });
    if (res.ok) {
      const body = await res.json();
      const url = body?.message?.resource?.primary?.URL;
      if (typeof url === 'string' && url) return url;
    }
  } catch {
    // Crossref down, rate-limiting, or refusing: fall through to the redirect, which still
    // works from Node even though it cannot from the worker.
  }

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
async function elsevierPii(doi, { resolve = elsevier_pii$resolveViaDoiOrg, signal } = {}) {
  if (typeof doi !== 'string' || !doi.trim()) return null;
  const key = doi.trim().toLowerCase();
  if (elsevier_pii$piiCache.has(key)) return elsevier_pii$piiCache.get(key);

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

  elsevier_pii$piiCache.set(key, pending);
  const pii = await pending;
  elsevier_pii$piiCache.set(key, pii);
  return pii;
}

// --- src/publishers/ssrn-retrieval.js ---
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
function isSsrnDoi(doi) {
  return typeof doi === 'string' && /^10\.2139\/ssrn\./i.test(doi.trim());
}

/**
 * Extract the numeric abstract id from an SSRN DOI. Returns the id string (digits) or
 * null. Anchored so only the trailing numeric token after `ssrn.` is taken.
 */
function ssrnAbstractId(doi) {
  if (typeof doi !== 'string') return null;
  const m = doi.trim().match(/^10\.2139\/ssrn\.(\d+)/i);
  return m ? m[1] : null;
}

/**
 * The real, server-rendered SSRN abstract page for an id. www.ssrn.com/abstract=<id>
 * just 302s here, so we go straight to the canonical URL.
 */
function ssrnAbstractUrl(id) {
  return `https://papers.ssrn.com/sol3/papers.cfm?abstract_id=${encodeURIComponent(id)}`;
}

/**
 * The canonical Delivery.cfm PDF endpoint for an abstract id. This is the URL SSRN's own
 * "Download This Paper" button points at; it is code-constructed from the id (no HTML
 * parsing), and is fetched by the browser extension inside the user's real Chrome so the
 * existing cf_clearance + SSRN session cookies apply.
 */
function ssrnDeliveryUrl(id) {
  const encoded = encodeURIComponent(id);
  return `https://papers.ssrn.com/sol3/Delivery.cfm/SSRN_ID${encoded}.pdf?abstractid=${encoded}&mirid=1`;
}

// --- src/publishers/cell-retrieval.js ---
// Cell Press (cell.com) article retrieval through the browser bridge.
//
// Why the bridge: all three cell.com PDF URL patterns return 403 to a plain HTTP client
// (measured 2026-07-26 -- showPdf?pii=, /article/<PII>/pdf, /<journal>/pdf/<PII>.pdf).
// The gate is a Cloudflare managed challenge, which only a real browser clears, so the
// fetch happens inside the user's own Chrome. This module just decides ownership and
// builds URLs.
//
// ---------------------------------------------------------------------------
// The hard part: cell.com and ScienceDirect are indistinguishable by DOI prefix
// ---------------------------------------------------------------------------
//
// Both platforms are Elsevier, both mint 10.1016/* DOIs, and both resolve through
// linkinghub.elsevier.com, which routes onward only with JavaScript. A server-side
// redirect chain therefore stops at linkinghub for BOTH, so the final host is simply not
// observable that way (verified across six journals spanning both platforms). The
// authoritative discriminator is the journal, and the journal comes from Crossref.
//
// ---------------------------------------------------------------------------
// Chosen strategy: hybrid -- offline table first, Crossref only for the unknown
// ---------------------------------------------------------------------------
//
// The three options were: (a) a hardcoded journal table, (b) always ask Crossref,
// (c) table first with a Crossref fallback. This implements (c), for two reasons.
//
// 1. The table is right for the overwhelming majority and costs nothing. Cell Press is
//    about 55 journals; their DOI tokens (j.heliyon, j.isci, j.xcrm, j.cub, ...) and their
//    ISSNs were enumerated from Crossref and are embedded below. A known token answers
//    instantly, offline, on the resolve path.
//
// 2. The Crossref fallback is close to free, which is what makes (c) beat (a). The reply
//    carries resource.primary.URL -- the exact linkinghub URL the doi.org redirect would
//    have produced -- so we seed the shared PII cache from it. The cell and ScienceDirect
//    sources both need that PII and would otherwise have paid for a doi.org round trip to
//    get it. The fallback therefore SUBSTITUTES for a network call rather than adding one.
//
// Pure (b) was rejected: it would put a Crossref request in front of every Elsevier DOI
// including the ~55 journals we already know for certain, for no gain. Pure (a) was
// rejected because Cell Press launches journals (Newton and Nexus are recent) and a stale
// table would silently misroute them to ScienceDirect forever, with nothing to notice it.
//
// ACCEPTED FAILURE MODE: when Crossref itself is unreachable, an unknown-token 10.1016 DOI
// is treated as NOT cell.com. A new Cell Press journal is then handed to the ScienceDirect
// source, whose URL pattern does not serve it, and the download fails. This is deliberately
// the cheap direction to be wrong in: every bridge source is headed:false and races in
// parallel, so a misroute costs one race slot, not a user-visible stall. Being wrong the
// other way (claiming ScienceDirect DOIs on a Crossref outage) would have the cell source
// swallow the whole 10.1016 space.
//
// One DOI token is genuinely ambiguous and must never be answered from the table:
// 10.1016/j.ccr.* is Cancer Cell (Cell Press) for older articles AND Coordination Chemistry
// Reviews (ScienceDirect) for current ones. Both were confirmed live. It is listed as
// ambiguous below and always goes to Crossref.







// Elsevier's registrant prefix. Necessary but nowhere near sufficient: it also covers all
// of ScienceDirect, which is the entire reason this module needs a discriminator.
const cell_retrieval$ELSEVIER_PREFIX = /^10\.1016\//i;

// Modern Elsevier DOI shape: 10.1016/j.<journal-token>.<rest>
const cell_retrieval$JOURNAL_TOKEN = /^10\.1016\/j\.([a-z0-9]+)\./i;

// Legacy shape: 10.1016/S<print-ISSN><year><sequence>, e.g. 10.1016/S0960-9822(20)30832-0.
// The ISSN is embedded verbatim, which makes these decidable offline with no table of
// tokens at all -- the ISSN set below is enough.
const cell_retrieval$LEGACY_ISSN_DOI = /^10\.1016\/S(\d{4})-?([0-9X]{4})[(\d]/i;

// Cell Press journal DOI tokens, enumerated from Crossref (2026-07-26) by querying each
// journal title under prefix:10.1016 and collecting the j.<token> actually minted.
// Deliberately excludes the ambiguous token below.
const CELL_PRESS_DOI_TOKENS = new Set([
  'ajhg', 'bpj', 'bpr', 'ccell', 'celrep', 'cell', 'cels', 'checat', 'chembiol', 'chom',
  'cmet', 'chempr', 'crmeth', 'crsus', 'cub', 'devcel', 'device', 'heliyon', 'immuni',
  'isci', 'it', 'joule', 'matt', 'medj', 'molcel', 'molmed', 'molp', 'neuron', 'newton',
  'omtm', 'omtn', 'omton', 'oneear', 'patter', 'pt', 'stem', 'stemcr', 'str', 'tcb',
  'tibs', 'tibtech', 'tics', 'tig', 'tim', 'tips', 'tplants', 'trecan', 'trechm', 'tree',
  'tem', 'tins', 'xcrm', 'xcrp', 'xgen', 'xplc', 'xpro', 'ymthe', 'ynexs',
]);

// Tokens shared between a Cell Press journal and a non-Cell-Press Elsevier journal. These
// can only be settled by asking what the specific article's journal is.
//   ccr -> Cancer Cell (to ~2013) and Coordination Chemistry Reviews (both confirmed live)
const AMBIGUOUS_DOI_TOKENS = new Set(['ccr']);

// ISSNs of the Cell Press journals above. Used for two things: deciding legacy
// S<ISSN>(yy) DOIs offline, and checking Crossref's answer by a stable key rather than by
// a display title (titles carry HTML entities and get renamed; ISSNs do not).
const CELL_PRESS_ISSNS = new Set([
  '0002-9297', '1537-6605', // The American Journal of Human Genetics
  '0006-3495', '1542-0086', // Biophysical Journal
  '2667-0747', // Biophysical Reports
  '1535-6108', // Cancer Cell
  '0092-8674', // Cell
  '2451-9456', // Cell Chemical Biology
  '2666-979X', // Cell Genomics
  '1931-3128', // Cell Host and Microbe
  '1550-4131', // Cell Metabolism
  '2211-1247', // Cell Reports
  '2666-3791', // Cell Reports Medicine
  '2667-2375', // Cell Reports Methods
  '2666-3864', // Cell Reports Physical Science
  '2949-7906', // Cell Reports Sustainability
  '1934-5909', // Cell Stem Cell
  '2405-4712', // Cell Systems
  '2451-9294', // Chem
  '2667-1093', // Chem Catalysis
  '0960-9822', // Current Biology
  '1534-5807', // Developmental Cell
  '2666-9986', // Device
  '2405-8440', // Heliyon
  '1074-7613', // Immunity
  '2589-0042', // iScience
  '2542-4351', // Joule
  '2590-2385', // Matter
  '2666-6340', // Med
  '1097-2765', // Molecular Cell
  '1674-2052', '1752-9867', // Molecular Plant
  '1525-0016', '1525-0024', // Molecular Therapy
  '2329-0501', // Molecular Therapy - Methods and Clinical Development
  '2162-2531', // Molecular Therapy - Nucleic Acids
  '2950-3299', // Molecular Therapy - Oncology
  '0896-6273', // Neuron
  '2950-6360', // Newton
  '2950-1601', // Nexus
  '2590-3322', // One Earth
  '2666-3899', // Patterns
  '2590-3462', // Plant Communications
  '2666-1667', // STAR Protocols
  '2213-6711', // Stem Cell Reports
  '0969-2126', '1878-4186', // Structure
  '0968-0004', // Trends in Biochemical Sciences
  '0167-7799', // Trends in Biotechnology
  '2405-8033', // Trends in Cancer
  '0962-8924', // Trends in Cell Biology
  '2589-5974', // Trends in Chemistry
  '1364-6613', // Trends in Cognitive Sciences
  '0169-5347', // Trends in Ecology and Evolution
  '1043-2760', // Trends in Endocrinology and Metabolism
  '0168-9525', // Trends in Genetics
  '1471-4906', // Trends in Immunology
  '0966-842X', // Trends in Microbiology
  '1471-4914', // Trends in Molecular Medicine
  '0166-2236', // Trends in Neurosciences
  '1471-4922', // Trends in Parasitology
  '0165-6147', // Trends in Pharmacological Sciences
  '1360-1385', '1878-4372', // Trends in Plant Science
]);

/** Journal titles are only a fallback key; normalise away entities, case and punctuation. */
function cell_retrieval$normalizeTitle(title) {
  return String(title || '')
    .replace(/&amp;/g, '&')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Checked only when Crossref returns no usable ISSN. Every one of these corresponds to an
// ISSN above; the duplication is the point, so a record missing its ISSN still resolves.
const cell_retrieval$CELL_PRESS_TITLES = new Set([
  'cell', 'cancer cell', 'cell chemical biology', 'cell genomics', 'cell host and microbe',
  'cell metabolism', 'cell reports', 'cell reports medicine', 'cell reports methods',
  'cell reports physical science', 'cell reports sustainability', 'cell stem cell',
  'cell systems', 'chem', 'chem catalysis', 'current biology', 'developmental cell',
  'device', 'heliyon', 'immunity', 'iscience', 'joule', 'matter', 'med', 'molecular cell',
  'neuron', 'newton', 'nexus', 'one earth', 'patterns', 'star protocols', 'structure',
  'biophysical journal', 'biophysical reports', 'molecular therapy',
  'molecular therapy nucleic acids', 'molecular therapy methods and clinical development',
  'molecular therapy oncology', 'stem cell reports',
  'the american journal of human genetics', 'molecular plant', 'plant communications',
  'trends in biochemical sciences', 'trends in biotechnology', 'trends in cancer',
  'trends in cell biology', 'trends in chemistry', 'trends in cognitive sciences',
  'trends in ecology and evolution', 'trends in endocrinology and metabolism',
  'trends in genetics', 'trends in immunology', 'trends in microbiology',
  'trends in molecular medicine', 'trends in neurosciences', 'trends in parasitology',
  'trends in pharmacological sciences', 'trends in plant science',
]);

/** True for any 10.1016 DOI. The Elsevier space as a whole, cell.com and ScienceDirect both. */
function isElsevierDoi(doi) {
  return typeof doi === 'string' && cell_retrieval$ELSEVIER_PREFIX.test(doi.trim());
}

/**
 * Decide from the DOI string alone, with no network access.
 * Returns true (Cell Press), false (Elsevier but not Cell Press), or null ("ask Crossref").
 */
function classifyCellDoiOffline(doi) {
  if (!isElsevierDoi(doi)) return false;
  const trimmed = doi.trim();

  const legacy = trimmed.match(cell_retrieval$LEGACY_ISSN_DOI);
  if (legacy) {
    const issn = `${legacy[1]}-${legacy[2]}`.toUpperCase();
    // The ISSN is in the DOI itself, so this is decidable both ways offline.
    return CELL_PRESS_ISSNS.has(issn);
  }

  const token = trimmed.match(cell_retrieval$JOURNAL_TOKEN)?.[1]?.toLowerCase();
  if (!token) return null;
  if (AMBIGUOUS_DOI_TOKENS.has(token)) return null;
  if (CELL_PRESS_DOI_TOKENS.has(token)) return true;
  // An unrecognised token is NOT a decision: it could be a Cell Press journal launched
  // after this table was built. Defer.
  return null;
}

// doi -> boolean. Crossref answers are memoized; the matcher can be called by several
// racing sources for the same DOI.
const cell_retrieval$journalCache = new Map();

/** Test seam: forget every memoized Crossref verdict. */
function clearCellJournalCache() {
  cell_retrieval$journalCache.clear();
}

/**
 * Default discriminator: ask Crossref which journal an Elsevier DOI belongs to.
 *
 * Also harvests resource.primary.URL into the shared PII cache. That URL is the linkinghub
 * address the doi.org redirect would have returned, so this lookup doubles as the PII
 * resolve both Elsevier sources need -- which is what keeps the fallback cheap.
 */
async function cell_retrieval$lookupViaCrossref(doi, { signal } = {}) {
  await paperRateLimiter.acquire('crossref', { signal }).catch(() => {});
  const response = await fetch(
    `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
    { signal, headers: { Accept: 'application/json' } },
  );
  // A 404 is a real answer ("Crossref does not know this DOI"), not a transport failure,
  // but it tells us nothing about the journal, so it is still "unknown".
  if (!response.ok) throw new Error(`crossref HTTP ${response.status}`);
  const message = (await response.json())?.message;
  if (!message) throw new Error('crossref returned no message');

  const pii = piiFromUrl(message.resource?.primary?.URL);
  if (pii) seedPii(doi, pii);

  return {
    issns: (message.ISSN || []).map((s) => String(s).toUpperCase()),
    title: message['container-title']?.[0] || null,
  };
}

/** Is this Crossref record one of the Cell Press journals? ISSN first, title as fallback. */
function cell_retrieval$isCellPressJournal({ issns = [], title = null } = {}) {
  if (issns.some((issn) => CELL_PRESS_ISSNS.has(issn))) return true;
  // Only trust the title when there is no ISSN to judge by. A known ISSN that is absent
  // from our set is a definite "not Cell Press", and a title match must not override it.
  if (issns.length > 0) return false;
  return cell_retrieval$CELL_PRESS_TITLES.has(cell_retrieval$normalizeTitle(title));
}

/**
 * Does this DOI belong to a cell.com journal?
 *
 * Offline table first; Crossref only for DOIs the table cannot decide. `lookup` is
 * injectable so tests -- and the publisher registry's mutual-exclusion guard, which calls
 * every matcher over every sample -- stay entirely offline. Never throws: a failed lookup
 * means "not cell.com", per the accepted failure mode in the header.
 */
async function isCellDoi(doi, { lookup = cell_retrieval$lookupViaCrossref, signal } = {}) {
  const offline = classifyCellDoiOffline(doi);
  if (offline !== null) return offline;

  const key = doi.trim().toLowerCase();
  if (cell_retrieval$journalCache.has(key)) return cell_retrieval$journalCache.get(key);

  const pending = (async () => {
    try {
      return cell_retrieval$isCellPressJournal(await lookup(doi.trim(), { signal }));
    } catch (err) {
      logger.debug(`journal lookup failed for ${doi}, treating as not cell.com: ${err.message}`);
      return false;
    }
  })();

  cell_retrieval$journalCache.set(key, pending);
  const claimed = await pending;
  cell_retrieval$journalCache.set(key, claimed);
  return claimed;
}

/**
 * DOI -> PII, via the shared Elsevier resolver. Memoized there and shared with the
 * ScienceDirect source; returns null rather than throwing when the resolve fails.
 */
async function cellPii(doi, options = {}) {
  return elsevierPii(doi, options);
}

/**
 * The article landing page. This is the page the bridge tab opens so the Cloudflare
 * challenge clears on the cell.com origin before the PDF is fetched same-origin.
 *
 * /action/showPdf is deliberately NOT used as the landing page even though it is the
 * canonical PDF endpoint: landing on a PDF gives the challenge nothing to render into.
 * The journal-agnostic /article/<PII> route serves the article for every Cell Press title,
 * so we do not have to map a DOI token to a journal slug.
 */
function cellLandingUrl(pii) {
  const compact = normalizePii(pii);
  if (!compact) return null;
  return `https://www.cell.com/article/${compact}/fulltext`;
}

/**
 * The canonical PDF endpoint. cell.com's own download button points at
 * /action/showPdf?pii=<punctuated PII>, so the punctuated spelling is used here.
 */
function cellPdfUrl(pii) {
  const punctuated = punctuatePii(pii);
  if (!punctuated) return null;
  return `https://www.cell.com/action/showPdf?pii=${encodeURIComponent(punctuated)}`;
}

/**
 * Secondary PDF route, kept for the bridge to retry with. Some titles serve the PDF from
 * the article path when showPdf does not, and it takes the compact spelling.
 */
function cellArticlePdfUrl(pii) {
  const compact = normalizePii(pii);
  if (!compact) return null;
  return `https://www.cell.com/article/${compact}/pdf`;
}

// --- src/publishers/sciencedirect-retrieval.js ---
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
const OPEN_BUDGET_MS = 60 * 60 * 1000;

// Budget for an article Unpaywall reports as not-OA. Deliberately still short: the common
// outcome is a paywall page, and this bounds how long that costs while the other sources are
// racing. The trade changed with the line above -- being wrong about "likely closed" now
// costs a LOST download rather than a slow one, since an interactive challenge cannot be
// solved in 20 s -- but giving every likely-paywalled article an hour-long slot would hold a
// race open for papers that are not coming.
const CLOSED_BUDGET_MS = 20000;

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
async function isScienceDirectDoi(doi, options = {}) {
  if (!isElsevierDoi(doi)) return false;
  try {
    return !(await isCellDoi(doi, options));
  } catch (err) {
    logger.debug(`cell discriminator failed for ${doi}, declining: ${err.message}`);
    return false;
  }
}

/** DOI -> compact PII, via the shared Elsevier resolver. Memoized there, never throws. */
async function scienceDirectPii(doi, options = {}) {
  return elsevierPii(doi, options);
}

/**
 * The article landing page: the page the bridge tab opens so the Cloudflare challenge
 * clears on the sciencedirect.com origin before the PDF is fetched same-origin. It is also
 * where the paywall is legible, which is what makes the fast-fail below possible.
 */
function scienceDirectLandingUrl(pii) {
  const compact = normalizePii(pii);
  if (!compact) return null;
  return `https://www.sciencedirect.com/science/article/pii/${compact}`;
}

/**
 * The PDF endpoint. isDTMRedir=true is what ScienceDirect's own download button sends;
 * without it the endpoint bounces through an interstitial instead of serving bytes.
 */
function scienceDirectPdfUrl(pii) {
  const compact = normalizePii(pii);
  if (!compact) return null;
  return `https://www.sciencedirect.com/science/article/pii/${compact}/pdfft?isDTMRedir=true`;
}

/** A best_oa_location that is Elsevier's own site is not a cheaper route -- it is this one. */
function sciencedirect_retrieval$isElsevierHost(url) {
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
async function sciencedirect_retrieval$probeViaUnpaywall(doi) {
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
const sciencedirect_retrieval$accessCache = new Map();

/** Test seam: forget every memoized access verdict. */
function clearScienceDirectAccessCache() {
  sciencedirect_retrieval$accessCache.clear();
}

const ACCESS_FREE_ELSEWHERE = 'free-elsewhere';
const ACCESS_LIKELY_CLOSED = 'likely-closed';
const ACCESS_UNKNOWN = 'unknown';

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
async function classifyScienceDirectAccess(doi, { probe = sciencedirect_retrieval$probeViaUnpaywall, signal } = {}) {
  if (typeof doi !== 'string' || !doi.trim()) return ACCESS_UNKNOWN;
  const key = doi.trim().toLowerCase();
  if (sciencedirect_retrieval$accessCache.has(key)) return sciencedirect_retrieval$accessCache.get(key);

  const pending = (async () => {
    let facts;
    try {
      facts = await probe(doi.trim(), { signal });
    } catch (err) {
      logger.debug(`access probe failed for ${doi}, attempting anyway: ${err.message}`);
      return ACCESS_UNKNOWN;
    }
    if (!facts) return ACCESS_UNKNOWN;
    if (facts.isOa === true && facts.pdfUrl && !sciencedirect_retrieval$isElsevierHost(facts.pdfUrl)) {
      return ACCESS_FREE_ELSEWHERE;
    }
    if (facts.isOa === false) return ACCESS_LIKELY_CLOSED;
    return ACCESS_UNKNOWN;
  })();

  sciencedirect_retrieval$accessCache.set(key, pending);
  const verdict = await pending;
  sciencedirect_retrieval$accessCache.set(key, verdict);
  return verdict;
}

/** Should the bridge be skipped entirely? True only for the safe direction of the signal. */
function shouldSkipBridge(access) {
  return access === ACCESS_FREE_ELSEWHERE;
}

/** Milliseconds this article is allowed to hold a race slot for. */
function bridgeBudgetMs(access) {
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
const sciencedirect_retrieval$PAYWALL_MARKERS = [
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
function isPaywallHtml(body) {
  if (!body) return false;
  const text = (Buffer.isBuffer(body) ? body.subarray(0, 8192).toString('latin1') : String(body).slice(0, 8192))
    .toLowerCase();
  return sciencedirect_retrieval$PAYWALL_MARKERS.some((marker) => text.includes(marker.toLowerCase()));
}

// --- src/publishers/mendeley-retrieval.js ---
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
const mendeley_retrieval$DOI_RE = /^10\.17632\/([a-z0-9]+)(?:\.(\d+))?$/i;

// data.mendeley.com/datasets/<datasetId>[/<version>]. The dataset id is an
// opaque lowercase alphanumeric token (10 characters in every sample seen, but
// the length is not part of the contract, so it is not pinned here).
const mendeley_retrieval$URL_RE = /^https?:\/\/(?:www\.)?data\.mendeley\.com\/datasets\/([a-z0-9]+)(?:\/(\d+))?(?:[/?#]|$)/i;

/** True for a Mendeley Data dataset DOI. */
function isMendeleyDoi(doi) {
  return typeof doi === 'string' && mendeley_retrieval$DOI_RE.test(doi.trim());
}

/** True for a data.mendeley.com dataset URL. */
function isMendeleyUrl(url) {
  return typeof url === 'string' && mendeley_retrieval$URL_RE.test(url.trim());
}

/**
 * The dataset identifier this module passes around: "<datasetId>" or
 * "<datasetId>/<version>" when a version was given. Returns null when neither
 * argument is a Mendeley dataset. Synchronous and pure -- the registry requires
 * extractId to be.
 */
function mendeleyDatasetId(doi, url = null) {
  const fromDoi = typeof doi === 'string' ? mendeley_retrieval$DOI_RE.exec(doi.trim()) : null;
  const m = fromDoi || (typeof url === 'string' ? mendeley_retrieval$URL_RE.exec(url.trim()) : null);
  if (!m) return null;
  const id = m[1].toLowerCase();
  return m[2] ? `${id}/${m[2]}` : id;
}

/**
 * The dataset page. Opening this is the whole point: it is where hydration
 * happens and therefore the only place the file list exists.
 */
function mendeleyLandingUrl(id) {
  const parts = String(id).split('/');
  const dataset = encodeURIComponent(parts[0]);
  const version = parts[1] ? `/${encodeURIComponent(parts[1])}` : '';
  return `https://data.mendeley.com/datasets/${dataset}${version}`;
}

// --- src/publishers/digitalcommons-retrieval.js ---
// DigitalCommons (bepress) institutional repositories.
//
// Unlike every other publisher in the registry there is NO DOI pattern here. bepress
// instances are per-university repositories on the university's own domain
// (digitalcommons.unl.edu, docs.lib.purdue.edu, scholarworks.uni.edu, ...), and the same
// software serves all of them from identical paths. So this source activates from a URL,
// not a DOI: it is driven by web_fulltext_* discovery results whose host is a known
// instance.
//
// Why the bridge is needed (measured 2026-07-26):
//   https://digitalcommons.unl.edu/cgi/viewcontent.cgi?article=1000&context=libraryscience
// answered HTTP 202 with a ~3 kB AWS WAF interstitial to a plain client, three times in a
// row with no progress. The body loads challenge.js from <id>.token.awswaf.com, which
// computes an aws-waf-token cookie and reloads the page. A non-JS client can never get
// past that; a real browser clears it in about a second, unattended. (Re-probed later the
// same day the same URLs answered 403 from a datacentre IP instead -- the edge picks
// between challenge and block, and neither is fetchable without a browser. Both outcomes
// argue for the bridge.)
//
// Consequences that live outside this file:
//   - chrome-extension/background.js pageIsCleared() had to learn the AWS WAF markers
//     (gokuProps / awsWafCookieDomainList / #challenge-container). Its Cloudflare-only
//     heuristics would otherwise declare the interstitial "cleared", fetch the challenge
//     HTML, and fail the %PDF- check -- a silent failure that reads as closed access.
//   - The instance list is the credentialed-fetch grant, so it lives in
//     src/bridge/allowed-hosts.js (mirrored in the extension), not here. This module
//     READS that list. Deriving detection from the boundary can only ever narrow what we
//     attempt; the reverse direction would let a change here widen the grant.



/**
 * Known bepress instance hosts, taken from the allowlist so the two can never disagree.
 * Every PATH_CONSTRAINED_HOSTS entry exists for DigitalCommons; if that ever stops being
 * true this needs a discriminator rather than the whole list.
 */
const digitalcommons_retrieval$INSTANCE_HOSTS = new Set(PATH_CONSTRAINED_HOSTS.map((r) => r.host));

// The two content paths bepress serves a PDF from.
//   /cgi/viewcontent.cgi?article=<n>&context=<series>  -- the canonical download URL, the
//     one the landing page advertises as citation_pdf_url.
//   /context/<series>/article/<n>/type/native/viewcontent -- the same document under the
//     newer rewritten form. Kept because discovery returns both.
const digitalcommons_retrieval$VIEWCONTENT_CGI = '/cgi/viewcontent.cgi';
const digitalcommons_retrieval$CONTEXT_VIEWCONTENT = /^\/context\/[^/]+\/article\/\d+\/type\/[^/]+\/viewcontent$/;

/** Parse to a URL, or null. Never throws, never coerces a non-string. */
function digitalcommons_retrieval$parse(url) {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** True when a pathname is one of the bepress PDF endpoints. */
function digitalcommons_retrieval$isViewcontentPath(pathname) {
  return pathname === digitalcommons_retrieval$VIEWCONTENT_CGI || digitalcommons_retrieval$CONTEXT_VIEWCONTENT.test(pathname);
}

/**
 * True when this URL is a fetchable document on a known DigitalCommons instance:
 * https, a listed instance host, and a bepress viewcontent path.
 *
 * Host membership alone is not enough. The grant in allowed-hosts.js is host AND path,
 * and claiming a URL we would then be refused at the boundary just burns a race slot.
 */
function isDigitalCommonsUrl(url) {
  const u = digitalcommons_retrieval$parse(url);
  if (!u) return false;
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password || u.port !== '') return false;
  if (!digitalcommons_retrieval$INSTANCE_HOSTS.has(u.hostname.toLowerCase())) return false;
  return digitalcommons_retrieval$isViewcontentPath(u.pathname);
}

/**
 * The PDF URL for a DigitalCommons document, or null.
 *
 * It is the viewcontent URL itself: bepress serves the PDF bytes straight from that
 * endpoint, there is nothing to construct. Normalised to a lowercase host with the
 * fragment dropped so the same document does not produce two cache keys; the query is
 * preserved verbatim because article= and context= ARE the document identity on the
 * /cgi/ form.
 */
function digitalCommonsPdfUrl(url) {
  if (!isDigitalCommonsUrl(url)) return null;
  const u = new URL(url);
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';
  return u.toString();
}

/**
 * The page the bridge tab navigates to. Deliberately the PDF URL itself, not the article
 * landing page.
 *
 * background.js fetchPdf picks `landing = isAllowedUrl(referer) ? referer : url`. For
 * bepress the article landing page (/<series>/<n>/) is NOT allowlisted -- only the two
 * viewcontent paths are -- so referer would fall back to the PDF URL anyway. That
 * fallback is the correct behaviour here rather than an accident worth working around:
 * the WAF challenge is attached to the origin, so navigating the tab straight at
 * viewcontent.cgi lets that response run its own challenge, mint aws-waf-token for the
 * origin, and reload into the real document. The subsequent in-page fetch is then
 * same-origin with the cookie already set. Opening the landing page first would clear the
 * same cookie one navigation earlier and buy nothing, at the cost of widening the grant
 * to every path under an instance.
 */
function digitalCommonsLandingUrl(url) {
  return digitalCommonsPdfUrl(url);
}

/**
 * Article-landing URLs (https://<host>/<series>/<n>/, or the /vol/iss/ journal form) are
 * NOT recognised, and cannot be mapped to viewcontent.cgi from the URL alone.
 *
 * The mapping needs the bepress `article=` number, which is an internal per-instance
 * counter unrelated to anything in the landing path: digitalcommons.usu.edu/etd/1/ is
 * article=1000, docs.lib.purdue.edu/jate/vol1/iss1/1/ is article=1020. The only reliable
 * source is the landing page's own citation_pdf_url meta tag -- an HTTP fetch, which is
 * exactly what the WAF blocks. So a landing URL is left to the other resolver sources,
 * and only a discovery result that already points at viewcontent is claimed here.
 *
 * Exported as a predicate so callers can tell "not DigitalCommons" from "DigitalCommons,
 * but we cannot reach the PDF from this URL" and log the difference.
 */
function isDigitalCommonsLandingUrl(url) {
  const u = digitalcommons_retrieval$parse(url);
  if (!u) return false;
  if (!digitalcommons_retrieval$INSTANCE_HOSTS.has(u.hostname.toLowerCase())) return false;
  return !digitalcommons_retrieval$isViewcontentPath(u.pathname);
}

/** The instance hosts this source knows about. Read-only copy, for logging and tests. */
function digitalCommonsHosts() {
  return [...digitalcommons_retrieval$INSTANCE_HOSTS];
}

// --- src/publishers/nature-retrieval.js ---
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

const nature_retrieval$NATURE_DOI = /^10\.1038\/(.+)$/i;

/** True for a Springer Nature DOI. */
function isNatureDoi(doi) {
  return typeof doi === 'string' && nature_retrieval$NATURE_DOI.test(doi.trim());
}

/**
 * The article id embedded in the DOI, e.g. "s41586-020-2649-2".
 *
 * Legacy DOIs (10.1038/nature12373, 10.1038/nmeth.1923) carry an id that still resolves
 * on the same path, so they need no special case. Anything with a slash in the suffix is
 * rejected: that is not an article id and would let a crafted DOI reach another path.
 */
function natureArticleId(doi) {
  if (typeof doi !== 'string') return null;
  const m = nature_retrieval$NATURE_DOI.exec(doi.trim());
  if (!m) return null;
  const id = m[1].trim();
  if (!id || id.includes('/') || id.includes('?') || id.includes('#')) return null;
  return id;
}

function natureLandingUrl(id) {
  return `https://www.nature.com/articles/${id}`;
}

function naturePdfUrl(id) {
  return `https://www.nature.com/articles/${id}.pdf`;
}

// --- src/publishers/springer-retrieval.js ---
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



// 10.1007 is Springer's own registrant prefix. The sibling Springer Nature prefixes are
// deliberately NOT claimed here: 10.1038 belongs to the nature entry, and 10.1186 (BioMed
// Central) is fully open access with every article mirrored into PMC, which the existing
// captcha-free sources already fetch -- a bridge source there would add nothing.
const springer_retrieval$SPRINGER_DOI = /^10\.1007\/(.+)$/i;

/** True for a Springer DOI. */
function isSpringerDoi(doi) {
  return typeof doi === 'string' && springer_retrieval$SPRINGER_DOI.test(doi.trim());
}

/**
 * The identifier IS the DOI: /content/pdf/<doi>.pdf embeds it whole, slashes included.
 *
 * Returned trimmed and lower-cased so two spellings of one DOI cannot produce two
 * different cache keys or URLs. isSafeDoiPathSegment rejects anything that would change
 * which path is requested once embedded -- dot segments, doubled slashes, encoded
 * separators, query/fragment delimiters. See doi-path-safety.js for the measured escapes.
 */
function springerArticleId(doi) {
  if (typeof doi !== 'string') return null;
  const trimmed = doi.trim();
  if (!springer_retrieval$SPRINGER_DOI.test(trimmed)) return null;
  if (!isSafeDoiPathSegment(trimmed)) return null;
  return trimmed.toLowerCase();
}

function springerLandingUrl(id) {
  return `https://link.springer.com/article/${id}`;
}

function springerPdfUrl(id) {
  return `https://link.springer.com/content/pdf/${id}.pdf`;
}

// --- src/publishers/wiley-retrieval.js ---
// Wiley (onlinelibrary.wiley.com).
//
// Measured 2026-07-26:
//   - Both the article page and the PDF return HTTP 403 from Cloudflare to a plain client,
//     even one impersonating a real Chrome TLS fingerprint. Only a fetch from inside a
//     browser that already holds cf_clearance gets through.
//   - Wiley hosts its own free PDFs. In a 40-DOI sample of the 10.1002 prefix, 10 articles
//     had a free PDF and ALL TEN were on onlinelibrary.wiley.com -- no PMC, arXiv or
//     repository copy existed. So for a free Wiley article the bridge is the only route,
//     which is exactly the case that makes a publisher entry worth its cost.
//   - The mix was 8 bronze / 2 hybrid: bronze means free to read with no open licence,
//     which on Elsevier meant HTML-only, but Wiley's own PDF URL is what Unpaywall points
//     at, so here the PDF really is served.
//
// The PDF url is constructible: /doi/pdfdirect/<doi> is Wiley's canonical download path
// and embeds the DOI whole. No DOM read, no redirect round trip.



// Wiley publishes under two registrant prefixes. 10.1002 is Wiley's own; 10.1111 came in
// with Blackwell and is still served from the same platform (confirmed in the sample: a
// 10.1111 DOI resolved to an onlinelibrary.wiley.com/doi/pdfdirect/ URL).
//
// 10.1111 is not a clean partition. Some 10.1111 DOIs are hosted by OUP under a society
// agreement -- the sample contained two consecutive articles of the same journal,
// 10.1111/1740-9713.01393 on Wiley and .01397 on academic.oup.com. This entry claims both
// anyway, because the OUP entry is keyed on 10.1093 and so cannot claim them either; the
// worst case is one wasted tab whose body fails the %PDF- check. Deciding the split would
// need a per-DOI Crossref lookup, which costs more than the failure it would avoid.
const wiley_retrieval$WILEY_DOI = /^10\.(1002|1111)\/(.+)$/i;

/** True for a Wiley/Blackwell DOI. */
function isWileyDoi(doi) {
  return typeof doi === 'string' && wiley_retrieval$WILEY_DOI.test(doi.trim());
}

/**
 * The identifier IS the DOI, embedded whole in /doi/pdfdirect/<doi>.
 *
 * Lower-cased so one DOI has one spelling. isSafeDoiPathSegment rejects anything that
 * would change which path is requested once embedded -- dot segments, doubled slashes,
 * encoded separators, query/fragment delimiters. See doi-path-safety.js.
 */
function wileyArticleId(doi) {
  if (typeof doi !== 'string') return null;
  const trimmed = doi.trim();
  if (!wiley_retrieval$WILEY_DOI.test(trimmed)) return null;
  if (!isSafeDoiPathSegment(trimmed)) return null;
  return trimmed.toLowerCase();
}

function wileyLandingUrl(id) {
  return `https://onlinelibrary.wiley.com/doi/${id}`;
}

function wileyPdfUrl(id) {
  return `https://onlinelibrary.wiley.com/doi/pdfdirect/${id}`;
}

// --- src/publishers/acs-retrieval.js ---
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



// 10.1021 is ACS's sole registrant prefix.
const acs_retrieval$ACS_DOI = /^10\.1021\/(.+)$/i;

/** True for an ACS DOI. */
function isAcsDoi(doi) {
  return typeof doi === 'string' && acs_retrieval$ACS_DOI.test(doi.trim());
}

/**
 * The identifier IS the DOI, embedded whole in the landing url /doi/<doi>.
 *
 * Lower-cased for a single spelling. isSafeDoiPathSegment rejects anything that would
 * change which path is requested once embedded -- dot segments, doubled slashes, encoded
 * separators, query/fragment delimiters. See doi-path-safety.js for the measured escapes.
 */
function acsArticleId(doi) {
  if (typeof doi !== 'string') return null;
  const trimmed = doi.trim();
  if (!acs_retrieval$ACS_DOI.test(trimmed)) return null;
  if (!isSafeDoiPathSegment(trimmed)) return null;
  return trimmed.toLowerCase();
}

function acsLandingUrl(id) {
  return `https://pubs.acs.org/doi/${id}`;
}

/**
 * Picks the full text out of an ACS article page.
 *
 * Silverchair's download path is /<journal-code>/article-pdf/doi/..., and the page also
 * links supplementary material as .pdf. Without this the first candidate wins and a
 * supplement gets filed as the paper -- worse than a failed download, because nothing
 * downstream can detect it. Verified live: the jacs.6c07767 page yields exactly
 * https://pubs.acs.org/jacsat/article-pdf/doi/10.1021/jacs.6c07767/66240843/jacs.6c07767.pdf
 */
const ACS_PDF_LINK = /\/article-pdf\/doi\//;

// --- src/publishers/oup-retrieval.js ---
// Oxford University Press (academic.oup.com).
//
// Measured 2026-07-26:
//   - Both the article page and the PDF return HTTP 403 from Cloudflare to a plain client
//     impersonating a real Chrome TLS fingerprint. So does /article-lookup/doi/<doi>, OUP's
//     own DOI entry point. Nothing outside a cleared browser reaches the site.
//   - OUP hosts its own free PDFs. In a 40-DOI sample of the 10.1093 prefix, 15 articles
//     had a free PDF and 11 of those were on academic.oup.com; the remaining four were
//     society titles served from other platforms, which the existing sources already reach.
//     The mix was 12 bronze / 2 gold / 1 hybrid.
//
// UNLIKE every other publisher here, the PDF url is NOT constructible. OUP's download path
// is /<journal>/article-pdf/<vol>/<issue>/<page>/<internal-id>/<file>.pdf -- it carries an
// internal asset id that appears nowhere in the DOI, and advance articles use a different
// shape again (/advance-article-pdf/doi/<doi>/<internal-id>/<file>.pdf). Both were seen in
// the sample. So pdfUrl() returns null and the resolver reads the link out of the rendered
// page, the same path Mendeley Data uses.
//
// What IS resolvable offline is the landing page: https://doi.org/<doi> 302s straight to
// the academic.oup.com article URL, and that redirect is served to a plain client (403 is
// only on OUP itself). That one hop is memoized here.






// 10.1093 is OUP's registrant prefix. Society journals OUP hosts under a partner's prefix
// (some 10.1111 DOIs land on academic.oup.com) are deliberately not claimed by DOI: see the
// note in wiley-retrieval.js for why splitting that prefix is not worth a Crossref lookup.
const oup_retrieval$OUP_DOI = /^10\.1093\/(.+)$/i;

// The article path, without a leading slash. Three shapes, all seen live:
//   nar/article/49/D1/D480/6006196
//   bjs/advance-article/doi/10.1093/bjs/znad132/7163415
//   ahr/article-abstract/128/1/428/7098075
//
// /article-abstract/ is accepted but is a SIGNAL, not just a spelling. Measured live for
// 10.1093/ahr/rhad037: doi.org lands there, the page links no PDF at all, and requesting
// the /article/ form of the same path is bounced straight back to
// /article-abstract/?redirectedFrom=fulltext by OUP itself. Rewriting the path client-side
// was tried and does not work -- the redirect is the server declining, so a bronze OUP
// article whose full text is gated simply has no PDF to fetch and the source loses its
// race. Gold articles serve /article/ and yield the download link normally (verified:
// 10.1093/geroni/igaa057.3494). Do not re-add a /article-abstract/ -> /article/ rewrite.
//
// Constrained to path-safe characters and required to start with a journal slug, so a
// resolved URL cannot point the tab at an arbitrary path on the host.
const oup_retrieval$OUP_ARTICLE_PATH = /^[a-z0-9-]+\/(advance-)?article(-abstract)?\/[A-Za-z0-9._/-]+$/;

/** True for an OUP DOI. */
function isOupDoi(doi) {
  return typeof doi === 'string' && oup_retrieval$OUP_DOI.test(doi.trim());
}

/**
 * Pull the article path out of an academic.oup.com URL, without a network call.
 *
 * Returns e.g. "nar/article/49/D1/D480/6006196", or null when the URL is not an OUP
 * article. Used both to answer from a discovery URL and to validate what the DOI resolve
 * landed on.
 */
function oupArticlePath(url) {
  if (typeof url !== 'string') return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host !== 'academic.oup.com') return null;
  const path = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  return oup_retrieval$OUP_ARTICLE_PATH.test(path) ? path : null;
}

// doi (lowercased) -> article path, or null when the resolve failed. In-flight promises are
// stored too, so concurrent callers asking for the same DOI make one request.
const oup_retrieval$pathCache = new Map();

/** Test seam: drop everything memoized. */
function clearOupPathCache() {
  oup_retrieval$pathCache.clear();
}

/** Synchronous peek at the memo. Returns the path, or null/undefined when not resolved. */
function cachedOupPath(doi) {
  if (typeof doi !== 'string') return undefined;
  const hit = oup_retrieval$pathCache.get(doi.trim().toLowerCase());
  return hit instanceof Promise ? undefined : hit;
}

/**
 * Default resolver: follow doi.org and report where we landed.
 *
 * HEAD is enough -- only the final URL is wanted, never the body, and OUP would refuse the
 * body anyway. The 302 itself comes from doi.org, so this succeeds from a plain client even
 * though the destination does not.
 */
async function oup_retrieval$resolveViaDoiOrg(doi, { signal } = {}) {
  await paperRateLimiter.acquire('doi-org', { signal }).catch(() => {});
  const response = await fetch(`https://doi.org/${encodeURI(doi)}`, {
    method: 'HEAD',
    redirect: 'follow',
    signal,
  });
  return response.url;
}

/**
 * DOI -> article path, memoized, never throwing.
 *
 * `resolve` is injectable so tests and the registry's offline guards never touch the
 * network. A failed or off-host resolve caches null: retrying it on every source in the
 * race would multiply the latency of the failure without changing the outcome.
 */
async function oupPath(doi, { resolve = oup_retrieval$resolveViaDoiOrg, signal } = {}) {
  if (typeof doi !== 'string' || !doi.trim()) return null;
  const key = doi.trim().toLowerCase();
  if (oup_retrieval$pathCache.has(key)) return oup_retrieval$pathCache.get(key);

  const pending = (async () => {
    try {
      const landed = await resolve(doi.trim(), { signal });
      // Accept either a landing URL or an already-extracted path, so a caller is not
      // forced to know which shape the resolver speaks.
      return oupArticlePath(landed)
        || (typeof landed === 'string' && oup_retrieval$OUP_ARTICLE_PATH.test(landed) ? landed : null);
    } catch (err) {
      logger.debug(`OUP path resolve failed for ${doi}: ${err.message}`);
      return null;
    }
  })();

  oup_retrieval$pathCache.set(key, pending);
  const path = await pending;
  oup_retrieval$pathCache.set(key, path);
  return path;
}

function oupLandingUrl(id) {
  return `https://academic.oup.com/${id}`;
}

// --- src/publishers/publishers.js ---
// Declarative registry of publishers served by the browser bridge.
//
// The bridge transport (extension -> native host -> unix socket -> desktop client) is already
// publisher-agnostic: it takes {url, referer} and returns PDF bytes fetched from inside
// the user's real Chrome. What was publisher-specific was the resolver branch in
// save-to-vault.js. This module turns that branch into data: each entry says which
// papers it owns, how to turn a DOI or URL into an identifier, and which URLs the tab
// should open and fetch.
//
// `matches` is ASYNC-CAPABLE on purpose. cell.com and ScienceDirect share the 10.1016
// registrant prefix and both resolve to linkinghub.elsevier.com, which routes onward
// only with JavaScript -- so the final host is not discoverable from a server-side
// redirect chain. The only authoritative discriminator is the journal, which means a
// network lookup (api.crossref.org/works/<doi> -> container-title). Allowing `matches`
// to return a Promise and awaiting it in findPublisher keeps that possible without
// reshaping the registry later. Synchronous matchers (SSRN's is a regexp) still work
// unchanged, since `await` on a boolean is a boolean.
//
// A network-backed matcher MUST stay testable offline: memoize it and take its lookup
// as an injectable dependency, because the registry's mutual-exclusion test calls every
// entry's `matches` for every sample and must not hit the network to do so. That is what
// the third `options` argument is for: findPublisher forwards it verbatim, so a caller
// (or a test) can hand the matcher a fake discriminator. Matchers with no network
// dependency simply ignore it.
//
// Entry shape:
//   name        string   -- source name in the resolver
//   hosts       string[] -- lowercase hosts this publisher fetches from
//   matches     (doi, url, options) => boolean | Promise<boolean>
//   extractId   (doi, url) => string | null  -- synchronous, pure
//   resolveId   (doi, url, options) => Promise<string|null>  -- OPTIONAL, and present only
//                when the identifier cannot always be derived offline. cell.com needs a
//                PII, which is a redirect away, so its extractId answers only from a URL
//                or an already-memoized resolve and resolveId does the round trip.
//                Consumers should prefer resolveId when an entry has one.
//   landingUrl  (id) => string   -- page the tab opens; the challenge clears here
//   pdfUrl      (id) => string | null -- direct PDF url when one is constructible. null
//                means "read the links out of the rendered page instead".
//   preferPdfLink RegExp -- OPTIONAL, and meaningful only when pdfUrl returns null. Picks
//                the full text out of a page that links several PDFs (OUP also links its
//                supplementary material). Absent means "take the first candidate".
//   manualLabel string   -- label for the human-visible fallback link
//   headed      boolean  -- always false: bridge sources race in parallel
//   accessGate  object   -- OPTIONAL. Present only where most content is unreachable and
//                the attempt must therefore be bounded before a tab is opened. Shape:
//                { classify(doi, options) => Promise<verdict>,
//                  shouldSkip(verdict) => boolean,
//                  budgetMs(verdict) => number,
//                  isRefusal(body) => boolean }. A missing accessGate means "attempt,
//                with the caller's normal budget", so no other entry needs one.
//   samples     {doi, url}[] -- non-empty; what the registry tests exercise the entry
//                with. URL-driven publishers (DigitalCommons has no DOI pattern) set
//                doi:null and supply url. An entry whose extractId cannot answer from a
//                DOI alone must include a sample carrying a URL, so the synchronous URL
//                guards still have something to build from. Omitting samples would
//                silently skip the two guard tests, so they are required.
















const PUBLISHERS = [
  {
    name: 'ssrn',
    hosts: ['ssrn.com'],
    matches: (doi) => isSsrnDoi(doi),
    extractId: (doi) => ssrnAbstractId(doi),
    landingUrl: (id) => ssrnAbstractUrl(id),
    pdfUrl: (id) => ssrnDeliveryUrl(id),
    manualLabel: 'SSRN abstract page',
    headed: false,
    samples: [{ doi: '10.2139/ssrn.2386457', url: null }],
  },
  {
    // URL-driven, not DOI-driven: bepress repositories have no DOI namespace of their
    // own, so this entry only ever fires on a web_fulltext_* discovery URL whose host is
    // a known instance. `matches` ignores the DOI argument entirely, which is also why it
    // can never collide with a DOI-based publisher.
    name: 'digitalcommons',
    // Every listed instance, sourced from the allowlist. These are third-party university
    // hosts under a path-constrained grant, not suffix-granted publisher domains -- see
    // src/bridge/allowed-hosts.js.
    hosts: digitalCommonsHosts(),
    matches: (doi, url) => isDigitalCommonsUrl(url),
    // The identifier IS the URL. There is no shorter stable id: the /cgi/ form's identity
    // lives in the article= and context= query parameters, so stripping anything loses it.
    extractId: (doi, url) => digitalCommonsPdfUrl(url),
    landingUrl: (id) => digitalCommonsLandingUrl(id),
    pdfUrl: (id) => digitalCommonsPdfUrl(id),
    manualLabel: 'DigitalCommons download page',
    headed: false,
    samples: [
      { doi: null, url: 'https://digitalcommons.unl.edu/cgi/viewcontent.cgi?article=1000&context=libraryscience' },
      { doi: null, url: 'https://digitalcommons.usu.edu/context/etd/article/1000/type/native/viewcontent' },
    ],
  },
  {
    // Mendeley Data datasets. Claimed by DOI (10.17632, Mendeley Data's own registrant
    // prefix, shared with nothing else here) or by dataset URL.
    name: 'mendeley',
    hosts: ['data.mendeley.com'],
    matches: (doi, url) => isMendeleyDoi(doi) || isMendeleyUrl(url),
    extractId: (doi, url) => mendeleyDatasetId(doi, url),
    landingUrl: (id) => mendeleyLandingUrl(id),
    // No constructible PDF url: the file URLs exist only in the hydrated DOM (see the
    // header of mendeley-retrieval.js for the measurement). The resolver opens the
    // landing page with the bridge's fetch_links capability, picks the .pdf href with
    // pickPdfLink, and only then fetches it down the normal fetch_pdf path.
    pdfUrl: () => null,
    manualLabel: 'Mendeley Data dataset page',
    headed: false,
    samples: [
      { doi: '10.17632/hxfhg7ycpr.1', url: null },
      { doi: null, url: 'https://data.mendeley.com/datasets/hxfhg7ycpr/1' },
    ],
  },
  {
    // Cell Press. Shares the 10.1016 registrant prefix with ScienceDirect, so the matcher
    // is the only one here that cannot decide from the identifier's shape alone -- see the
    // header of cell-retrieval.js for the journal-table-plus-Crossref-fallback rationale
    // and the failure mode it accepts. `options` is forwarded straight through so the
    // Crossref discriminator can be faked offline.
    name: 'cell',
    hosts: ['cell.com'],
    matches: (doi, url, options) => isCellDoi(doi, options),
    // Synchronous and pure, so the registry guards can call it: it answers from a URL that
    // already carries the PII, or from a resolve some earlier caller memoized. It returns
    // null for a bare DOI that has not been resolved yet, which is what resolveId is for.
    extractId: (doi, url) => piiFromUrl(url) || cachedPii(doi) || null,
    resolveId: (doi, url, options) => (piiFromUrl(url)
      ? Promise.resolve(piiFromUrl(url))
      : cellPii(doi, options)),
    landingUrl: (id) => cellLandingUrl(id),
    pdfUrl: (id) => cellPdfUrl(id),
    manualLabel: 'Cell Press article page',
    headed: false,
    // Each sample carries the linkinghub URL as well as the DOI because extractId is
    // synchronous and a bare DOI has no PII until something resolves it. Heliyon and
    // iScience are decided by the DOI token table; the Current Biology entry is in the
    // legacy S<ISSN>(yy) DOI form, which is decided from the ISSN embedded in the DOI.
    samples: [
      {
        doi: '10.1016/j.heliyon.2023.e13212',
        url: 'https://linkinghub.elsevier.com/retrieve/pii/S240584402300419X',
      },
      {
        doi: '10.1016/j.isci.2023.106041',
        url: 'https://linkinghub.elsevier.com/retrieve/pii/S2589004223001189',
      },
      {
        doi: '10.1016/S0960-9822(20)30832-0',
        url: 'https://linkinghub.elsevier.com/retrieve/pii/S0960982220308320',
      },
    ],
  },
  {
    // ScienceDirect: the rest of Elsevier. Defined as the exact complement of the cell
    // entry inside the 10.1016 prefix -- see the header of sciencedirect-retrieval.js for
    // why the prefix alone settles "is Elsevier" and why no second Crossref check is worth
    // making. Because both matchers consult the same discriminator, they partition the
    // prefix and the registry's mutual-exclusion guard holds by construction rather than by
    // two journal tables happening to agree.
    //
    // MUST stay after the cell entry is NOT true, and deliberately so: mutual exclusion is
    // structural here, so ordering carries no meaning and cannot be quietly depended on.
    name: 'sciencedirect',
    hosts: ['sciencedirect.com'],
    matches: (doi, url, options) => isScienceDirectDoi(doi, options),
    // Same shape as cell's: synchronous and pure so the registry guards can call it, with
    // resolveId doing the round trip a bare DOI needs.
    extractId: (doi, url) => piiFromUrl(url) || cachedPii(doi) || null,
    resolveId: (doi, url, options) => (piiFromUrl(url)
      ? Promise.resolve(piiFromUrl(url))
      : scienceDirectPii(doi, options)),
    landingUrl: (id) => scienceDirectLandingUrl(id),
    pdfUrl: (id) => scienceDirectPdfUrl(id),
    manualLabel: 'ScienceDirect article page',
    headed: false,
    // OPTIONAL, and only this entry has one. Most of ScienceDirect is paywalled and the
    // user has no institutional access, so the common outcome is a tab that clears the
    // challenge and is handed an HTML paywall page. Since every publisher source races in
    // parallel, that failure must not hold a race slot for the full challenge timeout.
    // accessGate lets Task 6's wiring ask, before opening a tab: skip this paper entirely
    // (a cheaper source already has a free PDF off Elsevier), or attempt it on a reduced
    // budget. See the header of sciencedirect-retrieval.js for why is_oa=false shortens
    // the budget but must never skip the attempt. Consumers must treat a missing
    // accessGate as "attempt, with no special budget".
    accessGate: {
      classify: (doi, options) => classifyScienceDirectAccess(doi, options),
      shouldSkip: (access) => shouldSkipBridge(access),
      budgetMs: (access) => bridgeBudgetMs(access),
      // Consulted only for a body that already failed the %PDF- check, to tell a paywall
      // (stop) from an uncleared challenge (a retry may help).
      isRefusal: (body) => isPaywallHtml(body),
    },
    // Journal of Financial Economics is the modern j.<token> shape, undecidable offline and
    // settled by the discriminator; the second is the legacy S<ISSN>(yy) shape, whose
    // embedded ISSN is decided offline. Both carry a linkinghub URL for the same reason the
    // cell samples do.
    samples: [
      {
        doi: '10.1016/j.jfineco.2019.05.005',
        url: 'https://linkinghub.elsevier.com/retrieve/pii/S0304405X19301199',
      },
      {
        doi: '10.1016/S0304-405X(99)00003-3',
        url: 'https://linkinghub.elsevier.com/retrieve/pii/S0304405X99000033',
      },
    ],
  },
  {
    // Springer Nature, not Elsevier -- the only non-Elsevier publisher here. Included
    // because it hosts its own open-access PDFs behind a JS challenge: in a 7-paper
    // sample of OA Nature-family articles, 6 had no working pdf route outside
    // nature.com, so the existing captcha-free sources reach nothing for them. That is
    // the opposite of ScienceDirect, whose free PDFs always live somewhere else.
    //
    // The 10.1038 prefix belongs to Springer Nature alone, and the article id in the DOI
    // is the path, so both the landing page and the PDF are constructible offline -- no
    // Crossref lookup and no DOM read.
    name: 'nature',
    hosts: ['nature.com'],
    matches: (doi) => isNatureDoi(doi),
    extractId: (doi) => natureArticleId(doi),
    landingUrl: (id) => natureLandingUrl(id),
    pdfUrl: (id) => naturePdfUrl(id),
    manualLabel: 'Nature article page',
    headed: false,
    samples: [
      { doi: '10.1038/s41598-020-69209-2', url: null },
      { doi: '10.1038/nature12373', url: null },
    ],
  },
  {
    // Springer proper (link.springer.com), the 10.1007 prefix -- distinct from the nature
    // entry's 10.1038 even though both are Springer Nature, because they are different
    // platforms with different URL shapes and different walls (F5 here as on nature.com).
    //
    // Low OA rate: 37 of 40 sampled DOIs were closed, so this source usually resolves to a
    // paywall page the %PDF- check rejects. Registered anyway because when a Springer
    // article IS free its publisher PDF is on link.springer.com and nothing else in the
    // pipeline can fetch it. No accessGate: unlike ScienceDirect, a free Springer article
    // has no cheaper route, so there is never a reason to skip the attempt.
    name: 'springer',
    hosts: ['link.springer.com'],
    matches: (doi) => isSpringerDoi(doi),
    extractId: (doi) => springerArticleId(doi),
    landingUrl: (id) => springerLandingUrl(id),
    pdfUrl: (id) => springerPdfUrl(id),
    manualLabel: 'Springer article page',
    headed: false,
    samples: [
      { doi: '10.1007/s11367-021-01974-2', url: null },
      { doi: '10.1007/s10021-019-00449-8', url: null },
    ],
  },
  {
    // Wiley. Cloudflare 403s every plain client, and all ten free PDFs in a 40-DOI sample
    // were on onlinelibrary.wiley.com with no copy anywhere else -- see the header of
    // wiley-retrieval.js, including why the shared 10.1111 prefix is claimed whole.
    name: 'wiley',
    hosts: ['onlinelibrary.wiley.com'],
    matches: (doi) => isWileyDoi(doi),
    extractId: (doi) => wileyArticleId(doi),
    landingUrl: (id) => wileyLandingUrl(id),
    pdfUrl: (id) => wileyPdfUrl(id),
    manualLabel: 'Wiley article page',
    headed: false,
    samples: [
      { doi: '10.1002/advs.202004433', url: null },
      { doi: '10.1111/1740-9713.01393', url: null },
    ],
  },
  {
    // ACS. Cloudflare 403s every plain client, and all ten free PDFs in a 40-DOI sample
    // were on pubs.acs.org -- chemistry is poorly covered by the OA mirrors the other
    // sources use, so the bridge is the only route to a free ACS article.
    //
    // Like OUP (and for the same reason -- both run on Silverchair) the PDF url is NOT
    // constructible: the download path carries a journal code and an internal asset id.
    // The url Unpaywall reports, /doi/pdf/<doi>, 404s. See acs-retrieval.js.
    name: 'acs',
    hosts: ['pubs.acs.org'],
    matches: (doi) => isAcsDoi(doi),
    extractId: (doi) => acsArticleId(doi),
    landingUrl: (id) => acsLandingUrl(id),
    pdfUrl: () => null,
    preferPdfLink: ACS_PDF_LINK,
    manualLabel: 'ACS article page',
    headed: false,
    // Verified live through the bridge: the /doi/<doi> landing page for the first DOI
    // yields the real Silverchair download link.
    samples: [
      { doi: '10.1021/jacs.6c07767', url: null },
      { doi: '10.1021/09826-toc', url: null },
    ],
  },
  {
    // OUP. The only entry here whose PDF url is NOT constructible: OUP's download path
    // carries an internal asset id that appears nowhere in the DOI, and advance articles
    // use a different shape again. pdfUrl therefore returns null and the resolver reads the
    // link out of the rendered page, the same path Mendeley Data takes.
    //
    // The landing page IS resolvable offline: doi.org 302s straight to the article URL and
    // that redirect is served to a plain client, so only the destination is walled.
    // extractId is synchronous and answers from a discovery URL or a memoized resolve;
    // resolveId does the round trip a bare DOI needs, exactly as the Elsevier pair do.
    name: 'oup',
    hosts: ['academic.oup.com'],
    matches: (doi, url) => isOupDoi(doi) || Boolean(oupArticlePath(url)),
    extractId: (doi, url) => oupArticlePath(url) || cachedOupPath(doi) || null,
    resolveId: (doi, url, options) => (oupArticlePath(url)
      ? Promise.resolve(oupArticlePath(url))
      : oupPath(doi, options)),
    landingUrl: (id) => oupLandingUrl(id),
    // No constructible PDF url -- see the header of oup-retrieval.js for both observed
    // download path shapes and why neither is derivable from the DOI.
    pdfUrl: () => null,
    // An OUP article page links its supplementary material as .pdf too, and those satisfy
    // the shape rules and the %PDF- check just as well as the full text does. Without this
    // the first link wins and a supplement gets filed as the paper, which is worse than a
    // failed download because nothing downstream can detect it. Both observed full-text
    // path shapes ("/article-pdf/" and "/advance-article-pdf/") end in the same token.
    preferPdfLink: /\/(advance-)?article-pdf\//,
    manualLabel: 'OUP article page',
    headed: false,
    // Each sample carries the article URL as well as the DOI because extractId is
    // synchronous and a bare DOI has no path until something resolves it. The second is the
    // advance-article shape, which differs from the volume/issue one.
    samples: [
      {
        doi: '10.1093/nar/gkaa1100',
        url: 'https://academic.oup.com/nar/article/49/D1/D480/6006196',
      },
      {
        doi: '10.1093/bjs/znad132',
        url: 'https://academic.oup.com/bjs/article/110/8/996/7163415',
      },
    ],
  },
];

/**
 * First entry that claims this paper, or null. Awaits `matches` so a publisher whose
 * discriminator needs a network lookup (see the cell.com note above) fits the same
 * interface as a regexp matcher. Entries are expected to be mutually exclusive; the
 * registry test enforces that, so first-match cannot silently hide an overlap.
 *
 * `options` is passed to every matcher untouched. It exists so a network-backed
 * discriminator can be given an injected lookup (and an AbortSignal) instead of reaching
 * for the network itself, which is what keeps the registry's guards offline.
 */
async function findPublisher(doi, url = null, options = {}) {
  for (const entry of PUBLISHERS) {
    let claimed = false;
    try {
      claimed = await entry.matches(doi, url, options);
    } catch (err) {
      // A matcher that throws (a failed network discriminator, a bad argument) must not
      // abort the whole resolver; treat it as "not mine" and let the other sources race.
      // Logged rather than swallowed, so a permanently broken matcher is visible instead
      // of just never firing.
      logger.debug(`publisher ${entry.name} matcher failed: ${err.message}`);
      claimed = false;
    }
    if (claimed) return entry;
  }
  return null;
}

/**
 * Every host any entry fetches from, deduplicated.
 *
 * This is NOT the allowlist and must never become its source. ALLOWED_HOSTS in
 * src/bridge/allowed-hosts.js is the credentialed-fetch trust boundary and stays
 * hand-maintained (it also has to be kept in step with the extension's own copy);
 * deriving it from this file would let any registry edit silently widen the grant.
 * The intended consumer is a test asserting these hosts are a SUBSET of the allowlist,
 * so a new publisher fails loudly until someone deliberately widens the boundary.
 */
function publisherHosts() {
  return [...new Set(PUBLISHERS.flatMap((entry) => entry.hosts.map((h) => h.trim().toLowerCase())))];
}
