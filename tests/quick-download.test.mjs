// The filename and the download call, tested against the worker's own source.
//
// These two functions live in background.js and nowhere else -- the worker imports nothing,
// so there is no module to import here. The source is evaluated with a fake `chrome`, the
// same trick the tab-safety harness uses, which keeps the test honest: it exercises the code
// that actually ships rather than a copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(repoRoot, 'extension/background.js'), 'utf8');

// Both must start with %PDF-, and the slimmed one must be SHORTER: slimPdf keeps the
// original whenever recompression did not actually win, so an equal-length stub would
// silently exercise the fallback and prove nothing.
const ORIGINAL_PDF = new TextEncoder().encode(`%PDF-1.7\n${'padding '.repeat(64)}%%EOF\n`);
const SLIMMED_PDF = new TextEncoder().encode('%PDF-1.7\nslimmed\n%%EOF\n');

/**
 * Load the worker with a stub `chrome`, and hand back the pieces under test.
 *
 * `fetch` is optional and defaults to a refusal, so the tests that do not care about the
 * network cannot accidentally reach it.
 */
function load(downloads = {}, fetchImpl = null, tabsWork = false) {
  const created = [];
  // The download is only finished when Chrome says so, so the stub must model the terminal
  // state as well as the call. `state` picks which one it reports.
  const listeners = new Set();
  const createdListeners = new Set();
  const tabsOpened = [];
  let pageLinks = null;
  const removedFiles = [];
  const erased = [];
  const chrome = {
    downloads: {
      async download(opts) {
        created.push(opts);
        if (downloads?.throws) throw new Error(downloads.throws);
        return 7;
      },
      search(_q, cb) {
        cb([{ id: 7, state: downloads?.state || 'complete' }]);
      },
      onChanged: {
        addListener(f) { listeners.add(f); },
        removeListener(f) { listeners.delete(f); },
      },
      // Chrome starts these ITSELF when a navigation lands on a Content-Disposition
      // response. The worker watches them so it can clean up a file nobody asked for.
      onCreated: {
        addListener(f) { createdListeners.add(f); },
        removeListener(f) { createdListeners.delete(f); },
      },
      async removeFile(id) { removedFiles.push(id); },
      async erase(q) { erased.push(q); },
    },
    // A tab stub that REFUSES by default.
    //
    // Deliberate: with a working chrome.tabs, every ladder test actually enters the tab wait
    // and sits out the full budget, turning a 30s suite into one that hangs for minutes. The
    // ladder tests care about the ORDER sources are tried in, which a refusal establishes
    // just as well as a timeout. Only the stray-download test needs the tab path to open, and
    // it asks for it explicitly and pairs it with a 1ms budget.
    tabs: {
      onCreated: { addListener() {}, removeListener() {} },
      onUpdated: { addListener() {}, removeListener() {} },
      onRemoved: { addListener() {}, removeListener() {} },
      async create(opts) {
        // Every tab this extension opens passes through here -- withClearedTab holds the
        // only chrome.tabs.create in the worker. Recording them is what lets a test assert
        // "no window appeared", which is the single most user-visible property there is.
        tabsOpened.push(opts && opts.url);
        if (!tabsWork) throw new Error('no tabs in this test');
        return { id: 1 };
      },
      async get() { return { id: 1, url: '' }; },
      async query() { return []; },
      async update() {},
      async reload() {},
      async remove() {},
    },
    alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
    runtime: {
      connectNative() { throw new Error('no host'); },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
      onMessage: { addListener() {} },
      id: 't',
    },
    storage: { session: { get: async () => ({}), set: async () => {} } },
    scripting: {
      // Returns whatever a test put in `pageLinks`. Defaulting to null meant the link
      // HARVEST FILTER in fetchLinks was never executed by any test -- which is how a filter
      // that dropped every mirror link survived. See the fetchLinks test below.
      async executeScript({ func }) {
        // The worker runs several different in-page probes through this one API. Returning
        // one canned value for all of them made the tab never clear; the harvest is only
        // reached once pageIsCleared says the page is ready.
        const name = typeof func === 'function' ? func.name : '';
        if (name === 'inPagePdfLinks') return [{ result: pageLinks }];
        if (name === 'pageIsCleared') return [{ result: 'cleared' }];
        return [{ result: null }];
      },
    },
  };
  // The ONLY route to the wasm slimmer is chrome.runtime.getURL('vendor/qpdf.*'), so
  // counting those calls is a direct observation of whether a code path reached qpdf --
  // it cannot be satisfied by anything else the worker does.
  const qpdfUrlAsks = [];
  chrome.runtime.getURL = (path) => {
    if (/qpdf/.test(path)) qpdfUrlAsks.push(path);
    return `chrome-extension://t/${path}`;
  };
  // A stand-in for the vendored qpdf glue.
  //
  // `self.importScripts(...)` is the worker's only way to load it, and the glue's job is to
  // define the global `Module` factory -- so the stub does exactly that, backed by a tiny
  // MEMFS that hands back SLIMMED_PDF. That makes "the saved bytes are the recompressed
  // ones" observable. A call count could not: it would pass just as happily for a code path
  // that ran qpdf and then threw the result away.
  const qpdfRuns = [];
  const self = {
    importScripts() {
      globalThis.Module = async () => {
        const files = new Map();
        return {
          FS: {
            writeFile(path, bytes) { files.set(path, bytes); },
            readFile(path) {
              const got = files.get(path);
              if (!got) throw new Error(`no such file: ${path}`);
              return got;
            },
            unlink(path) {
              if (!files.delete(path)) throw new Error(`no such file: ${path}`);
            },
          },
          callMain(argv) {
            qpdfRuns.push(argv);
            files.set('/out.pdf', SLIMMED_PDF);
            return 0;
          },
        };
      };
    },
  };
  // A clock the test can move. The mirror phase's budget is 90 SECONDS, so the only way to
  // exercise "the probe spent the phase" without a test that takes a minute and a half is to
  // let the stub probe advance time itself. Everything else about Date is Node's own.
  const skew = { ms: 0 };
  class ClockDate extends Date {
    constructor(...args) {
      if (args.length) super(...args);
      else super(Date.now() + skew.ms);
    }
    static now() { return Date.now() + skew.ms; }
  }
  const f = new Function(
    'chrome', 'console', 'URL', 'fetch', 'self', 'Date',
    `${src}\nreturn { pdfFilename, downloadToBrowser, retrievePaper, parseDownloadInput, fetchPdf, fetchLinks,`
    + `\n  slimPdf, bytesToBase64, base64ToBytes,`
    + `\n  setProbe: (fn) => { probeAvailability = fn; },`
    + `\n  mirrorPhaseDeadline: () => currentMirrorCeiling(),\n  setMirrorPhaseDeadline, clearMirrorPhaseDeadline };`,
  );
  const api = f(
    chrome,
    { warn() {}, log() {}, error() {} },
    // The REAL URL, unmodified.
    //
    // This is the whole point. The previous harness passed a FakeURL carrying
    // createObjectURL/revokeObjectURL, so the blob path "worked" in tests and threw
    // TypeError in every real download -- an MV3 service worker has no Blob URL store and
    // therefore no URL.createObjectURL at all. The stub was testing itself.
    //
    // Node's URL has no createObjectURL either, which is exactly the environment the worker
    // actually runs in, so a regression to the blob path fails here instead of shipping.
    URL,
    fetchImpl || (async () => { throw new Error('the network is not available in this test'); }),
    self,
    ClockDate,
  );
  return {
    ...api,
    skew,
    created,
    tabsOpened,
    setPageLinks: (v) => { pageLinks = v; },
    qpdfRuns,
    qpdfUrlAsks,
    removedFiles,
    erased,
    // Pretend Chrome saved a file on its own, the way a navigation at a
    // Content-Disposition response does.
    emitBrowserDownload: (id) => { for (const f of createdListeners) f({ id }); },
    watching: () => createdListeners.size > 0,
  };
}

