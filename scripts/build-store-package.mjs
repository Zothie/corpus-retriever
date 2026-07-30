// Build a browser-store upload package.
//
//   node scripts/build-store-package.mjs                          Chrome, store-safe (default)
//   node scripts/build-store-package.mjs --with-mirrors           Chrome, full
//   node scripts/build-store-package.mjs --firefox                Firefox (AMO), store-safe
//   node scripts/build-store-package.mjs --firefox --with-mirrors Firefox (AMO), full
//
// The two targets cross with the mirror axis, giving four artifacts from ONE source tree.
// --firefox differs only in the manifest (see scripts/firefox-manifest.mjs): the 6,900-line
// worker is shared verbatim, because it uses no service-worker-only API.
//
// The unpacked development copy and a Store submission are NOT the same artifact, and the
// differences are not cosmetic:
//
//   key            REMOVED. The Store assigns the id; an uploaded `key` is an upload error.
//                  Removing it also means the id CHANGES, so the native-messaging host
//                  manifest must be rewritten with the assigned id after the first upload --
//                  until then the published extension cannot reach the host at all.
//   icons          REQUIRED (128px). The dev copy ships none.
//   mirror hosts   EXCLUDED by default. sci-hub / libgen / annas-archive host permissions
//                  are the most likely cause of rejection or later removal: facilitating
//                  access to infringing copies violates the Store's policies, and reviewers
//                  do read host_permissions. --with-mirrors keeps them, knowingly.
//
// The default is the safe build because the failure modes are asymmetric. A store-safe build
// that loses three sources is a smaller loss than a takedown after a release pipeline has
// been built around the listing.

import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { firefoxManifest, GECKO_ID, MIN_FIREFOX } from './firefox-manifest.mjs';

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(repoRoot, 'extension');
const outDir = join(repoRoot, 'dist-store');

const withMirrors = process.argv.includes('--with-mirrors');
const firefox = process.argv.includes('--firefox');

// Stage per TARGET, not one shared directory.
//
// dist-store/extension was shared by every build mode, and since the script starts by
// removing outDir, building two artifacts in a row left only the second -- both zips
// existed but described the same tree. That was caught by unzipping a finished package,
// after the wrong one had already been identified as the upload.
const stage = join(outDir, firefox ? 'extension-firefox' : 'extension');
const MIRROR_RE = /sci-hub|libgen|annas-archive|lowyiyiu/i;

// Only THIS target's stage, so building all four in sequence keeps all four zips.
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(src, stage, {
  recursive: true,
  filter: (p) => !/README\.md$|\/\./.test(p),
});

