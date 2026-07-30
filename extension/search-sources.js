// Scientific search, running inside the extension.
//
// This is a REWRITE of src/tools/science-search.js, not a port, and the reason is
// structural: that module drives Puppeteer and reads results out of a rendered DOM
// (`div.gs_ri`, `li.arxiv-result`, `article.full-docsum`). An MV3 service worker has no
// DOM at all -- no `document`, no `DOMParser` -- so every selector-based parser had to be
// moved onto a real API instead.
//
// Measured 2026-07-28, all six answering 200:
//
//   source     endpoint                              format  ACAO
//   ssrn       api.ssrn.com/papers/v1/papers         json    -
//   arxiv      export.arxiv.org/api/query            atom    -
//   pubmed     eutils.ncbi.nlm.nih.gov               json    *
//   biorxiv    api.biorxiv.org                       json    *
//
// A worker holding host_permissions is CORS-exempt, so a missing ACAO is not fatal here;
// it is recorded because it means the endpoint was never intended for browser use and may
// change without notice.
//
// SSRN is the one that decided the whole architecture. src/bridge/ssrn_api.py runs a Python
// subprocess purely to impersonate Chrome's TLS fingerprint, because Node's undici is 403'd
// by api.ssrn.com. It also forges origin/referer/sec-fetch-*, which are forbidden headers
// no browser lets script set. Both turned out to be unnecessary from here: real Chrome
// brings the real fingerprint, and the forged headers were never load-bearing against this
// host. Probed from the service worker with api.ssrn.com in host_permissions:
//
//   WORKER status=200 count=50 head={"total":10000,"papers":[{"id":2440866,...
//
// That measurement is what removes the Python dependency from the shipped product.
//
// Google Scholar is deliberately ABSENT. It has no API, blocks datacenter traffic, and
// serves consent and captcha interstitials, so it needs a real tab plus chrome.scripting
// rather than a fetch. It belongs with the retrieval paths that already drive a tab, not
// here among the plain-fetch sources.

import { credentialsFor } from './allowlist.js';

// Every source returns this shape, so a caller never branches on which database answered.
// Fields a given source cannot supply are null rather than absent, so consumers can read
// them without guarding.
/**
 * @typedef {object} SearchResult
 * @property {string} title
 * @property {string|null} doi
 * @property {string|null} url          landing page
 * @property {string|null} pdfUrl       direct PDF when the source names one
 * @property {string[]} authors
 * @property {string|null} year
 * @property {string|null} abstract
 * @property {string|null} type         what KIND of document, when the index states one
 * @property {string} source            which database answered
 */

const SSRN_PAGE_SIZE = 50;

/**
 * Reduce PubMed's `pubtype` array to the ONE qualifier worth reporting.
 *
 * esummary sends e.g. ["Journal Article", "Review"] or ["Randomized Controlled Trial",
 * "Journal Article"]. Nearly everything PubMed indexes is also a "Journal Article", so that
 * entry carries no information; the first entry that is NOT it is the answer, and a record
 * that is only a journal article answers 'journal-article'.
 *
 * Nothing is guessed. A record with no `pubtype` yields null and the consumer says nothing
 * about it -- a type inferred from a title or a journal name would be a claim the index
 * never made.
 */
