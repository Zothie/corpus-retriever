// Bundle the publisher registry into the extension.
//
//   node scripts/bundle-publishers.mjs
//
// The publisher resolvers live in src/publishers/*-retrieval.js. They are plain ES modules
// server. Rather than maintain a second hand-written copy in the extension -- the drift this
// codebase has paid for repeatedly -- this concatenates the real modules into one plain
// script the classic service worker can carry.
//
// Only three of the ten import anything a worker lacks, and only a logger, which is shimmed
// to console. Everything else is already pure: no axios, no puppeteer, no node builtins.
// A module that grows a real Node dependency will fail the check below rather than silently
// produce a broken bundle.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Dependency order: a module must appear after anything it uses.
const MODULES = [
  'src/publishers/doi-path-safety.js',
  'src/publishers/elsevier-pii.js',
  'src/publishers/ssrn-retrieval.js',
  'src/publishers/cell-retrieval.js',
  'src/publishers/sciencedirect-retrieval.js',
  'src/publishers/mendeley-retrieval.js',
  'src/publishers/digitalcommons-retrieval.js',
  'src/publishers/nature-retrieval.js',
  'src/publishers/springer-retrieval.js',
  'src/publishers/wiley-retrieval.js',
  'src/publishers/acs-retrieval.js',
  'src/publishers/oup-retrieval.js',
  'src/publishers/publishers.js',
];

// Imports that cannot exist in a service worker. `axios` and `utils/browser` would mean the
// module still expects Node; `utils/logger` and `rate-limiter` are shimmed below.
const FORBIDDEN = /from '(axios|puppeteer[^']*|\.\.\/utils\/browser\.js)'/;
const SHIMMED = /^import .* from '\.\.\/utils\/(logger|rate-limiter)\.js';?$/;

// Every non-MODULES specifier this bundle is allowed to import FROM, and what satisfies it.
//
// This list is the whole point of the import audit below. Stripping is unconditional -- every
// `import ... from './x.js'` line is deleted -- so a specifier that is NOT concatenated and
// NOT provided leaves its identifiers as free variables in the bundle. Two of those shipped
// before this check existed: `unpaywallSearch` (academic-apis.js is not in MODULES, so
// classifyScienceDirectAccess threw ReferenceError instead of probing) and
// `PATH_CONSTRAINED_HOSTS` (supplied by the allowlist inlined ahead of the bundle in
// background.js, which is real but was undocumented and untested).
const EXTERNAL = new Map([
  ['../utils/logger.js', { provides: ['createLogger'], by: 'header shim' }],
  ['../utils/rate-limiter.js', { provides: ['paperRateLimiter'], by: 'header shim' }],
  ['./academic-apis.js', { provides: ['unpaywallSearch'], by: 'header shim' }],
  ['../bridge/allowed-hosts.js', { provides: ['PATH_CONSTRAINED_HOSTS'], by: 'the host script (extension/allowlist.js, inlined ahead of this bundle)' }],
]);

/** Every `import {a, b} from 'spec'` / `import d from 'spec'` in a source, names included. */
function importsOf(src) {
  const found = [];
  for (const m of src.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*'([^']+)'/g)) {
    found.push({
      spec: m[2],
      names: m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean),
    });
  }
  for (const m of src.matchAll(/import\s+(\w+)\s+from\s*'([^']+)'/g)) {
    found.push({ spec: m[2], names: [m[1]] });
  }
  return found;
}

const moduleSet = new Set(MODULES.map((m) => m.split('/').pop()));
const parts = [];
const problems = [];
for (const rel of MODULES) {
  const src = readFileSync(join(repoRoot, rel), 'utf8');
  if (FORBIDDEN.test(src)) {
    console.error(`${rel} imports something a service worker cannot provide`);
    process.exit(1);
  }

  // AUDIT the imports before stripping them. A dropped import is invisible in the output --
  // the bundle parses fine and fails at call time -- so this is the only place it can be
  // caught. It also answers the "module added to src/publishers/ but not to MODULES" case:
  // publishers.js imports every resolver, so a forgotten entry surfaces here as an
  // unsatisfied specifier rather than as a source that silently never fires.
  for (const { spec, names } of importsOf(src)) {
    if (moduleSet.has(spec.split('/').pop()) && spec.startsWith('.')) continue;
    const ext = EXTERNAL.get(spec);
    if (!ext) {
      problems.push(`${rel}: imports '${spec}', which is neither in MODULES nor in EXTERNAL.`
        + ' Add the file to MODULES (in dependency order) or declare what provides it.');
      continue;
    }
    const missing = names.filter((n) => !ext.provides.includes(n));
    if (missing.length > 0) {
      problems.push(`${rel}: imports ${missing.join(', ')} from '${spec}', but ${ext.by}`
        + ` only provides ${ext.provides.join(', ')}.`);
    }
  }

  const body = src
    // Whole-text first: multi-line import blocks span lines and a per-line filter leaves
    // their identifiers behind.
    .replace(/^import\s*\{[\s\S]*?\}\s*from\s*'[^']+';?$/gm, '')
    .replace(/^import\s+\w+\s+from\s*'[^']+';?$/gm, '')
    .split('\n')
    .filter((line) => {
      if (SHIMMED.test(line.trim())) return false;
      // Cross-module imports are unnecessary once concatenated.
      if (/^import .* from '\.\//.test(line.trim())) return false;
      if (/^import .* from '\.\.\/bridge\//.test(line.trim())) return false;
      return true;
    })
    .join('\n')
    .replace(/\nexport const /g, '\nconst ')
    .replace(/\nexport async function /g, '\nasync function ')
    .replace(/\nexport function /g, '\nfunction ')
    // Multi-line re-export blocks too: `export {\n  a,\n  b,\n};` spans lines, and a
    // single-line pattern left the identifiers behind as a syntax error.
    .replace(/\nexport\s*\{[\s\S]*?\}\s*;?/g, '')
    // Each module makes its own logger; one shim serves them all.
    .replace(/^const logger = createLogger\([^)]*\);$/gm, '');

  // Private helpers repeat across modules -- elsevier-pii and oup both define their own
  // resolveViaDoiOrg, for instance. Concatenation makes those duplicate declarations, so
  // every module-private name is prefixed with its file. Exported names are left alone:
  // they are the ones other modules call by name.
  const tag = rel.split('/').pop().replace(/[-.]/g, '_').replace(/_js$/, '');
  const exported = new Set(
    [...src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/gm)]
      .map((m) => m[1]),
  );
  const declared = [...body.matchAll(/^(?:async\s+)?function\s+(\w+)|^const\s+(\w+)\s*=/gm)]
    .map((m) => m[1] || m[2])
    .filter((n) => n && !exported.has(n));
  let scoped = body;
  for (const name of new Set(declared)) {
    scoped = scoped.replace(new RegExp(`\\b${name}\\b`, 'g'), `${tag}$${name}`);
  }
  parts.push(`// --- ${rel} ---\n${scoped.trim()}`);
}