// Strip the mirror code from SOURCE, not just the manifest.
//
// Filtering host_permissions alone left sci-hub/libgen/annas-archive strings in
// allowlist.js and the whole of mirror-sources.js in the package. Reviewers read source,
// and those strings are the single most likely cause of rejection or of removal months
// later. mirror-sources.js is also unreferenced by the extension (only tests import it),
// so removing it costs the store build nothing at all.
if (!withMirrors) {
  await rm(join(stage, 'mirror-sources.js'), { force: true });

  // Cut the FENCED regions out of the worker first.
  //
  // Deleting mirror-sources.js was never enough: its functions and its hardcoded
  // sci-hub / libgen / annas hostnames are INLINED into background.js, so the package still
  // carried every one of them. That was found by grepping a finished package, not by
  // reading the script -- twelve live references in a build whose entire purpose was to
  // have none. Both the phase-3 call site and the inlined block are fenced, so both go.
  const worker = join(stage, 'background.js');
  let workerText = await readFile(worker, 'utf8');
  for (const [open, close] of [
    ['// ---8<--- mirror phase (stripped for the store build) ---8<---', '// ---8<--- end mirror phase ---8<---'],
    ['// ---8<--- mirror sources (inlined) ---8<---', '// ---8<--- end mirror sources ---8<---'],
  ]) {
    const a = workerText.indexOf(open);
    const b = workerText.indexOf(close);
    if (a === -1 || b === -1) {
      console.error(`MISSING FENCE in background.js: ${open}`);
      console.error('The mirror code cannot be stripped safely. Refusing to build.');
      process.exit(1);
    }
    workerText = workerText.slice(0, a) + workerText.slice(b + close.length);
  }
  await writeFile(worker, workerText, 'utf8');

  for (const file of ['allowlist.js', 'background.js']) {
    const path = join(stage, file);
    const text = await readFile(path, 'utf8');
    // Drop the host ENTRIES, and drop whole COMMENT BLOCKS that mention them.
    //
    // Filtering comment lines individually left orphaned continuations behind -- "// Mirrors."
    // and "// mirror networks were blocked from this machine" survived inside
    // ANONYMOUS_HOSTS, so a reviewer grepping "mirror" still found them and the surrounding
    // prose no longer made sense. A comment is a paragraph, so it has to be removed as one.
    const lines = text.split('\n');
    const drop = new Set();
    for (let i = 0; i < lines.length; i += 1) {
      if (!MIRROR_RE.test(lines[i])) continue;
      if (/^\s*'[^']+',?\s*$/.test(lines[i])) { drop.add(i); continue; }
      if (!/^\s*\/\//.test(lines[i])) continue;
      // Walk out to both ends of the contiguous // block this line belongs to.
      let a = i;
      while (a > 0 && /^\s*\/\//.test(lines[a - 1])) a -= 1;
      let b = i;
      while (b < lines.length - 1 && /^\s*\/\//.test(lines[b + 1])) b += 1;
      for (let k = a; k <= b; k += 1) drop.add(k);
    }
    const cleaned = lines.filter((_, i) => !drop.has(i)).join('\n');
    await writeFile(path, cleaned, 'utf8');
  }
}

const manifestPath = join(stage, 'manifest.json');
let manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

if (firefox) {
  // Swaps the service worker for an event page, drops `key`, and adds the Gecko id and the
  // 127 floor. Everything else -- permissions, host_permissions, action, CSP -- carries over.
  manifest = firefoxManifest(manifest);
} else {
  // The Store assigns the id. Keeping `key` pins one it did not issue.
  delete manifest.key;
}

const before = manifest.host_permissions.length;
if (!withMirrors) {
  manifest.host_permissions = manifest.host_permissions.filter((h) => !MIRROR_RE.test(h));
}
const removed = before - manifest.host_permissions.length;

// Icons are mandatory. Absent ones are reported rather than generated: a placeholder icon
// shipped to a store listing is worse than a build that refuses to finish.
const iconDir = join(stage, 'icons');
if (!existsSync(iconDir)) {
  console.error('MISSING: extension/icons/icon128.png (and 48, 16)');
  console.error('The Store requires a 128px icon. Add them, then rerun.');
  process.exit(1);
}
manifest.icons = { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

// Verify the finished STAGE, not the intent.
//
// Every previous version of this script asserted its own correctness by construction and was
// wrong: the file deletion looked sufficient and the inlined copy shipped anyway. So the last
// step greps what is about to be zipped, and a single surviving match fails the build. A
// check that reads the artifact is the only kind that could have caught that.
if (!withMirrors) {
  const offenders = [];
  for (const file of await readdir(stage, { recursive: true })) {
    if (!/\.(js|json|html|css)$/.test(file)) continue;
    const text = await readFile(join(stage, file), 'utf8');
    const hits = text.split('\n')
      .map((line, i) => (MIRROR_RE.test(line) ? `${file}:${i + 1}: ${line.trim().slice(0, 90)}` : null))
      .filter(Boolean);
    offenders.push(...hits);
  }
  if (offenders.length > 0) {
    console.error(`REFUSING TO BUILD: ${offenders.length} mirror reference(s) survived the strip:`);
    for (const o of offenders.slice(0, 20)) console.error(`  ${o}`);
    if (offenders.length > 20) console.error(`  ... and ${offenders.length - 20} more`);
    process.exit(1);
  }
}

// Verify the FIREFOX background files exist, before zipping rather than after installing.
//
// background.scripts names the qpdf glue and the worker by path. If the glue was never
// vendored (`npm run vendor:qpdf`), Firefox fails the whole background page rather than
// just skipping slimming -- so a missing file here costs the extension everything, and it
// is invisible until load. Chrome reaches the same file through importScripts inside a
// try/catch, which is why this check is Firefox-only.
if (firefox) {
  const missing = [];
  for (const rel of manifest.background.scripts) {
    if (!existsSync(join(stage, rel))) missing.push(rel);
  }
  if (missing.length > 0) {
    console.error(`REFUSING TO BUILD: background.scripts names ${missing.length} missing file(s):`);
    for (const m of missing) console.error(`  ${m}`);
    console.error('If it is vendor/qpdf.js, run: npm run vendor:qpdf');
    process.exit(1);
  }
}

// .xpi for Firefox, .zip for Chrome. An xpi IS a zip; AMO accepts either extension, but the
// suffix is what keeps the four artifacts in dist-store/ telling each other apart at a glance.
const ext = firefox ? 'xpi' : 'zip';
const suffix = `${firefox ? '-firefox' : ''}${withMirrors ? '-mirrors' : ''}`;
const zip = join(outDir, `corpus-retriever-${manifest.version}${suffix}.${ext}`);
await rm(zip, { force: true });
await run('zip', ['-r', '-q', zip, '.'], { cwd: stage });

console.log(`package: ${zip}`);
console.log(`target:  ${firefox ? `Firefox ${MIN_FIREFOX}+ (event page)` : 'Chrome (service worker)'}`);
console.log(`version: ${manifest.version}`);
console.log(`hosts:   ${manifest.host_permissions.length} (${removed} mirror hosts removed)`);
if (firefox) console.log(`id:      ${GECKO_ID}`);
if (withMirrors) {
  console.log('WARNING: mirror hosts included. Rejection or later removal is likely.');
}
