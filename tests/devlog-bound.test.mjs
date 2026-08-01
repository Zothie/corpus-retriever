// The devlog trace, re-shaped at the host<-Chrome boundary.
//
// Every other extension reply is field-allowlisted before it reaches a socket client;
// `report` used to cross verbatim, so a broken or replaced extension could hand a whole
// 64 MiB frame of arbitrary JSON straight through. boundedDevlogReport is the shaping, and
// this file is what proves the bound is a bound rather than a gesture -- three of the four
// evasions below were measured escaping an earlier version of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const { boundedDevlogReport } = await import(join(repoRoot, 'src/bridge/corpus-retriever-host.js'));

const size = (o) => JSON.stringify(o).length;

// The whole-report allowance in corpus-retriever-host.js, plus room for the shaping itself.
const CEILING = 600 * 1024;

test('a legitimate trace passes through intact', () => {
  // The bound is worthless if it mangles the thing it is protecting. A real devlog event is
  // small, and every one of its fields has to survive with its own type -- `evidence` stays
  // an OBJECT rather than becoming the serialised string the truncation path returns.
  const report = {
    totalMs: 1234,
    events: [{
      kind: 'decide',
      label: 'annas',
      at: 5,
      ms: 12,
      verdict: 'skip',
      because: 'no record',
      detail: { page: null, lastError: 'http 503' },
      evidence: { status: 503 },
    }],
  };
  assert.deepEqual(boundedDevlogReport(report), report);
});

test('a huge field is truncated rather than passed on', () => {
  const out = boundedDevlogReport({
    totalMs: 1,
    events: [{ kind: 'a', label: 'b', at: 1, detail: Array(200_000).fill('xy') }],
  });
  assert.ok(size(out) < 16 * 1024, `report was ${size(out)} chars`);
  assert.match(out.events[0].detail, /\[truncated\]$/);
});

test('MANY events each just under the per-field cap cannot add up past the report cap', () => {
  // The evasion that defeated the first version, and the reason a per-field cap is not a
  // bound. 1000 events x {detail, evidence} x 4096 chars is 8 MB, every field individually
  // legal -- measured at 8,058,024 chars, which is not meaningfully smaller than the 64 MiB
  // frame the shaping exists to prevent.
  const out = boundedDevlogReport({
    totalMs: 1,
    events: Array.from({ length: 5000 }, () => ({
      kind: 'k', label: 'l', at: 1, detail: 'x'.repeat(4000), evidence: 'y'.repeat(4000),
    })),
  });
  assert.ok(size(out) < CEILING, `report was ${size(out)} chars`);
});

test('a getter that throws costs its own field, not the whole reply', () => {
  // Reading `e.detail` RUNS the getter, so the read has to be inside the try. The first
  // version called cap(e.detail) -- the read happened in the argument position, outside
  // cap's own try -- and the exception propagated past boundedDevlogReport entirely,
  // measured. The host caught it upstream and the client got nothing back at all.
  const event = { kind: 'k', label: 'l', at: 1 };
  Object.defineProperty(event, 'detail', {
    get() { throw new Error('boom'); },
    enumerable: true,
  });
  const out = boundedDevlogReport({ totalMs: 1, events: [event] });
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].kind, 'k');
  assert.equal(out.events[0].detail, undefined);
});

test('a toJSON returning something huge is capped like any other big value', () => {
  // The cap is applied to the SERIALISED text, so a value that is small until JSON.stringify
  // asks it to grow is measured at its real size rather than its apparent one.
  const out = boundedDevlogReport({
    totalMs: 1,
    events: [{ kind: 'k', label: 'l', at: 1, detail: { toJSON: () => 'z'.repeat(5_000_000) } }],
  });
  assert.ok(size(out) < 16 * 1024, `report was ${size(out)} chars`);
});

test('a cycle is recorded as unserialisable rather than thrown', () => {
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  const out = boundedDevlogReport({
    totalMs: 1, events: [{ kind: 'k', label: 'l', at: 1, detail: cyclic }],
  });
  assert.equal(out.events[0].detail, '[unserialisable]');
});

test('a deeply nested object cannot blow the stack or the size', () => {
  let deep = {};
  let cursor = deep;
  for (let i = 0; i < 100_000; i += 1) { cursor.n = {}; cursor = cursor.n; }
  const out = boundedDevlogReport({
    totalMs: 1, events: [{ kind: 'k', label: 'l', at: 1, detail: deep }],
  });
  assert.ok(size(out) < 16 * 1024, `report was ${size(out)} chars`);
});

test('a flood of non-object events is bounded by the event count', () => {
  const out = boundedDevlogReport({
    totalMs: 1, events: Array(100_000).fill('x'.repeat(100)),
  });
  assert.ok(out.events.length <= 1000, `kept ${out.events.length} events`);
  assert.ok(size(out) < CEILING, `report was ${size(out)} chars`);
});

test('a report that is not a report at all becomes an empty one', () => {
  for (const bad of [null, undefined, 'a string', 42, [1, 2, 3]]) {
    assert.deepEqual(boundedDevlogReport(bad), { totalMs: 0, events: [] });
  }
});
