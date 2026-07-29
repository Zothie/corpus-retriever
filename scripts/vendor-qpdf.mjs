// Copy qpdf-wasm out of node_modules into extension/vendor/.
//
// The extension ships NO runtime dependencies and has no bundler, so the wasm and its
// glue have to be real files inside the package. Fetching either from a CDN at runtime
// is remote-hosted code and is what gets extensions rejected.
//
// Re-run after bumping the devDependency. tests/vendor-qpdf.test.mjs asserts the copies
// exist and are intact, so a missing vendor directory fails the suite rather than shipping.
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(repoRoot, 'node_modules/@neslinesli93/qpdf-wasm/dist');
const to = join(repoRoot, 'extension/vendor');

if (!existsSync(from)) {
  console.error('qpdf-wasm not installed: npm install');
  process.exit(1);
}
mkdirSync(to, { recursive: true });
for (const [src, dst] of [['qpdf.js', 'qpdf.js'], ['qpdf.wasm', 'qpdf.wasm']]) {
  copyFileSync(join(from, src), join(to, dst));
  console.log(`vendored ${dst}`);
}
