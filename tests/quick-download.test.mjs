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

/**
 * Load the worker with a stub `chrome`, and hand back the pieces under test.
 *
 * `fetch` is optional and defaults to a refusal, so the tests that do not care about the
 * network cannot accidentally reach it.
 */
function load(downloads = {}, fetchImpl = null) {
  const created = [];
  // The download is only finished when Chrome says so, so the stub must model the terminal
  // state as well as the call. `state` picks which one it reports.
  const listeners = new Set();
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
    },
    tabs: {
      onCreated: { addListener() {} },
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} },
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
    scripting: { async executeScript() { return [{ result: null }]; } },
  };
  const f = new Function(
    'chrome', 'console', 'URL', 'fetch',
    `${src}\nreturn { pdfFilename, downloadToBrowser, retrievePaper, parseDownloadInput };`,
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
  );
  return { ...api, created };
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

test('the mirrors are tried FIRST, in the order scihub, annas, libgen', async () => {
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

  // FIRST, not merely present: nothing else may precede them.
  assert.equal(order[0], 'scihub', `something ran before the mirrors: ${order.join(' -> ')}`);
});

test('all three phases run in order: mirrors, then open access, then the publisher', async () => {
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
  assert.deepEqual(order, ['scihub', 'annas', 'libgen', 'direct', 'nature'], order.join(' -> '));
});