test('a title becomes the filename', () => {
  const { pdfFilename } = load();
  assert.equal(
    pdfFilename('Nanometre-scale thermometry in a living cell', '10.1038/nature12373'),
    'Nanometre-scale thermometry in a living cell.pdf',
  );
});

test('path separators and Windows-forbidden characters are replaced', () => {
  const { pdfFilename } = load();
  const out = pdfFilename('A/B: "C" <D> |E| *F? \\G', '10.1/x');
  assert.doesNotMatch(out, /[\\/:*?"<>|]/, `still unsafe: ${out}`);
  assert.match(out, /\.pdf$/);
});

test('the name is capped so the whole path stays under filesystem limits', () => {
  const { pdfFilename } = load();
  const out = pdfFilename('x'.repeat(400), '10.1/x');
  assert.ok(out.length <= 124, `too long: ${out.length}`);
});

test('a trailing dot or space is stripped', () => {
  // Windows drops them silently, which collapses two different papers onto one filename.
  const { pdfFilename } = load();
  assert.equal(pdfFilename('Ends with a dot.', '10.1/x'), 'Ends with a dot.pdf');
  assert.equal(pdfFilename('Ends with a space ', '10.1/x'), 'Ends with a space.pdf');
});

test('a title that sanitises to nothing falls back to the DOI', () => {
  // The case that matters: a paper whose title the filesystem mangles must still download.
  const { pdfFilename } = load();
  assert.equal(pdfFilename('///', '10.1038/nature12373'), '10.1038-nature12373.pdf');
  assert.equal(pdfFilename(null, '10.1038/nature12373'), '10.1038-nature12373.pdf');
  assert.equal(pdfFilename('', null), 'paper.pdf');
});

test('a url with no DOI keeps its own basename', () => {
  // Without this every pasted link lands as paper.pdf, and the second becomes "paper (1)".
  const { pdfFilename } = load();
  assert.equal(pdfFilename(null, null, 'https://arxiv.org/pdf/2301.00001v2'), '2301.00001v2.pdf');
  assert.equal(pdfFilename(null, null, 'https://example.org/a/b/paper.pdf'), 'paper.pdf');
  // A basename that is itself a traversal attempt must not survive as one.
  const out = pdfFilename(null, null, 'https://example.org/x/%2e%2e%2f%2e%2e%2fetc');
  assert.doesNotMatch(out, /[\\/]/, `basename reintroduced a separator: ${out}`);
  // A url with no usable path segment still produces something.
  assert.equal(pdfFilename(null, null, 'https://example.org/'), 'paper.pdf');
  assert.equal(pdfFilename(null, null, 'not a url'), 'paper.pdf');
});

test('the download hands Chrome a DATA url and waits for it to finish', async () => {
  const { downloadToBrowser, created } = load();
  const out = await downloadToBrowser(btoa('%PDF-1.4 hello'), 'x.pdf');
  assert.equal(out.ok, true);
  assert.equal(created.length, 1);
  assert.equal(created[0].filename, 'x.pdf');
  assert.equal(created[0].saveAs, false);
  // NOT a blob: url. URL.createObjectURL does not exist in an MV3 service worker, so the
  // blob path threw TypeError on every real download and nothing ever reached the download
  // manager. This assertion is the regression guard.
  assert.match(created[0].url, /^data:application\/pdf;base64,/);
  // The bytes must survive the trip intact.
  assert.equal(
    Buffer.from(created[0].url.split(',')[1], 'base64').toString(),
    '%PDF-1.4 hello',
  );
});

test('the worker never calls URL.createObjectURL', async () => {
  // A structural guard, because the failure is silent and total: the source must not reach
  // for an API the runtime does not have. Checked against the real source rather than a
  // stub -- a stub is what hid this bug in the first place.
  assert.doesNotMatch(
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1'),
    /URL\.(createObjectURL|revokeObjectURL)/,
    'MV3 service workers have no Blob URL store; use a data: url',
  );
});

test('an interrupted download is reported as a failure, not a success', async () => {
  // download() resolving only means an id was assigned. Treating that as success would
  // report "Saved x.pdf" for a file that never landed.
  const { downloadToBrowser } = load({ state: 'interrupted' });
  const out = await downloadToBrowser(btoa('%PDF-'), 'x.pdf');
  assert.equal(out.ok, false);
  assert.match(out.error, /interrupted/);
});

test('a download Chrome refuses is reported, not thrown', async () => {
  const { downloadToBrowser } = load({ throws: 'user cancelled' });
  const out = await downloadToBrowser(btoa('%PDF-'), 'x.pdf');
  assert.equal(out.ok, false);
  assert.match(out.error, /user cancelled/);
});

test('the popup field accepts what the ladder accepts', () => {
  const { parseDownloadInput } = load();
  assert.deepEqual(parseDownloadInput('10.1038/nature12373'), { doi: '10.1038/nature12373' });
  assert.deepEqual(parseDownloadInput('doi:10.1038/nature12373'), { doi: '10.1038/nature12373' });
  assert.deepEqual(
    parseDownloadInput('https://doi.org/10.1038/nature12373'),
    { doi: '10.1038/nature12373' },
  );
  assert.deepEqual(
    parseDownloadInput('2301.00001v2'),
    { pdfUrl: 'https://arxiv.org/pdf/2301.00001v2' },
  );
  // The legacy arXiv shape, which a DOI-only regex silently drops.
  assert.deepEqual(
    parseDownloadInput('cond-mat/0207270'),
    { pdfUrl: 'https://arxiv.org/pdf/cond-mat/0207270' },
  );
  assert.deepEqual(
    parseDownloadInput('https://arxiv.org/abs/2301.00001'),
    { pdfUrl: 'https://arxiv.org/pdf/2301.00001' },
  );
  assert.deepEqual(
    parseDownloadInput('https://example.org/paper.pdf'),
    { pdfUrl: 'https://example.org/paper.pdf' },
  );
});

test('the popup field REFUSES what the ladder cannot use', () => {
  // Refused before any request: a failed retrieval takes up to a minute, and spending that
  // on a typo is worse than refusing instantly.
  const { parseDownloadInput } = load();
  for (const bad of ['', '   ', 'some paper title', 'http://insecure.example/x.pdf', '10.1038']) {
    assert.equal(parseDownloadInput(bad), null, `should have refused ${JSON.stringify(bad)}`);
  }
});

test('a url on a host the extension does not carry SAYS so', async () => {
  // Dropped silently it ends as a bare "no source produced a valid pdf" with an empty
  // attempts log, which reads as "this paper does not exist".
  const { retrievePaper } = load();
  const out = await retrievePaper({ pdfUrl: 'https://evil.example/x.pdf' });
  assert.equal(out.ok, false);
  assert.deepEqual(out.attempts, [{ source: 'direct', error: 'host not allowlisted' }]);
});

test('the mirrors keep their order, and still precede the publisher', async () => {
  // The ladder order is load-bearing and was previously asserted nowhere, so it could be
  // reordered -- as it has been -- with the whole suite still green. `attempts` is the
  // order the sources actually ran in, which is the thing worth pinning.
  //
  // Every fetch fails, so no source can win and all of them report. That is deliberate:
  // a test where the first source succeeds proves only that ONE source ran.
  const { retrievePaper } = load({}, async () => { throw new Error('offline'); });
  const out = await retrievePaper({ doi: '10.1038/nature12373', email: 'a@b.c' });
  assert.equal(out.ok, false);

  const order = out.attempts.map((a) => a.source);
  const mirrors = order.filter((s) => ['scihub', 'annas', 'libgen'].includes(s));
  assert.deepEqual(mirrors, ['scihub', 'annas', 'libgen'], `ran: ${order.join(' -> ')}`);

  // Mirrors keep their RELATIVE order, but open access now precedes them: measured, a mirror
  // serves at 23 KB/s against 517 for an open-access host, and open access frequently holds
  // the paywalled paper too. What must not change is that a mirror never runs before the
  // cheap phase, and that the publisher tab stays last.
  assert.ok(
    order.indexOf('scihub') < order.indexOf('nature'),
    `a publisher ran before the mirrors: ${order.join(' -> ')}`,
  );
});

test('all three phases run in order: open access, then mirrors, then the publisher', async () => {
  // The publisher phase is the only one that can open a tab and demand the user solve a
  // challenge, so it must stay last. If it drifts ahead of the free sources, the cost of
  // a download becomes the user's attention rather than a few seconds of waiting.
  //
  // Phase 2 is otherwise INVISIBLE in `attempts` -- resolveOaCandidates swallows its own
  // failures, so a phase that found nothing logs nothing. A refused `direct` url is the
  // one entry that phase always emits, so it serves as the marker for where phase 2 ran.
  const { retrievePaper } = load({}, async () => { throw new Error('offline'); });
  const out = await retrievePaper({
    doi: '10.1038/nature12373',
    pdfUrl: 'https://evil.example/x.pdf',
    email: 'a@b.c',
  });

  const order = out.attempts.map((a) => a.source);
  assert.deepEqual(order, ['direct', 'scihub', 'annas', 'libgen', 'nature'], order.join(' -> '));
});

test('the mirror phase ceiling is cleared when the phase ends', async () => {
  // The ceiling bounds every mirror helper to the PHASE rather than to its own budget. Left
  // set, it would still hold the FINISHED call's deadline -- a moment already in the past --
  // so every later download would skip its mirrors outright and never say why. It is cleared
  // in a finally, which has to cover the paths that RETURN a pdf as well as the failures.
  const api = load({}, async () => { throw new Error('offline'); });
  assert.equal(api.mirrorPhaseDeadline(), 0, 'should start unset');
  await api.retrievePaper({ doi: '10.1038/nature12373', email: 'a@b.c' });
  assert.equal(api.mirrorPhaseDeadline(), 0, 'left set after the phase ended');
});

test('a mirror that ANSWERS but does not hold the paper opens no tab', async () => {
  // The bug the user reported twice, in the form the suite could not see. Every mirror
  // replies 200 here -- Anna's does that for papers it does not have -- but none of them
  // shows any sign of holding the paper. Reachability is not evidence, and a tab must not
  // open on it. 133 tests passed while this opened one for every DOI ever downloaded.
  // Each mirror gets the answer IT actually gives for a paper it does not serve, because
  // "no evidence" looks different on each and a generic page would prove nothing.
  const api = load({}, async (url) => {
    // Anna's says it by REDIRECTING to its search page.
    if (url.includes('/scidb/')) {
      return {
        ok: true, status: 200, url: 'https://annas-archive.gd/search?q=x',
        text: async () => '<html><title>Search</title></html>', headers: new Map(),
      };
    }
    // Sci-Hub says it in the page copy, and separately serves a robot check that is not an
    // article either. Both must leave the tab shut.
    if (/sci-hub/.test(url)) {
      return {
        ok: true, status: 200, url,
        text: async () => '<html>This article is not yet available in my database.</html>',
        headers: new Map(),
      };
    }
    // libgen: the search page simply lists no edition for the doi.
    return {
      ok: true, status: 200, url,
      text: async () => '<html><body>No results</body></html>', headers: new Map(),
    };
  }, true);

  await api.retrievePaper({ doi: '10.1016/j.cell.2014.05.010', email: 'a@b.c' });
  assert.deepEqual(api.tabsOpened, [], `opened: ${api.tabsOpened.join(', ')}`);
});

test('a mirror serving a captcha opens no tab', async () => {
  // Measured 2026-07-29: sci-hub.ru answered every doi -- real and invented alike -- with an
  // identically sized robot check, and sci-hub.st answered 403 behind DDoS-Guard. A captcha
  // is not an article page and never becomes one, so opening it shows the user a robot check
  // for a paper the mirror may not even hold.
  //
  // The publisher phase DOES open a tab for a challenge, and that is right: a publisher is
  // known to have the paper, so the user's attention buys something. A mirror serving a
  // captcha has told us nothing, so it buys nothing.
  const api = load({}, async (url) => ({
    ok: true, status: 200, url,
    text: async () => '<html><title>Sci-Hub</title>проверка на робота</html>',
    headers: new Map(),
  }), true);

  await api.retrievePaper({ doi: '10.1016/j.cell.2014.05.010', email: 'a@b.c' });
  assert.deepEqual(api.tabsOpened, [], `opened: ${api.tabsOpened.join(', ')}`);
});

test('two overlapping retrievals cannot un-bound each other', async () => {
  // The ceiling is module-level, so a second retrieval used to overwrite the first's
  // deadline and then, in its finally, set it to ZERO -- leaving the first running its
  // mirror phase with no ceiling at all. The popup and the bridge can both be retrieving at
  // once, and nothing serialises them.
  const api = load({}, async () => { throw new Error('offline'); });
  const a = api.retrievePaper({ doi: '10.1038/nature12373', email: 'a@b.c' });
  const b = api.retrievePaper({ doi: '10.1126/science.1259855', email: 'a@b.c' });
  await Promise.all([a, b]);
  // Only once BOTH have left does the ceiling lift.
  assert.equal(api.mirrorPhaseDeadline(), 0, 'the ceiling outlived both phases');
});

test('the ceiling RISES again when the earlier of two phases ends', async () => {
  // The half a counter could not express. While two phases overlap the ceiling is the
  // earlier deadline, which is right -- but when that phase ENDS, the survivor must get its
  // own deadline back. A counter could only ever lower the ceiling, so the second of two
  // overlapping downloads stayed pinned to a moment already past and reported "budget
  // exhausted" for mirrors that would have answered. Wrong in the safe direction, and
  // therefore invisible: fewer tabs, not more.
  const api = load({}, async () => { throw new Error('offline'); });
  const early = Date.now() + 1000;
  const late = Date.now() + 90000;

  api.setMirrorPhaseDeadline(early);
  api.setMirrorPhaseDeadline(late);
  assert.equal(api.mirrorPhaseDeadline(), early, 'while both are live, the earlier wins');

  api.clearMirrorPhaseDeadline(early);
  assert.equal(api.mirrorPhaseDeadline(), late, 'the survivor did not get its deadline back');

  api.clearMirrorPhaseDeadline(late);
  assert.equal(api.mirrorPhaseDeadline(), 0, 'the last one out must lift the ceiling');
});

test('a file Chrome saved by itself is erased, not left in Downloads', async () => {
  // The navigate branches point the tab AT the pdf to force a document request. When the
  // response carries a Content-Disposition, Chrome SAVES it -- nothing here asked it to.
  // Unerased, the user gets a file under Chrome's own name for a paper that may well have
  // failed, which is the "it downloaded a pdf but kept opening websites" report.
  //
  // removeFile BEFORE erase: erase alone drops the history row and orphans the bytes on
  // disk, which would be worse than leaving it alone.
  // Driven through fetchPdf, which is where the navigation (and so the stray) happens.
  // A url on a granted mirror host, so the tier gate lets the call reach the tab path.
  const api = load({}, async () => { throw new Error('offline'); }, true);
  // budgetMs is tiny so the tab wait gives up at once: this test is about the CLEANUP that
  // runs afterwards, not about clearing a challenge.
  const done = api.fetchPdf({ url: 'https://libgen.bz/get.php?md5=x&key=y', budgetMs: 1 });
  // The listener is registered synchronously by fetchPdf before it awaits, so by here
  // Chrome's own download is observable exactly as it would be in the browser.
  assert.equal(api.watching(), true, 'fetchPdf did not start watching for stray downloads');
  api.emitBrowserDownload(4242);
  await done;

  assert.deepEqual(api.removedFiles, [4242], 'the stray file was not removed from disk');
  assert.deepEqual(api.erased, [{ id: 4242 }], 'the stray history row was not erased');
  assert.equal(api.watching(), false, 'the onCreated listener outlived the call');
});

test('a retrieval with no DOI does not poison the next call\'s mirror phase', async () => {
  // The no-DOI path SKIPS the mirror phase, so it is the one route that can set the ceiling
  // and never reach the code that clears it. Left set, it holds a timestamp that is already
  // in the past, and every later call then skips its mirrors outright while reporting
  // nothing unusual -- mirrors would simply stop working for the rest of the session.
  const api = load({}, async () => { throw new Error('offline'); });
  await api.retrievePaper({ pdfUrl: 'https://arxiv.org/pdf/2301.00001' });
  assert.equal(api.mirrorPhaseDeadline(), 0, 'the no-doi path left the ceiling set');

  // And prove the consequence, not just the flag: the mirrors must still run afterwards.
  const out = await api.retrievePaper({ doi: '10.1038/nature12373', email: 'a@b.c' });
  const order = out.attempts.map((a) => a.source);
  assert.deepEqual(order.slice(0, 3), ['scihub', 'annas', 'libgen'], order.join(' -> '));
});

// --- the availability probe's hints, as the ladder consumes them ----------------------
//
// The probe is stubbed rather than driven through the network here. Its own behaviour is
// covered by tests/availability.test.mjs; what these tests pin is the LADDER's reaction to a
// given set of hints, which a network stub can only produce indirectly and by accident.

/** Load with `probeAvailability` replaced by one that answers `hints`. */
function loadProbing(hints, { spend = 0 } = {}) {
  const api = load({}, async () => { throw new Error('offline'); });
  api.setProbe(async () => {
    api.skew.ms += spend;
    return { has: {}, ruledOut: [], ...hints };
  });
  return api;
}

const MIRRORS = ['scihub', 'annas', 'libgen'];
const mirrorOrder = (out) => out.attempts.map((a) => a.source).filter((s) => MIRRORS.includes(s));
const entryFor = (out, source) => out.attempts.find((a) => a.source === source);

test('a source the probe ruled out is skipped, and SAYS it was skipped', async () => {
  // Vanishing from `attempts` would make a skipped source indistinguishable from one that was
  // never reached, so a hint that is simply wrong could not be diagnosed from a failure report.
  const api = loadProbing({ ruledOut: ['annas'] });
  const out = await api.retrievePaper({ doi: '10.1038/nature12373', email: 'a@b.c' });

  assert.deepEqual(mirrorOrder(out), MIRRORS, 'the phase order changed');
  const annas = entryFor(out, 'annas');
  assert.match(annas.error, /^skipped: /, `annas did not report a skip: ${annas.error}`);
  assert.match(annas.error, /probe/, `the skip does not say who ruled it out: ${annas.error}`);
});

test('a source the probe found is tried FIRST within its phase', async () => {
  // annas, not libgen: libgen is PINNED LAST regardless of hints, because it is reliable but
  // slow -- measured at 23 KB/s, so a 2.9 MB paper takes 87 seconds there against two from an
  // open-access host. Promoting it would trade a fast download for a slow one, so a "libgen
  // has it" hint is true and still not a reason to go there first.
  const api = loadProbing({ has: { annas: true } });
  const out = await api.retrievePaper({ doi: '10.1038/nature12373', email: 'a@b.c' });

  assert.deepEqual(mirrorOrder(out), ['annas', 'scihub', 'libgen'], 'the hint did not promote');
});

test('when the hinted source fails, the COMPLETE ladder runs -- ruled-out sources included', async () => {
  // The one rule that makes unpaced probing safe. `absent` is a claim the probe can get
  // wrong: a 429 or a captcha page misread as a definitive negative. Trusting it AFTER the
  // promoted source has already failed would turn a wrong hint into a lost paper, when the
  // whole point of the asymmetry is that it costs only latency.
  const api = loadProbing({ has: { annas: true }, ruledOut: ['scihub'] });
  const out = await api.retrievePaper({ doi: '10.1038/nature12373', email: 'a@b.c' });

  // libgen stays last even here: it is pinned regardless of hints, so a full ladder means
  // every source ran, not that the order was abandoned.
  assert.deepEqual(mirrorOrder(out), ['annas', 'scihub', 'libgen'], 'a source was dropped');
  const scihub = entryFor(out, 'scihub');
  assert.doesNotMatch(
    scihub.error,
    /^skipped: /,
    `scihub was still skipped after the hint failed: ${scihub.error}`,
  );
});

test('a probe that spends the mirror budget leaves the ladder UNHINTED', async () => {
  // The probe walks the same mirrors the phase does, so it can spend the phase by itself.
  // Acting on hints bought with the entire budget would reorder and skip a ladder that has
  // no time left to run, so the hints are dropped and the plain ladder stands.
  const api = loadProbing(
    { has: { libgen: true }, ruledOut: ['scihub'] },
    { spend: 120 * 1000 },
  );
  const out = await api.retrievePaper({ doi: '10.1038/nature12373', email: 'a@b.c' });

  assert.deepEqual(mirrorOrder(out), MIRRORS, 'an exhausted probe still reordered the phase');
  const scihub = entryFor(out, 'scihub');
  assert.doesNotMatch(scihub.error, /probe/, `an exhausted probe still ruled out: ${scihub.error}`);
});

test('hints with no mirror in them -- the store build\'s shape -- change nothing', async () => {
  // `probeMirror` and MIRROR_PROBE_NAMES live inside the fence the store build cuts, so the
  // published extension's probe answers for open access only. The ladder must not assume a
  // mirror hint exists.
  const api = loadProbing({ has: { unpaywall: 'https://arxiv.org/pdf/2301.00001' } });
  const out = await api.retrievePaper({
    doi: '10.1038/nature12373',
    pdfUrl: 'https://evil.example/x.pdf',
    email: 'a@b.c',
  });

  const order = out.attempts.map((a) => a.source);
  assert.deepEqual(order, ['direct', 'scihub', 'annas', 'libgen', 'nature'], order.join(' -> '));
});

/** A Response-shaped stub carrying `bytes`, enough for workerFetch's checks. */
function pdfResponse(url, bytes) {
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: () => null },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

test('a popup download is slimmed', async () => {
  // The whole reason this feature exists: a popup download never reaches Corpus Studio,
  // so if it is not slimmed here it is never slimmed at all. The app slims everything it
  // ingests; the toolbar was the one door out of the extension with no optimiser behind it.
  const api = load();
  const saved = await api.downloadToBrowser(api.bytesToBase64(ORIGINAL_PDF), 'p.pdf');
  assert.equal(saved.ok, true, saved.error);

  assert.equal(api.qpdfRuns.length, 1, 'qpdf did not run on the popup path');

  // The bytes Chrome was handed, not merely the fact that qpdf ran: a path that
  // recompressed and then downloaded the original would pass a call-count assertion.
  assert.equal(api.created.length, 1);
  const handed = api.created[0].url.replace(/^data:application\/pdf;base64,/, '');
  assert.equal(handed, api.bytesToBase64(SLIMMED_PDF), 'the ORIGINAL bytes were saved');
});

test('the bridge path is NOT slimmed', async () => {
  // Corpus Studio runs its own qpdf and hashes what it was given. Slimming here would
  // store bytes matching neither the publisher's file nor the app's own output, for no
  // gain -- the app was going to optimise them anyway.
  const url = 'https://arxiv.org/pdf/2301.00001';
  const api = load({}, async () => pdfResponse(url, ORIGINAL_PDF));
  const got = await api.retrievePaper({ pdfUrl: url });
  assert.equal(got.ok, true, got.error);

  // Byte-identical to what the source produced, decoded rather than compared as strings so
  // a re-encoding that happened to round-trip could not hide behind an equal base64 blob.
  assert.deepEqual(api.base64ToBytes(got.base64), ORIGINAL_PDF, 'the bridge bytes were altered');
  assert.equal(got.bytes, ORIGINAL_PDF.length);

  // And prove nothing merely handed the originals back after running qpdf anyway: qpdf must
  // never have been INVOKED on this path.
  //
  // Deliberately not asserted on getURL('vendor/qpdf.js'): the glue is pulled in at top
  // level, once, for the whole worker, because MV3 permits importScripts only during initial
  // evaluation. Asking for the script is therefore not evidence of anything -- running it is.
  assert.deepEqual(api.qpdfRuns, [], 'qpdf ran on the bridge path');
  assert.deepEqual(
    api.qpdfUrlAsks.filter((u) => u.endsWith('.wasm')), [],
    'the bridge path instantiated the qpdf wasm',
  );
});

test('a mirror\'s own links survive the harvest filter', async () => {
  // The filter used isAllowedUrl, which answers only for the CREDENTIALED grant -- and every
  // mirror is ANONYMOUS tier. So it dropped EVERY link on a sci-hub, Anna's or libgen page:
  // the tab opened, hydrated, had its whole harvest filtered away, and spun to the 45s
  // hydration timeout before reporting nothing. A window held open for most of a minute on a
  // page that demonstrably had the PDF, and the paper lost afterwards.
  //
  // No test could see it: executeScript was stubbed to return null, so the filter never ran.
  const api = load({}, async () => { throw new Error('offline'); }, true);
  api.setPageLinks([
    'https://sci-hub.ru/storage/twin/6718/kucsko2013.pdf',
    'https://sci-hub.ru/about',
  ]);
  const out = await api.fetchLinks({ url: 'https://sci-hub.ru/10.1/x', budgetMs: 5000 });
  assert.equal(out.ok, true, out.error);
  assert.ok(
    out.links.includes('https://sci-hub.ru/storage/twin/6718/kucsko2013.pdf'),
    `the mirror's own pdf link was filtered out: ${JSON.stringify(out.links)}`,
  );
});

test('a link on a host we do not carry is still refused', async () => {
  // The widening above must not become "collect anything". Tier is the gate; an ungranted
  // host stays out, and credentials are still derived per-url at fetch time.
  const api = load({}, async () => { throw new Error('offline'); }, true);
  api.setPageLinks(['https://sci-hub.ru/storage/a.pdf', 'https://evil.example/x.pdf']);
  const out = await api.fetchLinks({ url: 'https://sci-hub.ru/10.1/x', budgetMs: 5000 });
  assert.deepEqual(out.links, ['https://sci-hub.ru/storage/a.pdf']);
});