function pubmedType(pubtype) {
  if (!Array.isArray(pubtype)) return null;
  const kinds = pubtype.filter((t) => typeof t === 'string' && t.trim());
  if (kinds.length === 0) return null;
  const qualifier = kinds.find((t) => t.trim().toLowerCase() !== 'journal article');
  return (qualifier || kinds[0]).trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * A search's filters. Every field is optional; an absent one is not sent upstream.
 *
 * `unsupported` on a result group is what makes these honest: an index that cannot express
 * a filter says so, and the caller applies it locally rather than believing the upstream
 * already did. Filtering after the fact discards most of a page, so the difference matters.
 *
 * @typedef {object} SearchFilters
 * @property {string} [author]      one name; SSRN cannot express this (400)
 * @property {number} [yearFrom]
 * @property {number} [yearTo]
 * @property {boolean} [titleOnly]  restrict matching to the title
 * @property {string} [doi]         exact identifier lookup, bypassing text search
 */

/** ISO date for a year bound, or null. Crossref wants full dates, not bare years. */
function isoFrom(year) {
  return Number.isFinite(year) ? `${String(year).padStart(4, '0')}-01-01` : null;
}
function isoTo(year) {
  return Number.isFinite(year) ? `${String(year).padStart(4, '0')}-12-31` : null;
}

/**
 * Fetch JSON through the tier resolver.
 *
 * Never throws: a search source that is down must cost its own result set and nothing
 * else, because sources are queried together and one 503 should not empty the page.
 */
async function getJson(url) {
  const credentials = credentialsFor(url);
  if (credentials === null) return { ok: false, error: 'host not allowlisted' };
  try {
    const res = await fetch(url, { credentials, headers: { accept: 'application/json' } });
    if (!res.ok) return { ok: false, error: `http ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: `${err.name}: ${err.message}` };
  }
}

/** Fetch text through the tier resolver. Same never-throw contract as getJson. */
async function getText(url) {
  const credentials = credentialsFor(url);
  if (credentials === null) return { ok: false, error: 'host not allowlisted' };
  try {
    const res = await fetch(url, { credentials });
    if (!res.ok) return { ok: false, error: `http ${res.status}` };
    return { ok: true, data: await res.text() };
  } catch (err) {
    return { ok: false, error: `${err.name}: ${err.message}` };
  }
}

/**
 * The earliest four-digit year among several date strings, as a string.
 *
 * Exists because PubMed's dates disagree with each other; see the call site.
 */
function earliestYear(...dates) {
  const years = dates
    .map((d) => ((typeof d === 'string' ? d : '').match(/\d{4}/) || [])[0])
    .filter(Boolean)
    .map(Number)
    .filter((y) => y >= 1500 && y <= 2200);
  return years.length ? String(Math.min(...years)) : null;
}

/** Strip the <em> tags SSRN wraps around query matches, and any other markup. */
function stripTags(s) {
  return typeof s === 'string' ? s.replace(/<[^>]*>/g, '').trim() : '';
}

/**
 * Pull one XML element's text content, without a DOM.
 *
 * Deliberately small and deliberately not a parser. arXiv's Atom is machine-generated and
 * regular, and the fields wanted here are flat -- writing or bundling an XML parser to read
 * five fields would be more code and more risk than this. If arXiv ever nests these, this
 * returns null rather than wrong data, because the pattern simply stops matching.
 */
function xmlText(xml, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (!m) return null;
  const text = m[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

// --- SSRN ----------------------------------------------------------------------------

/**
 * SSRN via its own JSON API.
 *
 * `accept: application/json` is REQUIRED and is the one header that genuinely matters --
 * without it the API answers XML. That was true for the Python client and is still true
 * here, so it is set explicitly rather than left to the default.
 */
async function searchSsrn(query, maxResults, page, filters = {}) {
  const wanted = Math.min(maxResults, SSRN_PAGE_SIZE);
  const u = new URL('https://api.ssrn.com/papers/v1/papers/search/advanced');
  // SSRN answers 500 for a long `text`: measured 240 chars fine, 300 a server error. A
  // truncated query returns something useful; an untruncated one returns nothing at all.
  u.searchParams.set('text', query.length > 240 ? query.slice(0, 240) : query);
  // Measured 2026-07-28: text_fields=title narrows the same query from 10,000 to 3,835,
  // so the title restriction is real rather than cosmetic.
  u.searchParams.set('text_fields', filters.titleOnly ? 'title' : 'title-abstract-keywords');
  u.searchParams.set('search_mode', 'fuzzy');
  u.searchParams.set('page', String(page));
  // SSRN expresses recency as named windows, not as a range, so an explicit yearFrom can
  // only be approximated. Anything narrower is left to the caller's local filter.
  const yearsBack = Number.isFinite(filters.yearFrom)
    ? new Date().getFullYear() - filters.yearFrom
    : null;
  u.searchParams.set(
    'date',
    yearsBack !== null && yearsBack <= 1 ? 'last_year'
      : yearsBack !== null && yearsBack <= 3 ? 'last_3_years'
        : 'all_time',
  );

  const res = await getJson(u.toString());
  if (!res.ok) return { source: 'ssrn', error: res.error, results: [], unsupported: ['author'] };

  const rows = res.data?.papers || res.data?.data || [];
  const results = rows.slice(0, wanted).map((p) => ({
    // The API marks query matches with <em>; a title carrying markup would be stored and
    // displayed verbatim, so it is stripped at the boundary rather than at every consumer.
    title: stripTags(p.title),
    doi: p.doi || (p.id ? `10.2139/ssrn.${p.id}` : null),
    url: p.id ? `https://papers.ssrn.com/sol3/papers.cfm?abstract_id=${p.id}` : null,
    pdfUrl: null,
    authors: Array.isArray(p.authors)
      // full_name is the field SSRN actually sends; `name`/`first_name` were a guess and
      // produced an EMPTY author list on every row, which also made the local author filter
      // reject everything. Measured: [{"id":502167,"full_name":"Lei Gao"}, ...].
      ? p.authors
        .map((a) => stripTags(a.full_name || a.name || `${a.first_name || ''} ${a.last_name || ''}`))
        .filter(Boolean)
      : [],
    year: p.approved_date ? String(p.approved_date).slice(0, 4) : null,
    // SSRN hosts working papers, so there is no journal to report. `downloads` is the only
    // popularity signal it sends and is NOT a citation count, so it is deliberately not
    // mapped to one -- a download total shown as citations would misrepresent the paper.
    venue: null,
    // Everything on SSRN is a working paper -- that is what the repository IS, not a guess
    // about any individual row -- and that is exactly the fact a reader wants, because it
    // says the paper has not been through peer review.
    type: 'working-paper',
    citationCount: null,
    // SSRN sends NO `abstract` field -- measured, 0 of 50 rows have the key while 50 of 50
    // have `snippets`, an array of <em>-marked excerpts matching the query. Reading
    // p.abstract left every SSRN record blank, the same bug class as reading `name`
    // instead of `full_name` for authors.
    abstract: Array.isArray(p.snippets) && p.snippets.length
      ? stripTags(p.snippets.join(' ')) || null
      : null,
    source: 'ssrn',
  }));
  // author stays unsupported, and folding the name into `text` was tried and rejected.
  // Measured: text_fields=author/authors/all are all 400, and putting a surname in the text
  // query matches TITLES rather than author lists -- "Damodaran" returns papers about his
  // method, including "The Impact of the Damodar Valley Project", while adding "Han" to a
  // topic query narrowed 10,000 hits to 1,060 without changing how many of the top rows
  // actually carry that author. Pushing it up would look like it worked and quietly return
  // papers ABOUT someone instead of BY them, which is worse than filtering locally.
  const unsupported = ['author'];
  if (Number.isFinite(filters.yearTo) || (yearsBack !== null && yearsBack > 3)) {
    unsupported.push('year');
  }
  return { source: 'ssrn', results, unsupported };
}

