// The search adapters that run inside the extension.
//
// These are a REWRITE of src/publishers/science-search.js, not a port: that module reads results
// out of a Puppeteer-rendered DOM, and an MV3 service worker has no DOM at all. So the
// parsing is new code against new endpoints, and new parsing is exactly where breakage
// hides silently -- a selector that stops matching returns zero results rather than an
// error, and a search that quietly returns nothing looks like "no papers found".
//
// The network is stubbed. Fixtures are trimmed from REAL responses captured 2026-07-28, so
// the shapes are the ones the APIs actually send rather than shapes invented to match the
// parser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// The module is an extension ES module importing './allowlist.js'; both are plain ESM, so
// Node can import it directly.
const { searchOne, searchAll, SEARCH_SOURCES } =
  await import(join(repoRoot, 'extension/search-sources.js'));

const realFetch = globalThis.fetch;
function stubFetch(handler) {
  globalThis.fetch = async (url, opts) => handler(String(url), opts || {});
}
test.afterEach(() => { globalThis.fetch = realFetch; });

const jsonRes = (body) => ({
  ok: true, status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
  headers: new Map(),
});
const textRes = (body) => ({
  ok: true, status: 200,
  text: async () => body,
  headers: new Map(),
});

// --- credentials, the security-relevant part ------------------------------------------

test('every search request is anonymous', () => {
  // Search hosts are all anonymous-tier. If one ever went out with credentials it would
  // attach whatever session Chrome holds to a third-party API for no benefit. Asserted per
  // request rather than per source, so a second fetch inside a source cannot slip through.
  const seen = [];
  stubFetch(async (url, opts) => {
    seen.push({ url, credentials: opts.credentials });
    return jsonRes({});
  });
  return Promise.all(SEARCH_SOURCES.map((s) => searchOne(s, { query: 'x' }))).then(() => {
    assert.ok(seen.length > 0, 'no requests were made');
    for (const r of seen) {
      assert.equal(r.credentials, 'omit', `${r.url} was not anonymous`);
    }
  });
});

test('a source whose host is not allowlisted makes no request at all', async () => {
  let called = false;
  stubFetch(async () => { called = true; return jsonRes({}); });
  const out = await searchOne('nope', { query: 'x' });
  assert.equal(called, false);
  assert.match(out.error, /unknown source/);
  assert.deepEqual(out.results, []);
});

// --- SSRN -----------------------------------------------------------------------------

test('ssrn parses the live response shape', async () => {
  // Trimmed from the real api.ssrn.com reply. The <em> markup around query matches is the
  // detail worth pinning: it is in the real data and would otherwise be stored verbatim.
  stubFetch(async (url) => {
    assert.match(url, /^https:\/\/api\.ssrn\.com\/papers\/v1\/papers\/search\/advanced\?/);
    assert.match(url, /text=intraday\+momentum|text=intraday%20momentum/);
    return jsonRes({
      total: 10000,
      // The REAL response shape, captured 2026-07-28. Two field names here were wrong in
      // the first version of this fixture and hid live bugs: authors arrive as `full_name`
      // (not name/first_name), and there is NO `abstract` field at all -- SSRN sends
      // `snippets`, an array of <em>-marked excerpts. Both produced blank columns for every
      // SSRN result while this test passed.
      papers: [{
        id: 2440866,
        title: 'Market <em>Intraday</em> <em>Momentum</em>',
        snippets: ['A <em>momentum</em> effect.'],
        approved_date: '2014-06-11T00:00:00',
        authors: [{ id: 1, full_name: 'Lei Gao' }, { id: 2, full_name: 'Yufeng Han' }],
      }],
    });
  });
  const out = await searchOne('ssrn', { query: 'intraday momentum' });
  assert.equal(out.results.length, 1);
  const r = out.results[0];
  assert.equal(r.title, 'Market Intraday Momentum', 'query-match markup must be stripped');
  assert.equal(r.abstract, 'A momentum effect.');
  assert.equal(r.doi, '10.2139/ssrn.2440866');
  assert.equal(r.url, 'https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2440866');
  assert.equal(r.year, '2014');
  assert.deepEqual(r.authors, ['Lei Gao', 'Yufeng Han']);
  assert.equal(r.source, 'ssrn');
});

