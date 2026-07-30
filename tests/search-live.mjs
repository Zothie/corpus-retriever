// Live search sweep across disciplines and query SHAPES.
//
//   node tests/search-live.mjs [--email you@example.org]
//
// NOT part of `npm test`: it talks to five public APIs, so it is slow, rate-limited, and
// fails for reasons that have nothing to do with this code. It exists because the unit tests
// cannot answer the only question that matters -- does a real query return the right papers.
//
// The sweep is deliberately unkind: quotes, hyphens, colons, ampersands, Unicode, chemical
// formulae, single tokens, and a 30-word sentence. Those are the shapes that broke arXiv
// before (quoted phrases 400'd) and that a "works on my query" check never reaches.
//
// Pacing is real: queries run ONE AT A TIME with a gap, because Crossref allows 1 request
// per second anonymously and 3 in the polite pool, and biorxiv resolves through the same
// host. Running the sweep concurrently measures the rate limiter, not the search.

import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const emailArg = process.argv.indexOf('--email');
const EMAIL = emailArg === -1 ? '' : process.argv[emailArg + 1];
// 3000, not 1500. Crossref's limit is a SLIDING window, and one query can make two calls to
// that host (the crossref index, plus biorxiv resolving DOIs through it). At 1500ms the
// sweep itself was the thing tripping the limit -- eight queries reported 429 while the same
// code, measured in isolation, sat comfortably inside the pool at 200/200. The sweep must
// not be the load it is trying to measure.
const GAP_MS = 3000;

// Each case: what it is meant to prove, not just a string.
const CASES = [
  { q: 'ke07 eliminase', why: 'the reported failure: protein engineering, no general index' },
  { q: 'Kemp eliminase KE07 directed evolution', why: 'same topic, natural phrasing' },
  { q: 'perovskite solar cell stability', why: 'materials science' },
  { q: 'monetary policy inflation expectations', why: 'economics' },
  { q: 'Hittite cuneiform tablet dating', why: 'humanities' },
  { q: 'transformer attention mechanism', why: 'computer science' },
  { q: 'CRISPR base editing', why: 'biology' },

  { q: '"attention is all you need"', why: 'QUOTED phrase (400d arXiv before)' },
  { q: 'CO2 reduction Cu2O catalyst', why: 'chemical formulae with digits' },
  { q: 'SARS-CoV-2 spike protein', why: 'hyphens and mixed case' },
  { q: 'p53', why: 'single short token' },
  { q: 'Schrödinger equation numerical', why: 'non-ASCII (umlaut)' },
  { q: 'machine learning & drug discovery', why: 'ampersand, a URL metacharacter' },
  { q: 'RNA-seq: differential expression analysis', why: 'colon plus hyphen' },
  { q: 'graphene 100% efficiency (theoretical)', why: 'percent and parentheses' },
  { q: 'β-lactamase inhibitor resistance', why: 'Greek letter' },
  {
    q: 'we investigate whether large language models trained on scientific literature can predict '
      + 'experimental outcomes in molecular biology without any task specific fine tuning at all',
    why: 'a 30-word sentence, not keywords',
  },
  { q: '10.1038/nature12373', why: 'a DOI: exactly one source must answer' },
];

const browser = await chromium.launchPersistentContext('/tmp/pw-search-live', {
  headless: false,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
await new Promise((r) => setTimeout(r, 3000));
const sw = browser.serviceWorkers()[0]
  || await browser.waitForEvent('serviceworker', { timeout: 15000 });

console.log(`sweep: ${CASES.length} queries, ${GAP_MS}ms apart, email=${EMAIL || '(none)'}\n`);

let hardFail = 0;
const rateLimited = [];

for (const { q, why } of CASES) {
  const groups = await sw.evaluate(
    async ({ query, email }) => {
      try {
        return await searchAll(null, {
          query, maxResults: 5, page: 1, filters: email ? { email } : {},
        });
      } catch (err) {
        return [{ source: 'THREW', error: `${err.name}: ${err.message}`, results: [] }];
      }
    },
    { query: q, email: EMAIL },
  );

  const total = groups.reduce((n, g) => n + g.results.length, 0);
  const errs = groups.filter((g) => g.error);
  const limited = errs.filter((g) => /429|rate-limit/i.test(g.error));
  const threw = groups.some((g) => g.source === 'THREW');

  // A source returning nothing is a legitimate answer (arXiv has no Hittite tablets). A
  // query returning nothing ANYWHERE, or an exception, is a failure.
  const ok = total > 0 && !threw;
  if (!ok) hardFail += 1;
  if (limited.length) rateLimited.push(q);

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${total.toString().padStart(3)} hits  "${q.slice(0, 52)}"`);
  console.log(`      ${why}`);
  const perSource = groups
    .map((g) => `${g.source}:${g.error ? 'ERR' : g.results.length}`)
    .join(' ');
  console.log(`      ${perSource}`);
  const top = groups.flatMap((g) => g.results).sort((a, b) => (b.citations || 0) - (a.citations || 0))[0];
  if (top) console.log(`      top: ${(top.title || '').slice(0, 66)}`);
  for (const e of errs) console.log(`      ! ${e.source}: ${e.error}`);
  console.log();

  await new Promise((r) => setTimeout(r, GAP_MS));
}

console.log('---');
console.log(`${CASES.length - hardFail}/${CASES.length} queries returned results`);
if (rateLimited.length) {
  console.log(`rate-limited on ${rateLimited.length}: ${rateLimited.map((q) => `"${q.slice(0, 24)}"`).join(', ')}`);
  console.log('  (pass --email to enter Crossref\'s polite pool: 1 req/s -> 3 req/s)');
}
await browser.close();
process.exit(hardFail === 0 ? 0 : 1);
