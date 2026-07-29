// Re-inline extension/search-sources.js into background.js.
//
//   node scripts/inline-search-sources.mjs
//
// background.js is a CLASSIC service worker and must import nothing: a static import breaks
// registration outright, and a dynamic import() throws when the message arrives, which is
// worse because a worker that throws dies silently and takes the bridge socket with it.
// So the search adapters exist twice.
//
// Run this after ANY edit to search-sources.js. tests/search-parity.test.mjs fails until you
// do -- which is how the drift that broke every upstream filter was caught, after the module
// had been updated and the worker was still running the old copy.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const START = '// ---8<--- search sources (inlined) ---8<---';

/**
 * Strip a module's import line and its export keywords, leaving plain script text.
 *
 * `importLine` is optional because a module that imports NOTHING is the safest kind to
 * inline -- there is no line to cut and nothing to keep in step. Passing an empty string
 * to String.split would split the source between every character, so the no-import case
 * takes the whole file instead of being made to fake an import it does not have.
 */
function inlinable(file, importLine = '') {
  const src = readFileSync(join(repoRoot, file), 'utf8');
  let body = src;
  if (importLine) {
    body = src.split(importLine, 2)[1];
    if (!body) {
      console.error(`${file} no longer starts with ${importLine} -- update this script`);
      process.exit(1);
    }
  }
  const out = body
    .replace(/\nexport const /g, '\nconst ')
    .replace(/\nexport async function /g, '\nasync function ')
    .replace(/\nexport function /g, '\nfunction ')
    .trim();
  // An import that survives into background.js breaks worker registration outright, so it
  // is caught HERE rather than in the browser, where the failure is silent.
  if (/^\s*import\s/m.test(out)) {
    console.error(`${file} still contains an import after inlining -- update this script`);
    process.exit(1);
  }
  return out;
}

const IMPORT = "import { credentialsFor } from './allowlist.js';";
const inlined = [
  inlinable('extension/search-sources.js', IMPORT),
  inlinable('extension/oa-sources.js', IMPORT),
  // NOT fenced, and deliberately names no mirror: it reads the mirror list from the fenced
  // region at call time and copes with that region being absent. Fencing it would take the
  // OA half of the probe out of the store build too.
  inlinable('extension/availability.js'),
  // NOT fenced. The slimmer is ordinary optimisation code with no mirror hostnames in it,
  // so the store build must KEEP it -- fencing it here would ship a popup that never slims.
  inlinable('extension/slim-pdf.js'),
  // Fenced, because the store build has to REMOVE it. mirror-sources.js is deleted from the
  // package as a file, but its functions and its hardcoded sci-hub / libgen / annas hostnames
  // are inlined HERE -- so deleting the file alone shipped every one of those strings to
  // reviewers in background.js, which is the single most likely cause of rejection.
  [
    '// ---8<--- mirror sources (inlined) ---8<---',
    inlinable(
      'extension/mirror-sources.js',
      "import { credentialsFor, urlTier, TIER } from './allowlist.js';",
    ),
    '// ---8<--- end mirror sources ---8<---',
  ].join('\n'),
  readFileSync(join(repoRoot, 'extension/publishers-bundle.js'), 'utf8')
    .replace(/^\/\/ GENERATED[\s\S]*?^const paperRateLimiter = .*$/m, (m) => m)
    .trim(),
].join('\n\n');

const bgPath = join(repoRoot, 'extension/background.js');
const bg = readFileSync(bgPath, 'utf8');
const at = bg.indexOf(START);
if (at === -1) {
  console.error('background.js is missing the inline marker');
  process.exit(1);
}
// Keep the marker and its explanatory paragraph; replace everything after it.
const headerEnd = bg.indexOf('\n\n', at) + 2;
writeFileSync(bgPath, `${bg.slice(0, headerEnd) + inlined}\n`, 'utf8');

console.log(`inlined ${inlined.length} chars into background.js`);
