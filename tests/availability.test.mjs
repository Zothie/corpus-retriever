// The probe is a HINT GENERATOR. Its contract is narrow on purpose: it may say "this
// source has it" or "this source definitely does not", and being wrong about either must
// cost latency, never a paper. The ladder re-checks everything it skips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(repoRoot, 'extension/availability.js'), 'utf8')
  .replace(/\nexport async function /g, '\nasync function ')
  .replace(/\nexport function /g, '\nfunction ')
  .replace(/\nexport const /g, '\nconst ');

// The mirror names are DECLARED IN THE PRELUDE rather than passed as a parameter, because
// the shape being modelled is the store build: there the whole fenced mirror region is cut
// and the identifier does not exist at all. `mirrors: null` reproduces that exactly, which a
// function argument (always defined, merely undefined) could not.
const DEFAULT_MIRRORS = ['scihub', 'annas', 'libgen'];

function load(deps, { mirrors = DEFAULT_MIRRORS } = {}) {
  const prelude = mirrors === null ? '' : `const MIRROR_PROBE_NAMES = ${JSON.stringify(mirrors)};\n`;
  const f = new Function(
    'resolveOaCandidates', 'probeMirror', 'console',
    `${prelude}${src}\nreturn { probeAvailability };`,
  );
  return f(deps.resolveOaCandidates, deps.probeMirror, { warn() {}, log() {}, error() {} });
}

const ok = { resolveOaCandidates: async () => [], probeMirror: async () => 'unknown' };

test('an OA hit becomes a positive hint carrying its url', async () => {
  const { probeAvailability } = load({
    ...ok,
    resolveOaCandidates: async () => [{ source: 'unpaywall', pdfUrl: 'https://x/y.pdf' }],
  });
  const hints = await probeAvailability('10.1/x', {});
  assert.equal(hints.has.unpaywall, 'https://x/y.pdf');
});

test('a mirror that reports absent becomes a ruled-out hint', async () => {
  const { probeAvailability } = load({
    ...ok,
    probeMirror: async (name) => (name === 'scihub' ? 'absent' : 'unknown'),
  });
  const hints = await probeAvailability('10.1/x', {});
  assert.ok(hints.ruledOut.includes('scihub'));
});

test('unknown is never ruled out', async () => {
  // The critical asymmetry. A 429, a timeout or a dead host all read as "unknown", and
  // treating those as "absent" would silently lose papers the source actually has.
  const { probeAvailability } = load({ ...ok, probeMirror: async () => 'unknown' });
  const hints = await probeAvailability('10.1/x', {});
  assert.deepEqual(hints.ruledOut, []);
});

test('a probe that throws yields no hints, not a rejection', async () => {
  const { probeAvailability } = load({
    resolveOaCandidates: async () => { throw new Error('offline'); },
    probeMirror: async () => { throw new Error('offline'); },
  });
  const hints = await probeAvailability('10.1/x', {});
  assert.deepEqual(hints, { has: {}, ruledOut: [] });
});

test('no doi means no probe at all', async () => {
  let called = false;
  const { probeAvailability } = load({
    resolveOaCandidates: async () => { called = true; return []; },
    probeMirror: async () => { called = true; return 'unknown'; },
  });
  const hints = await probeAvailability(null, {});
  assert.equal(called, false);
  assert.deepEqual(hints, { has: {}, ruledOut: [] });
});

test('one probe rejecting does not discard the others answers', async () => {
  // Promise.all would throw away three good answers because one host was down. The whole
  // point of probing is to salvage whatever came back.
  const { probeAvailability } = load({
    resolveOaCandidates: async () => { throw new Error('offline'); },
    probeMirror: async (name) => {
      if (name === 'scihub') throw new Error('offline');
      return name === 'libgen' ? 'present' : 'absent';
    },
  });
  const hints = await probeAvailability('10.1/x', {});
  assert.equal(hints.has.libgen, true);
  assert.deepEqual(hints.ruledOut, ['annas']);
});

test('every source is asked at the same time, not one after another', async () => {
  // The reason this module exists is latency, so "concurrent" is the behaviour under test,
  // not an implementation detail. A call-count assertion would pass for a sequential loop,
  // so this observes OVERLAP instead: each stub logs entry and exit, and none may return
  // until all four have entered. A sequential implementation deadlocks on that barrier and
  // is caught by the release timer, which yields an interleaved log rather than a hang.
  const EXPECTED = 4;
  const log = [];
  let release;
  const allEntered = new Promise((resolve) => { release = resolve; });
  const enter = async (name) => {
    log.push(`enter:${name}`);
    if (log.filter((e) => e.startsWith('enter:')).length === EXPECTED) release();
    await Promise.race([allEntered, new Promise((r) => { setTimeout(r, 50); })]);
    log.push(`exit:${name}`);
  };

  const { probeAvailability } = load({
    resolveOaCandidates: async () => { await enter('oa'); return []; },
    probeMirror: async (name) => { await enter(name); return 'unknown'; },
  });
  await probeAvailability('10.1/x', {});

  assert.equal(log.length, EXPECTED * 2);
  assert.deepEqual(
    log.slice(0, EXPECTED).map((e) => e.split(':')[0]),
    Array(EXPECTED).fill('enter'),
    `all ${EXPECTED} probes must be in flight before any completes; got ${log.join(' ')}`,
  );
  assert.deepEqual(
    new Set(log.slice(0, EXPECTED)),
    new Set(['enter:oa', 'enter:scihub', 'enter:annas', 'enter:libgen']),
  );
});

test('the caller credentials reach the OA resolvers', async () => {
  // Unpaywall and PMC REJECT requests with no contact email, so dropping the options here
  // would silently disable half the OA tier rather than fail.
  let seen = null;
  const { probeAvailability } = load({
    ...ok,
    resolveOaCandidates: async (doi, opts) => { seen = { doi, opts }; return []; },
  });
  await probeAvailability('10.1/x', { email: 'a@b.c', coreApiKey: 'K' });
  assert.equal(seen.doi, '10.1/x');
  assert.equal(seen.opts.email, 'a@b.c');
  assert.equal(seen.opts.coreApiKey, 'K');
});

test('an OA source that resolved without a pdf yields no hint', async () => {
  const { probeAvailability } = load({
    ...ok,
    resolveOaCandidates: async () => [{ source: 'openalex' }, { pdfUrl: 'https://x/y.pdf' }],
  });
  const hints = await probeAvailability('10.1/x', {});
  assert.deepEqual(hints.has, {});
});

test('with the mirror region stripped the probe still asks open access', async () => {
  // The store build cuts the fenced mirror code out of background.js entirely, so
  // MIRROR_PROBE_NAMES is not merely empty there -- the identifier does not exist. Reading
  // it unguarded would throw a ReferenceError on every download in the published extension.
  const { probeAvailability } = load({
    ...ok,
    resolveOaCandidates: async () => [{ source: 'core', pdfUrl: 'https://x/y.pdf' }],
    probeMirror: () => { throw new Error('probeMirror does not exist in the store build'); },
  }, { mirrors: null });
  const hints = await probeAvailability('10.1/x', {});
  assert.deepEqual(hints, { has: { core: 'https://x/y.pdf' }, ruledOut: [] });
});

test('probing with no options at all is safe', async () => {
  const { probeAvailability } = load(ok);
  assert.deepEqual(await probeAvailability('10.1/x'), { has: {}, ruledOut: [] });
});