// --- arXiv ---------------------------------------------------------------------------

/**
 * arXiv via its Atom API.
 *
 * https works even though the documentation advertises http (verified 2026-07-28, identical
 * response). That matters: the allowlist refuses non-https, so the documented URL would
 * have been unusable from here.
 */
async function searchArxiv(query, maxResults, page, filters = {}) {
  const u = new URL('https://export.arxiv.org/api/query');
  // Field prefixes and a submittedDate range, both confirmed live against the API.
  // Quotes are STRIPPED, not escaped. JSON.stringify turns `say "hi"` into
  // `"say \"hi\""` and arXiv answers 400 -- so a quoted phrase, the most natural academic
  // query, silently removed arXiv from every search. Measured: escaped inner quotes 400,
  // a plain quoted phrase 200.
  const quote = (v) => `"${String(v).replace(/["\\]/g, ' ').trim()}"`;
  const terms = [`${filters.titleOnly ? 'ti' : 'all'}:${quote(query)}`];
  if (filters.author) terms.push(`au:${quote(filters.author)}`);
  const from = Number.isFinite(filters.yearFrom) ? `${filters.yearFrom}0101` : null;
  const to = Number.isFinite(filters.yearTo) ? `${filters.yearTo}1231` : null;
  if (from || to) {
    terms.push(`submittedDate:[${from || '19910101'} TO ${to || '20991231'}]`);
  }
  u.searchParams.set('search_query', terms.join(' AND '));
  u.searchParams.set('start', String((page - 1) * maxResults));
  u.searchParams.set('max_results', String(maxResults));

  const res = await getText(u.toString());
  if (!res.ok) return { source: 'arxiv', error: res.error, results: [] };

  const entries = res.data.split('<entry>').slice(1);
  const results = entries.map((e) => {
    const id = xmlText(e, 'id');
    const absId = id ? id.replace(/^https?:\/\/arxiv\.org\/abs\//, '') : null;
    const doiTag = xmlText(e, 'arxiv:doi');
    return {
      title: xmlText(e, 'title') || '',
      // arXiv preprints usually have no journal DOI, so fall back to arXiv's own DOI
      // namespace, which resolves and gives every result a stable identifier.
      doi: doiTag || (absId ? `10.48550/arXiv.${absId.replace(/v\d+$/, '')}` : null),
      url: id,
      pdfUrl: absId ? `https://arxiv.org/pdf/${absId}` : null,
      // Present once a preprint has appeared somewhere; absent while it is only on arXiv.
      venue: xmlText(e, 'arxiv:journal_ref'),
      // arXiv is a preprint server, so every row it returns is a preprint. Where
      // `journal_ref` is present the paper has ALSO appeared in a venue, but the copy this
      // hit points at is still the preprint, which is what the reader is being offered.
      type: 'preprint',
      citationCount: null,
      authors: (e.match(/<name>([^<]*)<\/name>/g) || [])
        .map((n) => n.replace(/<\/?name>/g, '').trim())
        .filter(Boolean),
      year: (xmlText(e, 'published') || '').slice(0, 4) || null,
      abstract: xmlText(e, 'summary'),
      source: 'arxiv',
    };
  }).filter((r) => r.title);
  return { source: 'arxiv', results };
}

// --- PubMed --------------------------------------------------------------------------

/**
 * PubMed via NCBI eutils: esearch for ids, then esummary for the records.
 *
 * Two round trips is how the API works -- esearch returns only PMIDs. They are sequential
 * by necessity, so a failure in the first short-circuits rather than issuing a second
 * request with nothing to ask for.
 */
async function searchPubmed(query, maxResults, page, filters = {}) {
  const s = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi');
  s.searchParams.set('db', 'pubmed');
  // eutils field tags, confirmed live: [au] for author, [dp] for a date range, [ti] to
  // restrict to the title.
  const parts = [filters.titleOnly ? `${query}[ti]` : query];
  if (filters.author) parts.push(`${filters.author}[au]`);
  if (Number.isFinite(filters.yearFrom) || Number.isFinite(filters.yearTo)) {
    parts.push(`${filters.yearFrom || 1800}:${filters.yearTo || 3000}[dp]`);
  }
  s.searchParams.set('term', parts.join(' AND '));
  s.searchParams.set('retmax', String(maxResults));
  s.searchParams.set('retstart', String((page - 1) * maxResults));
  s.searchParams.set('retmode', 'json');

  const ids = await getJson(s.toString());
  if (!ids.ok) return { source: 'pubmed', error: ids.error, results: [] };
  const idList = ids.data?.esearchresult?.idlist || [];
  if (idList.length === 0) return { source: 'pubmed', results: [] };

  const sum = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi');
  sum.searchParams.set('db', 'pubmed');
  sum.searchParams.set('id', idList.join(','));
  sum.searchParams.set('retmode', 'json');

  const recs = await getJson(sum.toString());
  if (!recs.ok) return { source: 'pubmed', error: recs.error, results: [] };

  const uids = recs.data?.result?.uids || [];
  const results = uids.map((uid) => {
    const r = recs.data.result[uid] || {};
    const doi = (r.articleids || []).find((a) => a.idtype === 'doi')?.value || null;
    return {
      title: stripTags(r.title),
      doi,
      url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
      pdfUrl: null,
      // Both were being dropped though esummary sends them, and Corpus Studio's record has
      // fields for both: fulljournalname e.g. "Frontiers in plant science", pmcrefcount the
      // PMC citation count.
      venue: r.fulljournalname || r.source || null,
      // esummary states the publication type in `pubtype`; pubmedType picks the qualifier.
      type: pubmedType(r.pubtype),
      citationCount: Number.isFinite(r.pmcrefcount) ? r.pmcrefcount : null,
      authors: (r.authors || []).map((a) => a.name).filter(Boolean),
      // PubMed carries THREE dates -- pubdate (print), epubdate (electronic) and
      // sortpubdate -- and [dp] matches ANY of them. Measured: a row answering 2021:2023
      // can print in 2025 with epubdate 2023, and another prints 2023 with epubdate 2026.
      // So neither field alone is "the" year, and picking one made in-range papers look
      // out of range either way. The EARLIEST is reported, because that is when the work
      // first appeared and it is the bound a reader means by "published before".
      year: earliestYear(r.epubdate, r.pubdate, r.sortpubdate),
      // esummary carries no abstract; efetch would, at another round trip per search.
      // Left null rather than paid for, since consumers treat it as optional.
      abstract: null,
      source: 'pubmed',
    };
  }).filter((r) => r.title);
  return { source: 'pubmed', results };
}

// --- bioRxiv -------------------------------------------------------------------------

/**
 * bioRxiv, searched through Crossref.
 *
 * bioRxiv's own API cannot do this. It addresses papers by DOI or by date interval and has
 * no text search at all, and the interval endpoint pages 30 rows at a time over 376,724
 * records (measured 2026-07-28) -- so "fetch recent postings and filter locally" finds
 * nothing for almost any query. That was the first implementation and it returned zero
 * results against the live API, which is precisely the silent failure the live check exists
 * to catch: no error, just an empty page.
 *
 * Crossref indexes bioRxiv and does have real query support. Preprints are typed
 * `posted-content`, which is what separates them from the Cold Spring Harbor JOURNALS that
 * share the 10.1101 prefix (verified: those journal hits are absent from bioRxiv's own API,
 * and a posted-content hit is present in it).
 *
 * The two filters must be split, which is not obvious and was found by measurement.
 * Combining them (`prefix:10.1101,type:posted-content`) collapses a query from 43,230 hits
 * to 1 -- a Crossref quirk, not a real narrowing. Filtering by PREFIX server-side and type
 * client-side fails differently and worse: relevance ranking fills the whole first page
 * with CSH journal articles, so the client-side pass sees zero preprints and the source
 * silently returns nothing. So: type server-side, prefix client-side.
 */
async function searchBiorxiv(query, maxResults, filters = {}) {
  const u = new URL('https://api.crossref.org/works');
  // Crossref splits the query by field and the date bounds into `filter`, both measured.
  if (filters.titleOnly) u.searchParams.set('query.bibliographic', query);
  else u.searchParams.set('query', query);
  if (filters.author) u.searchParams.set('query.author', filters.author);
  const filterParts = ['type:posted-content'];
  const from = isoFrom(filters.yearFrom);
  const to = isoTo(filters.yearTo);
  if (from) filterParts.push(`from-pub-date:${from}`);
  if (to) filterParts.push(`until-pub-date:${to}`);
  u.searchParams.set('filter', filterParts.join(','));
  // Over-fetch: posted-content spans every preprint server, and only the 10.1101 ones are
  // bioRxiv/medRxiv.
  // Over-fetch hard. Of 100 posted-content rows only 44/64/14/0 were 10.1101 across four
  // measured queries, so a 100 ceiling routinely returned far fewer than asked with no
  // signal. Crossref allows rows=1000.
  u.searchParams.set('rows', String(Math.min(Math.max(maxResults * 12, 100), 400)));

  const res = await getJson(u.toString());
  if (!res.ok) return { source: 'biorxiv', error: res.error, results: [] };

  const rows = (res.data?.message?.items || [])
    .filter((it) => typeof it.DOI === 'string' && it.DOI.startsWith('10.1101/'));
  const results = rows.slice(0, maxResults).map((it) => {
    const doi = it.DOI || null;
    // The 10.1101 prefix covers bioRxiv AND medRxiv, and the two do not serve each other's
    // papers: measured, a medRxiv DOI on biorxiv.org/...full.pdf is 403 while medrxiv.org
    // returns the file. Crossref names the server in institution[0].name, so use it rather
    // than assuming. A query for "covid vaccine effectiveness" was 21/21 medRxiv.
    const server = ((it.institution || [])[0]?.name || '').toLowerCase().includes('medrxiv')
      ? 'medrxiv'
      : 'biorxiv';
    return {
      title: stripTags(Array.isArray(it.title) ? it.title[0] : it.title),
      doi,
      url: doi ? `https://www.${server}.org/content/${doi}v1` : (it.URL || null),
      pdfUrl: doi ? `https://www.${server}.org/content/${doi}v1.full.pdf` : null,
      authors: (it.author || [])
        .map((a) => [a.given, a.family].filter(Boolean).join(' ').trim())
        .filter(Boolean),
      year: it.issued?.['date-parts']?.[0]?.[0]
        ? String(it.issued['date-parts'][0][0])
        : null,
      venue: it['group-title'] || (it.institution || [])[0]?.name || null,
      // This query asks Crossref for type=posted-content and keeps only 10.1101, so every
      // row IS a preprint. Crossref's own `type` is reported when it says something more
      // specific than that, and never invented when it does not.
      type: typeof it.type === 'string' && it.type !== 'posted-content' ? it.type : 'preprint',
      citationCount: Number.isFinite(it['is-referenced-by-count'])
        ? it['is-referenced-by-count']
        : null,
      // Crossref abstracts arrive as JATS XML when present at all.
      abstract: it.abstract ? stripTags(it.abstract) : null,
      source: 'biorxiv',
    };
  }).filter((r) => r.title);
  return { source: 'biorxiv', results };
}

// --- entry point ---------------------------------------------------------------------

export const SEARCH_SOURCES = ['ssrn', 'arxiv', 'pubmed', 'biorxiv'];

/**
 * Query one source. Never throws; a failed source reports `error` and an empty list.
 */
export async function searchOne(source, { query, maxResults = 10, page = 1, filters = {} }) {
  // A DOI is an EXACT identifier, so text-searching it is both slower and worse: Crossref
  // answers /works/<doi> directly and definitively, while a text query for the same string
  // returns whatever happens to mention it. This is checked first so every source collapses
  // to the one authoritative answer.
  const doi = filters.doi || extractDoi(query);
  if (doi) return lookupByDoi(doi, source);

  if (typeof query !== 'string' || !query.trim()) {
    return { source, error: 'empty query', results: [] };
  }
  // Per-source ceilings, measured rather than shared. SSRN_PAGE_SIZE is SSRN's own page
  // size and applying it everywhere throttled the others for no reason: arXiv served 200 in
  // one call and PubMed 500 when asked.
  const CAPS = { ssrn: SSRN_PAGE_SIZE, arxiv: 200, pubmed: 500, biorxiv: 200 };
  const n = Math.min(Math.max(1, maxResults), CAPS[source] || SSRN_PAGE_SIZE);
  switch (source) {
    case 'ssrn': return searchSsrn(query, n, page, filters);
    case 'arxiv': return searchArxiv(query, n, page, filters);
    case 'pubmed': return searchPubmed(query, n, page, filters);
    case 'biorxiv': return searchBiorxiv(query, n, filters);
    default: return { source, error: `unknown source: ${source}`, results: [] };
  }
}

/** A DOI anywhere in a string, normalised. Accepts a bare DOI, a doi.org url, or "doi:". */
export function extractDoi(text) {
  if (typeof text !== 'string') return null;
  const m = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i.exec(text.trim());
  return m ? m[1].replace(/[.,;)\]]+$/, '') : null;
}

