// The vendored glue is the ONE dependency in a codebase that otherwise ships none, so it
// gets the same structural check the worker itself gets: an `import` anywhere in it would
// break service-worker registration, and an ESM-only build could not be importScripts'd
// at all. That is the property that made this library usable and mupdf-wasm not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const glue = join(repoRoot, 'extension/vendor/qpdf.js');
const wasm = join(repoRoot, 'extension/vendor/qpdf.wasm');

test('the qpdf glue and wasm are vendored into the extension', () => {
  assert.ok(existsSync(glue), 'run: npm run vendor:qpdf');
  assert.ok(existsSync(wasm), 'run: npm run vendor:qpdf');
  assert.ok(statSync(wasm).size > 500_000, 'wasm looks truncated');
});

test('the vendored glue contains no ESM import', () => {
  const src = readFileSync(glue, 'utf8');
  assert.doesNotMatch(src, /^\s*import\s/m, 'a static import breaks worker registration');
  assert.doesNotMatch(src, /\bimport\s*\(/, 'a dynamic import kills the worker silently');
});
