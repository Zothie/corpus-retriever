// Does the extension actually LOAD?
//
// Written after shipping a service worker that could not start:
//
//   Service worker registration failed. Status code: 15
//   Uncaught SyntaxError: The requested module './allowlist.js' does not provide an
//   export named 'isAllowedNavigationUrl'
//
// Every other test passed. They import the modules individually, which resolves each file
// but never checks that background.js's import list is satisfiable -- and the extension is
// dead on arrival if it is not. Chrome reports this only in its own UI, so nothing in a
// terminal caught it, and the symptom downstream was "no bridge socket found", which reads
// like Chrome is closed rather than like a syntax error.
//
// A manifest change also cannot be hot-applied: chrome.runtime.reload() does not reload the
// manifest, so this failure needs a human at chrome://extensions. That makes it expensive
// and worth a cheap test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(repoRoot, 'extension');

/** Every `import { a, b } from './x.js'` in a file, as {specifier, names}. */
function importsOf(src) {
  const out = [];
  const re = /import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({
      names: m[1].split(',').map((s) => s.trim()).filter(Boolean),
      specifier: m[2],
    });
  }
  return out;
}

/** Every `export const NAME` / `export function NAME` in a file. */
function exportsOf(src) {
  return (src.match(/^export\s+(?:const|let|var|function|class)\s+(\w+)/gm) || [])
    .map((line) => line.split(/\s+/).pop());
}

const jsFiles = readdirSync(extDir).filter((f) => f.endsWith('.js'));

test('every name imported inside the extension is actually exported', () => {
  // The exact failure above. Cheap to check, expensive to discover in Chrome.
  for (const file of jsFiles) {
    const src = readFileSync(join(extDir, file), 'utf8');
    for (const { names, specifier } of importsOf(src)) {
      assert.ok(specifier.startsWith('./'), `${file}: only relative imports are usable in an extension (${specifier})`);
      const target = specifier.replace(/^\.\//, '');
      assert.ok(jsFiles.includes(target), `${file} imports ${specifier}, which does not exist`);
      const available = exportsOf(readFileSync(join(extDir, target), 'utf8'));
      for (const name of names) {
        assert.ok(
          available.includes(name),
          `${file} imports { ${name} } from ${specifier}, which does not export it`,
        );
      }
    }
  }
});

test('the whole module graph evaluates', async () => {
  // Catches what static analysis cannot: a circular import, a throw at module scope, a
  // syntax error in a file nothing else pulls in. background.js references chrome.* at
  // load time, so only the leaf modules are imported here -- but those are the ones the
  // extraction refactor actually touched.
  for (const file of ['allowlist.js', 'search-sources.js']) {
    const mod = await import(pathToFileURL(join(extDir, file)).href);
    assert.ok(Object.keys(mod).length > 0, `${file} exported nothing`);
  }
});

test('the service worker entry does not import', () => {
  // Stronger than "the manifest agrees with the code", and the reason is a failure that
  // cost several reload cycles: Chrome refused to register the worker with "does not
  // provide an export named isAllowedNavigationUrl" while the export was present, Node
  // resolved every name, and the loaded directory was confirmed to be the edited one. The
  // module graph was removed rather than diagnosed further, because a worker that fails to
  // register is SILENT -- no bridge socket, which reads downstream as "Chrome is closed"
  // and needs a human at chrome://extensions to clear.
  //
  // Only the ENTRY is constrained. Other files may be modules; they cannot strand the
  // extension, because nothing loads them at registration time.
  const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
  const worker = manifest.background.service_worker;
  const src = readFileSync(join(extDir, worker), 'utf8');
  assert.doesNotMatch(src, /^import\s/m, `${worker} must not import`);
  // And with no imports in the entry, "type": "module" only changes how Chrome parses it,
  // for no benefit.
  assert.equal(manifest.background.type, undefined,
    'the entry has no imports, so it must not be declared a module');
});

test('every file the manifest names exists', () => {
  const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
  const worker = manifest.background?.service_worker;
  assert.ok(worker, 'no service worker declared');
  assert.ok(jsFiles.includes(worker), `manifest names ${worker}, which is missing`);
});

test('the manifest parses and its host permissions are well formed', () => {
  // Chrome allows `*` only as a LEADING label. An infix wildcard is a malformed pattern
  // and the extension refuses to load -- previously reported by hand as
  // "URL pattern '*://prod-...-*.s3.*.amazonaws.com/*' is malformed".
  const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
  for (const pattern of manifest.host_permissions || []) {
    const m = /^(\*|https?):\/\/([^/]+)\/(.*)$/.exec(pattern);
    assert.ok(m, `malformed host permission: ${pattern}`);
    const host = m[2];
    const labels = host.split('.');
    for (let i = 1; i < labels.length; i += 1) {
      assert.ok(!labels[i].includes('*'), `${pattern}: '*' is only valid as the first label`);
    }
  }
});
