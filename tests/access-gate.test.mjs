// The publisher access gate: asking BEFORE opening a tab.
//
// ScienceDirect is the only entry that declares one, and the reason is arithmetic. Nearly all
// of its content needs a subscription, so spending the full 120s publisher budget on a tab --
// and possibly a human challenge -- for a paper another source already has free costs the user
// a minute to learn nothing. The gate answers from Unpaywall alone, in ~200ms, before any tab
// exists.
//
// This existed and did NOTHING for two rounds of auditing. First it could not run at all: it
// imports unpaywallSearch from a module the bundler cannot include, the bundler stripped the
// import unconditionally, and the name shipped as a free variable -- so the probe threw
// ReferenceError, its own catch swallowed it, and every paper came back "unknown". Then, once
// that was fixed, nothing READ the verdict. These pin the wiring, not the classifier.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(repoRoot, 'extension/background.js'), 'utf8');

test('the gate is consulted before an identifier is resolved', () => {
  // Order is the whole point: resolveId can be a network round trip and landingUrl leads to a
  // tab, so a gate consulted after either has already spent what it exists to save.
  const gate = src.indexOf('entry.accessGate.classify(');
  const resolve = src.indexOf('await entry.resolveId(doi, pdfUrl || null, {})');
  assert.ok(gate !== -1, 'nothing calls accessGate.classify -- the gate is dormant again');
  assert.ok(resolve !== -1, 'the resolveId call site moved; this test needs updating');
  assert.ok(gate < resolve, 'the gate must be consulted BEFORE resolveId');
});

test('a skip verdict short-circuits before any tab can be opened', () => {
  // `gated` must gate the identifier, because everything that opens a tab hangs off `id`.
  assert.match(src, /const id = gated\s*\n\s*\? null/,
    'a gated skip must prevent the identifier from being resolved at all');
});

test('a skip says WHY, and says it only once', () => {
  // An unexplained absence from the attempts log reads as a source that was never tried. The
  // first version of this logged the skip AND then fell through to "could not resolve an
  // identifier", claiming two different reasons for one decision.
  assert.match(src, /skipped: a free copy is available elsewhere/,
    'a gated skip must appear in the attempts log with its reason');
  assert.match(src, /\} else if \(!gated\) \{\s*\n(\s*\/\/.*\n)*\s*attempts\.push\(\{ source: entry\.name, error: 'could not resolve an identifier' \}\)/,
    'the "could not resolve" branch must not also fire for a gated skip');
});

test('the gated budget reaches EVERY fetch in the publisher attempt', () => {
  // Three call sites take a budget: the direct-pdf fetch, the landing-page link read, and the
  // fetch of the link it found. A reduced budget applied to only the first would be spent
  // three times over on a paper the gate already judged unlikely.
  const phase = src.slice(src.indexOf('PHASE 2 -- the publisher'), src.indexOf('PHASE 3'));
  const budgeted = [...phase.matchAll(/budgetMs: (\w+)/g)].map((m) => m[1]);
  assert.ok(budgeted.length >= 3, `expected at least 3 budgeted calls, found ${budgeted.length}`);
  assert.deepEqual(
    [...new Set(budgeted)], ['budget'],
    `every publisher fetch must use the gated budget, found: ${budgeted.join(', ')}`,
  );
});

test('an entry with no gate is unaffected', () => {
  // Nine of the ten publishers declare no gate, and a missing accessGate must mean "attempt,
  // with the normal budget" rather than "skip" or "throw".
  assert.match(src, /let budget = PUBLISHER_BUDGET_MS;/,
    'the budget must default to the normal publisher budget');
  assert.match(src, /if \(entry\.accessGate\) \{/,
    'the gate must be consulted only where one is declared');
});

test('a gate that throws does not take down the publisher phase', () => {
  // classify() is a network call. If it rejects, the paper must still be attempted -- losing
  // an optimisation is acceptable, losing the publisher is not.
  assert.match(src, /entry\.accessGate\.classify\([^)]*\)\s*\n?\s*\.catch\(\(\) => null\)/,
    'classify must be caught, and a null verdict must fall through to a normal attempt');
});