test('ssrn sends accept: application/json, which the API requires', async () => {
  // Without it the API answers XML. Load-bearing for the Python client and still so here.
  let headers = null;
  stubFetch(async (url, opts) => { headers = opts.headers; return jsonRes({ papers: [] }); });
  await searchOne('ssrn', { query: 'x' });
  assert.equal(headers?.accept, 'application/json');
});

// --- arXiv ----------------------------------------------------------------------------

const ARXIV_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2202.07171v1</id>
    <title>Investigating the genomic background of CRISPR-Cas genomes</title>
    <published>2022-02-15T03:47:26Z</published>
    <summary>CRISPR-Cas systems are an adaptive immunity that protects
    prokaryotes against foreign genetic elements.</summary>
    <author><name>Alice Example</name></author>
    <author><name>Bob Sample</name></author>
    <link href="https://arxiv.org/pdf/2202.07171v1" rel="related" type="application/pdf"/>
  </entry>
</feed>`;

test('arxiv parses Atom without a DOM', async () => {
  // The reason this parser exists: a service worker has no DOMParser, so the XML is read
  // with patterns instead. Whitespace-folding in <summary> is real -- arXiv hard-wraps it.
  stubFetch(async (url) => {
    assert.match(url, /^https:\/\/export\.arxiv\.org\/api\/query\?/, 'must use https, not the documented http');
    return textRes(ARXIV_ATOM);
  });
  const out = await searchOne('arxiv', { query: 'crispr' });
  assert.equal(out.results.length, 1);
  const r = out.results[0];
  assert.equal(r.title, 'Investigating the genomic background of CRISPR-Cas genomes');
  assert.match(r.abstract, /^CRISPR-Cas systems are an adaptive immunity/);
  assert.doesNotMatch(r.abstract, /\n/, 'wrapped text must be folded to one line');
  assert.equal(r.doi, '10.48550/arXiv.2202.07171');
  assert.equal(r.pdfUrl, 'https://arxiv.org/pdf/2202.07171v1');
  assert.deepEqual(r.authors, ['Alice Example', 'Bob Sample']);
  assert.equal(r.year, '2022');
});

test('arxiv prefers a real journal DOI when the entry carries one', async () => {
  stubFetch(async () => textRes(ARXIV_ATOM.replace(
    '<published>', '<arxiv:doi>10.1038/s41586-020-2649-2</arxiv:doi><published>',
  )));
  const out = await searchOne('arxiv', { query: 'x' });
  assert.equal(out.results[0].doi, '10.1038/s41586-020-2649-2');
});

test('arxiv yields nothing rather than junk when the feed is empty', async () => {
  stubFetch(async () => textRes('<?xml version="1.0"?><feed></feed>'));
  const out = await searchOne('arxiv', { query: 'x' });
  assert.deepEqual(out.results, []);
});

// --- PubMed ---------------------------------------------------------------------------

test('pubmed chains esearch into esummary', async () => {
  // Two round trips is how eutils works: esearch returns only PMIDs.
  const calls = [];
  stubFetch(async (url) => {
    calls.push(url);
    if (url.includes('esearch.fcgi')) {
      return jsonRes({ esearchresult: { idlist: ['42599999'] } });
    }
    return jsonRes({
      result: {
        uids: ['42599999'],
        42599999: {
          title: 'A CRISPR study',
          pubdate: '2024 Mar 15',
          authors: [{ name: 'Carol Author' }],
          articleids: [{ idtype: 'pubmed', value: '42599999' },
            { idtype: 'doi', value: '10.1000/example' }],
        },
      },
    });
  });
  const out = await searchOne('pubmed', { query: 'crispr' });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /esearch\.fcgi/);
  assert.match(calls[1], /esummary\.fcgi/);
  const r = out.results[0];
  assert.equal(r.title, 'A CRISPR study');
  assert.equal(r.doi, '10.1000/example');
  assert.equal(r.url, 'https://pubmed.ncbi.nlm.nih.gov/42599999/');
  assert.equal(r.year, '2024');
});

test('pubmed does not issue a second request when the first finds nothing', async () => {
  let n = 0;
  stubFetch(async () => { n += 1; return jsonRes({ esearchresult: { idlist: [] } }); });
  const out = await searchOne('pubmed', { query: 'zzzz' });
  assert.equal(n, 1, 'esummary must not be asked for an empty id list');
  assert.deepEqual(out.results, []);
});

// --- bioRxiv --------------------------------------------------------------------------

test('biorxiv searches Crossref, filtering type server-side and prefix client-side', async () => {
  // The split is load-bearing and was found by measurement, so it is pinned here.
  // Combining both filters server-side collapses 43,230 hits to 1; filtering by prefix
  // server-side instead fills the page with Cold Spring Harbor JOURNAL articles that share
  // the 10.1101 prefix, leaving zero preprints and a silently empty result set.
  let requested = null;
  stubFetch(async (url) => {
    requested = new URL(url);
    return jsonRes({
      message: {
        items: [
          {
            DOI: '10.1101/2020.06.21.163758', type: 'posted-content',
            title: ['ATP induces protein folding'],
            author: [{ given: 'A', family: 'One' }, { given: 'B', family: 'Two' }],
            issued: { 'date-parts': [[2020, 6, 21]] },
          },
          // A non-bioRxiv preprint: right type, wrong prefix. Must be dropped.
          { DOI: '10.31234/osf.io/xyz', type: 'posted-content', title: ['A psychology preprint'] },
        ],
      },
    });
  });
  const out = await searchOne('biorxiv', { query: 'protein folding' });
  assert.equal(requested.host, 'api.crossref.org');
  assert.equal(requested.searchParams.get('filter'), 'type:posted-content',
    'type is filtered server-side; adding the prefix here over-narrows to almost nothing');
  assert.equal(out.results.length, 1, 'only the 10.1101 preprint should survive');
  const r = out.results[0];
  assert.equal(r.doi, '10.1101/2020.06.21.163758');
  assert.equal(r.pdfUrl, 'https://www.biorxiv.org/content/10.1101/2020.06.21.163758v1.full.pdf');
  assert.deepEqual(r.authors, ['A One', 'B Two']);
  assert.equal(r.year, '2020');
});

// --- failure behaviour ----------------------------------------------------------------

test('a failing source costs its own results and nothing else', async () => {
  // searchAll uses Promise.all, which is only safe because searchOne never rejects. If a
  // source ever throws, one 503 would empty the entire results page.
  stubFetch(async (url) => {
    if (url.includes('ssrn')) throw new TypeError('Failed to fetch');
    return jsonRes({ esearchresult: { idlist: [] }, collection: [] });
  });
  const out = await searchAll(['ssrn', 'biorxiv'], { query: 'x' });
  const ssrn = out.find((o) => o.source === 'ssrn');
  assert.match(ssrn.error, /Failed to fetch/);
  assert.deepEqual(ssrn.results, []);
  assert.ok(out.find((o) => o.source === 'biorxiv'), 'the healthy source must still answer');
});

test('an http error is reported, not thrown', async () => {
  stubFetch(async () => ({ ok: false, status: 503, headers: new Map() }));
  const out = await searchOne('ssrn', { query: 'x' });
  assert.match(out.error, /http 503/);
  assert.deepEqual(out.results, []);
});

test('an empty query is refused without a request', async () => {
  let called = false;
  stubFetch(async () => { called = true; return jsonRes({}); });
  for (const q of ['', '   ', null, undefined, 42]) {
    const out = await searchOne('ssrn', { query: q });
    assert.match(out.error, /empty query/);
  }
  assert.equal(called, false);
});

test('search-sources declares no hardcoded credentials', () => {
  const src = readFileSync(join(repoRoot, 'extension/search-sources.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.deepEqual(src.match(/credentials:\s*'(include|omit)'/g) || [], []);
});
