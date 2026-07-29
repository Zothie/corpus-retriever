// Sci-Hub mirror handling.
//
// The security-relevant part is that the mirror list is REMOTE and therefore untrusted: it
// is fetched from a third-party CDN, so a spoofed or compromised response must not be able
// to point a fetch at a host nobody vetted. The intersection with the allowlist is what
// makes a bad list able only to REMOVE mirrors, never to add one.
//
// LibGen and Anna's ARE wired. An earlier version of this file said they were network-
// blocked here; that was wrong and came from probing DEAD DOMAINS (annas-archive.org/.se,
// libgen.is/.rs/.st). The live sets -- which this repo already configured -- all answer 200.
// Availability is therefore decided per run by probing, never by a hardcoded belief about
// which domains work, because the domains rotate and a stale list looks exactly like an
// outage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  scihubMirrors, scihubArticleUrl, pickScihubPdf, libgenPdfUrl, annasArticleUrl, pickAnnasPdf,
  probeMirror,
} = await import(join(repoRoot, 'extension/mirror-sources.js'));

const realFetch = globalThis.fetch;
function stubFetch(handler) { globalThis.fetch = async (url, opts) => handler(String(url), opts || {}); }
test.afterEach(() => { globalThis.fetch = realFetch; });

// `url` models where the response CAME FROM after redirects, which the real fetch reports
// and this stub used to omit entirely. Anna's says "I do not hold this" only by redirecting,
// so a stub without it cannot express a miss -- and the suite duly stayed green while the
// extension opened a tab for every DOI. Defaults to the requested url, i.e. no redirect.
const textRes = (body, url) => ({ ok: true, status: 200, url, text: async () => body });

test('the live list shape is parsed, trailing slashes and BOM included', async () => {
  // Exactly what the CDN returned when measured: a BOM, bare hosts, trailing slashes.
  stubFetch(async (url) => {
    assert.match(url, /^https:\/\/cdn\.lowyiyiu\.com\/scihub\/\?v=\d+$/, 'must cache-bust');
    return textRes('\uFEFFsci-hub.ru/\nsci-hub.st/\nsci-hub.su/\n');
  });
  assert.deepEqual(await scihubMirrors(), ['sci-hub.ru', 'sci-hub.st', 'sci-hub.su']);
});

test('a spoofed list can only remove mirrors, never add a host', async () => {
  // THE test for this module. The list is third-party, so an attacker who controls it must
  // not be able to make the extension fetch anywhere new. Everything not already granted by
  // the allowlist is dropped.
  stubFetch(async () => textRes([
    'sci-hub.ru/',
    'evil.com/',
    'sci-hub.ru.evil.com/',
    'papers.ssrn.com/',        // real, but CREDENTIALED -- must not be reachable as a mirror
    'localhost/',
    '127.0.0.1/',
  ].join('\n')));
  assert.deepEqual(await scihubMirrors(), ['sci-hub.ru']);
});

test('a failed list fetch falls back rather than losing Sci-Hub', async () => {
  stubFetch(async () => { throw new TypeError('Failed to fetch'); });
  const out = await scihubMirrors();
  assert.ok(out.includes('sci-hub.ru'), 'a CDN outage must not remove the source entirely');
});

test('an empty or junk list falls back too', async () => {
  for (const body of ['', '\n\n', 'not a host\n<<<>>>']) {
    stubFetch(async () => textRes(body));
    const out = await scihubMirrors();
    assert.ok(out.length > 0, `junk list (${JSON.stringify(body)}) must fall back`);
  }
});

test('the mirror list is fetched without credentials', async () => {
  let creds = null;
  stubFetch(async (url, opts) => { creds = opts.credentials; return textRes('sci-hub.ru/'); });
  await scihubMirrors();
  assert.equal(creds, 'omit');
});

test('the article url embeds the DOI whole', () => {
  assert.equal(
    scihubArticleUrl('sci-hub.ru', '10.1016/j.jfineco.2019.05.005'),
    'https://sci-hub.ru/10.1016/j.jfineco.2019.05.005',
  );
});

// --- picking the pdf out of an untrusted page ----------------------------------------

test('a protocol-relative storage href is made absolute', () => {
  // The real shape: Sci-Hub embeds the file from a storage subdomain, protocol-relative.
  assert.equal(
    pickScihubPdf(['//dacemirror.sci-hub.ru/journal/x.pdf', '/about'], 'https://sci-hub.ru/10.1/x'),
    'https://dacemirror.sci-hub.ru/journal/x.pdf',
  );
});