const header = `// GENERATED by scripts/bundle-publishers.mjs -- do not edit.
//
// The ten publisher resolvers, concatenated from src/tools/*-retrieval.js so the classic
// service worker can carry them without importing. Editing this file is pointless: rerun
// the script. tests/publisher-bundle.test.mjs asserts it matches its sources.
//
// createLogger is shimmed to console because the modules only ever call logger.debug on a
// failed lookup, and a worker has no winston.
function createLogger() {
  return { debug() {}, info() {}, warn(...a) { console.warn(...a); }, error(...a) { console.warn(...a); } };
}
const logger = createLogger();
// The modules rate-limit doi.org lookups. In the extension those are ordinary fetches from
// the user's own browser at human frequency, so the limiter is a no-op rather than a port.
const paperRateLimiter = { acquire: async () => {} };
// sciencedirect-retrieval's access probe calls unpaywallSearch, which lives in
// academic-apis.js -- an axios/xml2js module that CANNOT be bundled into a worker. The import
// was stripped and nothing replaced it, so classifyScienceDirectAccess threw ReferenceError
// on the first probe and every ScienceDirect article silently fell through to "unknown".
// Ported here as a plain fetch that speaks the same reply shape the probe destructures.
// Unpaywall requires a contact address and refuses a request without one, so this borrows the
// worker's own contactEmail() -- the same anonymous per-install address every other OA source
// uses. Guarded by typeof because this file is also loadable on its own, where that function
// does not exist; with no address the probe returns no results, which classifies as
// "unknown", the attempt-anyway branch and the same outcome as an outage.
async function unpaywallSearch({ doi, email } = {}) {
  if (!doi) return { content: [{ text: JSON.stringify({ results: [] }) }] };
  const contact = email
    || (typeof contactEmail === 'function' ? await contactEmail().catch(() => null) : null);
  if (!contact) return { content: [{ text: JSON.stringify({ results: [] }) }] };
  const url = new URL(\`https://api.unpaywall.org/v2/\${encodeURIComponent(doi)}\`);
  url.searchParams.set('email', contact);
  const res = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(\`unpaywall HTTP \${res.status}\`);
  const data = await res.json();
  return { content: [{ text: JSON.stringify({ results: [data] }) }] };
}

`;

if (problems.length > 0) {
  console.error(`REFUSING TO BUNDLE: ${problems.length} unsatisfied import(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

// A resolver in src/publishers/ that is not in MODULES is absent from the extension with no
// symptom at all -- the registry entry it feeds simply never claims a DOI. publishers.js
// importing it makes the audit above catch the common case, but a resolver nothing imports
// yet would still slip through, so the directory itself is compared to the list.
const RESOLVER_EXEMPT = new Set([
  // Node-only, deliberately not in the extension: axios/xml2js API clients and the mirror
  // sources, which the extension carries as its own inlined copies.
  'academic-apis.js', 'download-validator.js', 'libgen-retrieval.js', 'scihub-retrieval.js',
]);
const onDisk = readdirSync(join(repoRoot, 'src/publishers')).filter((f) => f.endsWith('.js'));
const unlisted = onDisk.filter((f) => !moduleSet.has(f) && !RESOLVER_EXEMPT.has(f));
if (unlisted.length > 0) {
  console.error(`REFUSING TO BUNDLE: src/publishers/ has ${unlisted.length} file(s) missing from MODULES:`);
  for (const f of unlisted) console.error(`  ${f}`);
  console.error('Add each to MODULES in dependency order, or to RESOLVER_EXEMPT if it is Node-only.');
  process.exit(1);
}

writeFileSync(join(repoRoot, 'extension/publishers-bundle.js'), header + parts.join('\n\n') + '\n', 'utf8');
console.log(`bundled ${MODULES.length} modules -> extension/publishers-bundle.js`);
