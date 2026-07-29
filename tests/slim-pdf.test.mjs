// The slimmer is optional by construction: a download must never fail because an
// optimisation did. Every one of these cases returns the ORIGINAL bytes, which is the
// same guard optimize.ts already applies on the app side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(repoRoot, 'extension/slim-pdf.js'), 'utf8')
  .replace(/\nexport async function /g, '\nasync function ')
  .replace(/\nexport function /g, '\nfunction ')
  .replace(/\nexport const /g, '\nconst ');

/** Load slim-pdf.js with an injected qpdf runner, so no wasm is needed in unit tests. */
function load(runQpdf) {
  const f = new Function('runQpdf', 'console', `${src}\nreturn { slimPdf };`);
  return f(runQpdf, { warn() {}, log() {}, error() {} });
}

const original = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3, 4, 5, 6, 7, 8]);

test('a smaller result replaces the original', async () => {
  const smaller = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2]);
  const { slimPdf } = load(async () => smaller);
  assert.deepEqual([...await slimPdf(original)], [...smaller]);
});

test('a result that is not smaller is discarded', async () => {
  // Replacing a file with a bigger one for no reason is a regression; optimize.ts
  // refuses it for the same reason.
  const bigger = new Uint8Array(original.length + 10).fill(0x41);
  bigger.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0);
  const { slimPdf } = load(async () => bigger);
  assert.deepEqual([...await slimPdf(original)], [...original]);
});

test('a qpdf failure returns the original, and does not throw', async () => {
  const { slimPdf } = load(async () => { throw new Error('qpdf exploded'); });
  assert.deepEqual([...await slimPdf(original)], [...original]);
});

test('output that is not a pdf is refused', async () => {
  // qpdf writing something that does not start with %PDF- means the run went wrong in a
  // way its exit code did not report. Saving that would corrupt the user's file.
  const { slimPdf } = load(async () => new Uint8Array([1, 2, 3]));
  assert.deepEqual([...await slimPdf(original)], [...original]);
});

test('empty output is refused', async () => {
  const { slimPdf } = load(async () => new Uint8Array(0));
  assert.deepEqual([...await slimPdf(original)], [...original]);
});