test('a root-relative href resolves against the page', () => {
  assert.equal(
    pickScihubPdf(['/downloads/2020/x.pdf'], 'https://sci-hub.ru/10.1/x'),
    'https://sci-hub.ru/downloads/2020/x.pdf',
  );
});

test('a download token in the query does not stop the match', () => {
  // The path is matched, not the whole url, because some mirrors append ?download=true.
  assert.equal(
    pickScihubPdf(['https://dacemirror.sci-hub.ru/x.pdf?download=true'], 'https://sci-hub.ru/x'),
    'https://dacemirror.sci-hub.ru/x.pdf?download=true',
  );
});

test('non-pdf navigation is not mistaken for the file', () => {
  for (const hrefs of [
    [], ['/about'], ['/donate'], ['javascript:;'], ['#'],
    ['https://sci-hub.ru/alexandra'],
    // http, not https: refused rather than upgraded.
    ['http://dacemirror.sci-hub.ru/x.pdf'],
    ['not a url'],
  ]) {
    assert.equal(pickScihubPdf(hrefs, 'https://sci-hub.ru/10.1/x'), null, JSON.stringify(hrefs));
  }
  assert.equal(pickScihubPdf(null, 'https://sci-hub.ru/x'), null);
});

test('picking grants nothing -- the tier resolver still decides', async () => {
  // pickScihubPdf reads an UNTRUSTED page, so it must never be the thing that authorises a
  // fetch. A url it happily returns can still be refused, and that is the intended split.
  const { urlTier, TIER } = await import(join(repoRoot, 'src/bridge/allowed-hosts.js'));
  const picked = pickScihubPdf(['//evil.com/x.pdf'], 'https://sci-hub.ru/10.1/x');
  assert.equal(picked, 'https://evil.com/x.pdf', 'the picker does not filter by host');
  assert.equal(urlTier(picked), TIER.NONE, 'and the tier resolver refuses it');
});

// --- LibGen -----------------------------------------------------------------------------

test('libgen walks search -> edition -> ads -> get, and requires the key', async () => {
  // The four hops, confirmed live 2026-07-28. The KEY on the last one is per-session and is
  // why the chain cannot be shortcut: a constructed get.php url without it returns a
  // 47-byte redirect stub, which a naive implementation would have stored as the paper.
  const seen = [];
  stubFetch(async (url) => {
    seen.push(new URL(url).pathname + new URL(url).search);
    if (url.includes('index.php')) return textRes('<a href="edition.php?id=82046471">x</a>');
    if (url.includes('edition.php')) {
      return textRes('<a href="/ads.php?md5=de0ed3e4&downloadname=10.1016/x">dl</a>');
    }
    if (url.includes('ads.php')) {
      return textRes(
        '<a href="setlang.php?md5=de0ed3e4&lang=ru">ru</a>'
        + '<a href="get.php?md5=de0ed3e4&key=V84VIXC9">GET</a>',
      );
    }
    return textRes('');
  });
  const out = await libgenPdfUrl('10.1016/j.jfineco.2019.05.005');
  assert.equal(out, 'https://libgen.bz/get.php?md5=de0ed3e4&key=V84VIXC9');
  assert.equal(seen.length, 3, 'exactly three hops before the file url');
});

test('libgen does not mistake setlang for the download', async () => {
  // setlang.php matches a loose "download-ish" pattern and is NOT the file. Requiring
  // key= is what separates them.
  stubFetch(async (url) => {
    if (url.includes('index.php')) return textRes('<a href="edition.php?id=1">x</a>');
    if (url.includes('edition.php')) return textRes('<a href="/ads.php?md5=a">dl</a>');
    if (url.includes('ads.php')) return textRes('<a href="setlang.php?md5=a&lang=ru">ru</a>');
    return textRes('');
  });
  assert.equal(await libgenPdfUrl('10.1/x'), null);
});

