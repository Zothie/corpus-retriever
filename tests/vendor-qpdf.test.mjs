// The vendored glue is the ONE dependency in a codebase that otherwise ships none, so it
// gets the same structural check the worker itself gets: an `import` anywhere in it would
// break service-worker registration, and an ESM-only build could not be importScripts'd
// at all. That is the property that made this library usable and mupdf-wasm not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(repoRoot, 'extension/vendor');
const dist = join(repoRoot, 'node_modules/@neslinesli93/qpdf-wasm/dist');
const glue = join(vendorDir, 'qpdf.js');
const wasm = join(vendorDir, 'qpdf.wasm');

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

test('importScripts of the glue happens at TOP LEVEL, not inside a function', () => {
  // MV3 allows importScripts ONLY while the service worker is first evaluating. Called
  // later, from inside an async function, Chrome refuses with "NetworkError: The script
  // failed to load" even though the file is present and a fetch of the same url returns
  // 200 with the right bytes -- measured in a real loaded extension.
  //
  // That failure is INVISIBLE to every other test here: slimPdf catches it and returns the
  // original bytes, so each download merely looks like a PDF qpdf could not improve. The
  // suite stayed green while the feature did nothing at all, which is exactly the shape of
  // MV3 trap 2. Only a real browser found it, so this guards the placement structurally.
  const src = readFileSync(join(repoRoot, 'extension/slim-pdf.js'), 'utf8');
  const lines = src.split('\n');
  const at = lines.findIndex((l) => l.includes('self.importScripts('));
  assert.ok(at !== -1, 'slim-pdf.js no longer loads the glue at all');

  // Brace depth, not indentation. Indentation is cosmetic and a nested call can be written
  // at any column; only the depth says whether this runs during initial evaluation. The
  // one wrapper allowed is the top-level try/catch that keeps a missing glue from taking
  // the whole worker down, so depth must be 0 or 1.
  let depth = 0;
  for (const line of lines.slice(0, at)) {
    // Strip strings and line comments first, so a brace inside either does not count.
    const code = line.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '').replace(/\/\/.*$/, '');
    for (const ch of code) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
  }
  assert.ok(
    depth <= 1,
    `importScripts runs at brace depth ${depth}: it must load during initial worker `
    + 'evaluation, not from inside a function',
  );
  assert.doesNotMatch(
    lines.slice(0, at).join('\n'),
    /(async\s+)?function[^\n]*\{[^}]*$/,
    'importScripts sits inside a function declaration',
  );
});

test('the qpdf glue and wasm are vendored into the extension', () => {
  assert.ok(existsSync(glue), 'run: npm run vendor:qpdf');
  assert.ok(existsSync(wasm), 'run: npm run vendor:qpdf');
  assert.ok(statSync(wasm).size > 500_000, 'wasm looks truncated');
});

test('the vendored glue contains no ESM import', () => {
  const src = readFileSync(glue, 'utf8');
  assert.doesNotMatch(src, /^\s*import\s/m, 'a static import breaks worker registration');
  assert.doesNotMatch(src, /\bimport\s*\(/, 'a dynamic import kills the worker silently');
  // The worker gets the factory as the global `Module`, so a release that renames that
  // symbol leaves the glue loading fine and every call site reading `undefined`.
  assert.match(src, /^var Module = \(/m, 'the factory is no longer the global `Module`');
});

// A vendored copy is only as good as its freshness: bump the devDependency without re-running
// `npm run vendor:qpdf` and every other assertion here still passes while the extension ships
// last version's glue. The copy is also not atomic - it writes qpdf.js and then qpdf.wasm, so
// a failure between the two pairs NEW glue with OLD wasm, which breaks nowhere except inside
// the MV3 service worker at runtime, where the worker just dies without a message. Hashing
// both files against node_modules is the only check that sees either case. Skipped in a clean
// checkout: the vendored files are committed and must be testable with no devDependencies.
test('the vendored copies match node_modules', { skip: !existsSync(dist) }, () => {
  for (const f of ['qpdf.js', 'qpdf.wasm'])
    assert.equal(sha256(join(vendorDir, f)), sha256(join(dist, f)), `${f} is stale: run npm run vendor:qpdf`);
});