/**
 * Resolve one identifier through Crossref, which indexes every registered DOI regardless of
 * publisher. Only ONE source answers so the same paper is not returned four times.
 */
async function lookupByDoi(doi, source) {
  if (source !== 'biorxiv') return { source, results: [] };
  const res = await getJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  const it = res.ok ? res.data?.message : null;
  if (!it) return { source, error: res.ok ? 'no such DOI' : res.error, results: [] };
  return {
    source,
    results: [{
      title: stripTags(Array.isArray(it.title) ? it.title[0] : it.title),
      doi: it.DOI || doi,
      url: it.URL || `https://doi.org/${doi}`,
      pdfUrl: null,
      authors: (it.author || [])
        .map((a) => [a.given, a.family].filter(Boolean).join(' ').trim())
        .filter(Boolean),
      year: it.issued?.['date-parts']?.[0]?.[0] ? String(it.issued['date-parts'][0][0]) : null,
      abstract: it.abstract ? stripTags(it.abstract) : null,
      source: 'crossref',
    }],
  };
}

/**
 * Query several sources at once.
 *
 * Promise.all is safe here precisely because searchOne never rejects -- one database being
 * down costs its own results and nothing else.
 */
export async function searchAll(sources, opts) {
  // An EMPTY array means "none of these", not "all of them". Scholar is dispatched
  // separately (it needs a tab), so asking for sources:['scholar'] leaves this an empty
  // list -- and treating that as the default set ran every fetch source anyway.
  const list = (Array.isArray(sources) ? sources : SEARCH_SOURCES)
    .filter((s) => SEARCH_SOURCES.includes(s));
  return Promise.all(list.map((s) => searchOne(s, opts)));
}