test('libgen falls through to the next mirror when one is unavailable', async () => {
  // "Skip only if unavailable AT THE TIME": observed live, a mirror that had just answered
  // returned nothing after repeated probing, then answered again. Availability is decided
  // per run and never cached.
  const tried = [];
  stubFetch(async (url) => {
    const host = new URL(url).hostname;
    tried.push(host);
    if (host === 'libgen.bz') throw new TypeError('Failed to fetch');
    if (host === 'libgen.li') return { ok: false, status: 503 };
    if (url.includes('index.php')) return textRes('<a href="edition.php?id=1">x</a>');
    if (url.includes('edition.php')) return textRes('<a href="/ads.php?md5=a">dl</a>');
    return textRes('<a href="get.php?md5=a&key=K">GET</a>');
  });
  const out = await libgenPdfUrl('10.1/x');
  assert.match(out, /^https:\/\/libgen\.la\//, 'the third mirror should serve it');
  assert.deepEqual(tried.slice(0, 3), ['libgen.bz', 'libgen.li', 'libgen.la']);
});

test('libgen yields null when every mirror is down, without throwing', async () => {
  stubFetch(async () => { throw new TypeError('Failed to fetch'); });
  assert.equal(await libgenPdfUrl('10.1/x'), null);
});

// --- Anna's Archive ---------------------------------------------------------------------

// What Anna's actually does, measured live 2026-07-29 -- and it is a REDIRECT, not wording.
//
// It answers 200 for every /scidb/ url, so the status says nothing. A paper it holds stays
// on /scidb/; a paper it does not hold bounces to /search?index=journals&q="doi:...", which
// followed is a 591 KB results page full of other papers' md5s. That is why the verdict is
// taken from the FINAL URL: every content-based test either rejected real hits (there is no
// download href server-side; the viewer is client-built) or accepted the search page.
//
// `<html></html>` was the fixture here while any HTTP 200 counted as a hit. It cannot be any
// more, and that is the point: reachable is not the same as has-it.
const ANNAS_RECORD = '<html><title>Some Paper - Anna\u2019s Archive</title></html>';
const ANNAS_SEARCH = '<html><title>"doi:x" - Search - Anna\u2019s Archive</title></html>';
const annasHit = (host, path) => textRes(ANNAS_RECORD, `https://${host}${path}`);
const annasMiss = (host) => textRes(ANNAS_SEARCH, `https://${host}/search?index=journals&q=x`);

test("anna's keeps the DOI slash literal", async () => {
  // encodeURIComponent would send 10.1016%2Fj..., which Anna's accepts (both forms return
  // the same 108,784-byte page) but which is not the form the site links to itself.
  stubFetch(async (url) => annasHit(new URL(url).host, new URL(url).pathname));
  const out = await annasArticleUrl('10.1016/j.jfineco.2019.05.005');
  assert.equal(out, 'https://annas-archive.gd/scidb/10.1016/j.jfineco.2019.05.005');
  assert.doesNotMatch(out, /%2F/i);
});

test("anna's answering for a paper it does NOT hold opens no tab", async () => {
  // The reported bug: annasArticleUrl returned a page url whenever a HOST was up, because
  // Anna's answers 200 for every /scidb/ url. The caller then opened a tab to read links
  // that were never going to be there -- the user watched a window appear for a paper they
  // had already downloaded from somewhere else.
  stubFetch(async (url) => annasMiss(new URL(url).host));
  assert.equal(await annasArticleUrl('10.5555/nope'), null);
});

test("anna's picks a file link out of a hydrated page", () => {
  const page = 'https://annas-archive.gd/scidb/10.1/x';
  assert.equal(pickAnnasPdf(['/scidb/dl/abc/paper.pdf'], page),
    'https://annas-archive.gd/scidb/dl/abc/paper.pdf');
  assert.match(pickAnnasPdf(['https://ipfs.io/ipfs/Qm123'], page), /\/ipfs\//);
  assert.equal(pickAnnasPdf(['/about', '/donate'], page), null);
});

// --- the availability probe ---------------------------------------------------------------

// probeMirror answers "does this mirror have it" without opening a tab, and the value of the
// answer rests entirely on 'absent' meaning DEFINITELY NOT. The probe fires alongside every
// other source at once and the rate limiter is a no-op stub, so a 429 is an ordinary outcome;
// if a 429 read as "absent" the ladder would skip a mirror that has the paper and the user
// would be told it does not exist. Every test below exists to hold that line.

test('sci-hub not-found page is the one definitive negative', async () => {
  stubFetch(async (url) => {
    if (url.includes('lowyiyiu')) return textRes('sci-hub.ru/');
    return textRes('<html>Unfortunately, this article is not yet available in my database</html>');
  });
  assert.equal(await probeMirror('scihub', '10.1/x'), 'absent');
});

test('a sci-hub article page reads as present', async () => {
  stubFetch(async (url) => {
    if (url.includes('lowyiyiu')) return textRes('sci-hub.ru/');
    return textRes('<div id="article"><embed src="//dacemirror.sci-hub.ru/x.pdf"></div>');
  });
  assert.equal(await probeMirror('scihub', '10.1/x'), 'present');
});

test('sci-hub hosts that all fail are unknown, never absent', async () => {
  // A dead or rate-limiting host says nothing about the paper. This is the exact case that
  // must not be collapsed into 'absent'.
  stubFetch(async (url) => {
    if (url.includes('lowyiyiu')) return textRes('sci-hub.ru/\nsci-hub.st/');
    throw new TypeError('Failed to fetch');
  });
  assert.equal(await probeMirror('scihub', '10.1/x'), 'unknown');
});

test('sci-hub takes the first host that answers rather than walking them all', async () => {
  // One mirror must not serialise the whole parallel probe behind five timeouts.
  const tried = [];
  stubFetch(async (url) => {
    if (url.includes('lowyiyiu')) return textRes('sci-hub.ru/\nsci-hub.st/\nsci-hub.su/');
    tried.push(new URL(url).hostname);
    if (tried.length === 1) throw new TypeError('Failed to fetch');
    // A page OFFERING the file. An empty <div id="article"> used to satisfy this test, but
    // it is what the robot check looks like too -- and reporting `present` for it is how a
    // tab came to be opened onto a captcha.
    return textRes('<div id="article"><embed src="//dacemirror.sci-hub.ru/x.pdf"></div>');
  });
  assert.equal(await probeMirror('scihub', '10.1/x'), 'present');
  assert.deepEqual(tried, ['sci-hub.ru', 'sci-hub.st'], 'stops at the first that answers');
});

test('a resolver that throws is unknown, not a rejection', async () => {
  // A non-string body makes scihubMirrors throw where nothing else catches it. The probe is
  // called from a Promise.allSettled fan-out, but it still owes its caller a value.
  stubFetch(async () => ({ ok: true, status: 200, text: async () => 12345 }));
  assert.equal(await probeMirror('scihub', '10.1/x'), 'unknown');
});

test('no doi means no probe', async () => {
  let called = false;
  stubFetch(async () => { called = true; return textRes(''); });
  assert.equal(await probeMirror('scihub', null), 'unknown');
  assert.equal(called, false);
});

test('an unrecognised mirror name is unknown', async () => {
  stubFetch(async () => { throw new Error('must not be called'); });
  assert.equal(await probeMirror('nosuchmirror', '10.1/x'), 'unknown');
});

test("anna's is present, absent, or unknown -- and a dead host is never absent", async () => {
  stubFetch(async (url) => annasHit(new URL(url).host, new URL(url).pathname));
  assert.equal(await probeMirror('annas', '10.1/x'), 'present');

  // A DEFINITIVE negative: the host answered, and its answer was the redirect stub it
  // serves for papers it does not hold. Acting on this is what keeps the ladder from
  // opening a tab, and it is only sound because the page itself said so.
  stubFetch(async (url) => annasMiss(new URL(url).host));
  assert.equal(await probeMirror('annas', '10.1/x'), 'absent');

  // THE rule most likely to be broken later, and the reason 'absent' has to be earned:
  // nothing answered at all, which says nothing whatever about the paper.
  stubFetch(async () => { throw new TypeError('Failed to fetch'); });
  assert.equal(await probeMirror('annas', '10.1/x'), 'unknown');

  // A rate limit is not a verdict either.
  stubFetch(async () => ({ ok: false, status: 429 }));
  assert.equal(await probeMirror('annas', '10.1/x'), 'unknown');
});

test('libgen resolving is present, and failing to resolve is UNKNOWN not absent', async () => {
  stubFetch(async (url) => {
    if (url.includes('index.php')) return textRes('<a href="edition.php?id=1">x</a>');
    if (url.includes('edition.php')) return textRes('<a href="/ads.php?md5=a">dl</a>');
    return textRes('<a href="get.php?md5=a&key=K">GET</a>');
  });
  assert.equal(await probeMirror('libgen', '10.1/x'), 'present');

  // Same rule: libgen rate-limits readily, and a 429 is not the paper being missing.
  stubFetch(async () => ({ ok: false, status: 429 }));
  assert.equal(await probeMirror('libgen', '10.1/x'), 'unknown');
});

test("anna's falls through to the next mirror", async () => {
  const tried = [];
  stubFetch(async (url) => {
    const host = new URL(url).hostname;
    tried.push(host);
    if (host === 'annas-archive.gd') throw new TypeError('Failed to fetch');
    return annasHit(host, new URL(url).pathname);
  });
  const out = await annasArticleUrl('10.1/x');
  assert.match(out, /annas-archive\.pk/);
  assert.deepEqual(tried, ['annas-archive.gd', 'annas-archive.pk']);
});
