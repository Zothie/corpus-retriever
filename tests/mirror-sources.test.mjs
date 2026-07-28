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
const { scihubMirrors, scihubArticleUrl, pickScihubPdf, libgenPdfUrl, annasArticleUrl, pickAnnasPdf } =
  await import(join(repoRoot, 'extension/mirror-sources.js'));

const realFetch = globalThis.fetch;
function stubFetch(handler) { globalThis.fetch = async (url, opts) => handler(String(url), opts || {}); }
test.afterEach(() => { globalThis.fetch = realFetch; });

const textRes = (body) => ({ ok: true, status: 200, text: async () => body });

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

test("anna's keeps the DOI slash literal", async () => {
  // encodeURIComponent would send 10.1016%2Fj..., which Anna's accepts (both forms return
  // the same 108,784-byte page) but which is not the form the site links to itself.
  stubFetch(async () => textRes('<html></html>'));
  const out = await annasArticleUrl('10.1016/j.jfineco.2019.05.005');
  assert.equal(out, 'https://annas-archive.gd/scidb/10.1016/j.jfineco.2019.05.005');
  assert.doesNotMatch(out, /%2F/i);
});

test("anna's picks a file link out of a hydrated page", () => {
  const page = 'https://annas-archive.gd/scidb/10.1/x';
  assert.equal(pickAnnasPdf(['/scidb/dl/abc/paper.pdf'], page),
    'https://annas-archive.gd/scidb/dl/abc/paper.pdf');
  assert.match(pickAnnasPdf(['https://ipfs.io/ipfs/Qm123'], page), /\/ipfs\//);
  assert.equal(pickAnnasPdf(['/about', '/donate'], page), null);
});

test("anna's falls through to the next mirror", async () => {
  const tried = [];
  stubFetch(async (url) => {
    const host = new URL(url).hostname;
    tried.push(host);
    if (host === 'annas-archive.gd') throw new TypeError('Failed to fetch');
    return textRes('<html></html>');
  });
  const out = await annasArticleUrl('10.1/x');
  assert.match(out, /annas-archive\.pk/);
  assert.deepEqual(tried, ['annas-archive.gd', 'annas-archive.pk']);
});
