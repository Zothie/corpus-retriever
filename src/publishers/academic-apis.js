import axios from 'axios';
import { parseString } from 'xml2js';
import { promisify } from 'util';
import { batchValidateDownloads } from './download-validator.js';
import { paperRateLimiter } from '../utils/rate-limiter.js';

const parseXML = promisify(parseString);

/**
 * GET that respects a host's throttling instead of surfacing it as a failure.
 *
 * The rate limiter paces our OWN requests, but it cannot know about load the
 * host is under from everyone else, so a 429/503 still happens occasionally.
 * Without this, one such response failed the whole source and the caller saw an
 * empty result set — indistinguishable from "no papers matched".
 *
 * `Retry-After` is honoured when the host sends it (it is telling us exactly how
 * long to wait); otherwise the delay backs off exponentially. An aborted signal
 * cuts the wait short so a superseded search stops immediately.
 */
async function getWithRetry(url, { signal, attempts = 3, baseDelayMs = 3000, ...axiosOpts } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await axios.get(url, { signal, ...axiosOpts });
    } catch (error) {
      // A caller-cancelled request is not a transient failure — do not retry it.
      if (signal?.aborted || axios.isCancel?.(error)) throw error;
      lastError = error;

      const status = error.response?.status;
      const retryable = status === 429 || status === 503 || status === undefined;
      if (!retryable || attempt === attempts - 1) throw error;

      const retryAfter = Number(error.response?.headers?.['retry-after']);
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : baseDelayMs * Math.pow(2, attempt);

      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        }, { once: true });
      });
    }
  }
  throw lastError;
}

/**
 * Fill in abstracts for DOIs whose own index did not supply one.
 *
 * Why this is needed: an abstract is not missing because of a parsing bug, it is
 * missing because major publishers (Elsevier, ACS, Springer) deposit metadata
 * with CrossRef but withhold the abstract. Measured on a real query, 33 of 40
 * CrossRef hits had none. Aggregators that redistribute abstracts DO have many
 * of them: Europe PMC covered 10 of those 33 and OpenAlex 4, overlapping only
 * partly — hence both, in that order.
 *
 * Returns a { doi: abstract } map covering whatever could be found. Failure of
 * either aggregator is not fatal: an enrichment pass must never cost the caller
 * the results it already has.
 */
export async function fetchAbstractsByDoi({ dois, signal }) {
  const wanted = [...new Set((dois || []).filter(Boolean).map(d => d.toLowerCase()))];
  const out = {};
  if (wanted.length === 0) return out;

  // ---- Europe PMC: highest yield, batched ----
  //
  // One request per DOI cost 28 SECONDS on a 233-row search (each acquiring its
  // own rate-limiter slot) to gain two abstracts, which blew the caller's
  // deadline and emptied the whole search. Europe PMC accepts an OR-ed DOI
  // query, so a page of DOIs resolves in a single ~400ms request.
  const EPMC_BATCH = 25;
  for (let i = 0; i < wanted.length; i += EPMC_BATCH) {
    const batch = wanted.slice(i, i + EPMC_BATCH);
    try {
      await paperRateLimiter.acquire('europepmc', { signal });
      const query = batch.map(d => `DOI:"${d}"`).join(' OR ');
      const url =
        'https://www.ebi.ac.uk/europepmc/webservices/rest/search' +
        `?query=${encodeURIComponent(query)}&format=json&resultType=core&pageSize=${EPMC_BATCH}`;
      const { data } = await getWithRetry(url, { signal });
      for (const hit of data?.resultList?.result || []) {
        const doi = (hit.doi || '').toLowerCase();
        if (doi && hit.abstractText) out[doi] = stripTags(hit.abstractText);
      }
    } catch {
      /* this batch simply stays without abstracts */
    }
  }

  // ---- OpenAlex: only for what is still missing, batched 25 per request ----
  const stillMissing = wanted.filter(d => !out[d]);
  for (let i = 0; i < stillMissing.length; i += 25) {
    const batch = stillMissing.slice(i, i + 25);
    try {
      await paperRateLimiter.acquire('openalex', { signal });
      const filter = encodeURIComponent(batch.join('|'));
      const mail = process.env.UNPAYWALL_EMAIL || 'openalex@example.org';
      const url = `https://api.openalex.org/works?filter=doi:${filter}&per-page=25&mailto=${encodeURIComponent(mail)}`;
      const { data } = await getWithRetry(url, { signal });
      for (const work of data?.results || []) {
        const doi = (work.doi || '').replace(/^https?:\/\/doi\.org\//i, '').toLowerCase();
        const text = invertedIndexToText(work.abstract_inverted_index);
        if (doi && text) out[doi] = text;
      }
    } catch {
      /* leave this batch without abstracts */
    }
  }

  return out;
}

/**
 * Rebuild plain text from OpenAlex's inverted index.
 *
 * OpenAlex does not store the abstract as a string — it stores
 * { token: [positions] }, so the text has to be reassembled by position. It is
 * stored this way for licensing reasons, and skipping the reconstruction would
 * mean discarding an abstract that is actually present.
 */
function invertedIndexToText(index) {
  if (!index || typeof index !== 'object') return '';
  const byPosition = [];
  for (const [token, positions] of Object.entries(index)) {
    for (const p of positions) byPosition[p] = token;
  }
  const text = byPosition.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return text;
}

function stripTags(s) {
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Unpaywall API - Find free PDFs by DOI
export async function unpaywallSearch({ doi, email }) {
  try {
    // Unpaywall 422-rejects placeholder emails like user@example.com, which silently killed
    // this source for ALL DOIs. Read the real contact email from UNPAYWALL_EMAIL (set in the
    // server's .env), falling back to a real address rather than the rejected placeholder so
    // Unpaywall works even if .env was not loaded.
    const emailToUse = email || process.env.UNPAYWALL_EMAIL || 'varingaitishe@gmail.com';
    // Strip version suffix from DOI (e.g., 10.1101/190215v4 -> 10.1101/190215)
    const cleanDoi = doi.replace(/v\d+$/, '');
    const url = `https://api.unpaywall.org/v2/${cleanDoi}?email=${emailToUse}`;
    const { data } = await axios.get(url);
    const result = data;

    const resultData = {
      doi,
      is_oa: result.is_oa,
      oa_status: result.oa_status,
      title: result.title,
      year: result.year,
      journal: result.journal_name,
      pdf_url: result.best_oa_location?.url_for_pdf || result.best_oa_location?.url,
      best_oa_location: result.best_oa_location ? {
        url: result.best_oa_location.url,
        pdf_url: result.best_oa_location.url_for_pdf,
        version: result.best_oa_location.version,
        license: result.best_oa_location.license
      } : null
    };

    return {
      content: [{ type: 'text', text: JSON.stringify({ results: [resultData] }) }],
    };
  } catch (error) {
    if (error.response?.status === 422) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          error: 'Unpaywall API requires a valid email address. Set UNPAYWALL_EMAIL in .env or provide email parameter.',
          results: []
        }) }],
      };
    }
    throw new Error(`Unpaywall search failed: ${error.message}`);
  }
}

// OpenAlex - resolve a DOI to its best open-access PDF url. No API key required.
// OpenAlex aggregates OA locations (repositories, publisher OA, PMC) and exposes a
// `best_oa_location` with a direct `pdf_url`; this frequently yields a free PDF that
// unpaywall alone misses. Returns { pdfUrl, landingUrl } (either may be null). Never throws.
export async function openAlexPdfUrl({ doi }) {
  if (!doi) return { pdfUrl: null, landingUrl: null };
  try {
    const cleanDoi = doi.replace(/v\d+$/, '').trim();
    // The polite pool wants a mailto; reuse the unpaywall contact email.
    const email = process.env.UNPAYWALL_EMAIL || 'varingaitishe@gmail.com';
    const url = `https://api.openalex.org/works/doi:${encodeURIComponent(cleanDoi)}?mailto=${encodeURIComponent(email)}`;
    await paperRateLimiter.acquire('openalex').catch(() => {});
    const { data } = await axios.get(url, { timeout: 10000 });
    const best = data?.best_oa_location || null;
    // best_oa_location.pdf_url is a direct PDF; oa_url on the work is a landing/PDF url.
    const pdfUrl = best?.pdf_url || data?.open_access?.oa_url || null;
    const landingUrl = best?.landing_page_url || data?.open_access?.oa_url || null;
    return { pdfUrl: pdfUrl || null, landingUrl: landingUrl || null };
  } catch {
    return { pdfUrl: null, landingUrl: null };
  }
}

// CORE - resolve a DOI to a hosted PDF via the CORE aggregator. Requires CORE_API_KEY
// (env); when unset this returns null cleanly so the source is a silent no-op rather
// than an error. CORE's /v3/search/works endpoint returns downloadUrl fields pointing
// at CORE-hosted PDFs. Returns { pdfUrl } (may be null). Never throws.
export async function corePdfUrl({ doi }) {
  const apiKey = process.env.CORE_API_KEY;
  if (!doi || !apiKey) return { pdfUrl: null };
  try {
    const cleanDoi = doi.replace(/v\d+$/, '').trim();
    const url = `https://api.core.ac.uk/v3/search/works?q=${encodeURIComponent(`doi:"${cleanDoi}"`)}&limit=3`;
    await paperRateLimiter.acquire('core').catch(() => {});
    const { data } = await axios.get(url, {
      timeout: 12000,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const results = Array.isArray(data?.results) ? data.results : [];
    for (const r of results) {
      // Prefer an exact DOI match, then a downloadUrl that looks like a PDF.
      const rDoi = (r.doi || '').toLowerCase();
      if (rDoi && rDoi !== cleanDoi.toLowerCase()) continue;
      const cand = r.downloadUrl || r.fullTextLink || null;
      if (cand) return { pdfUrl: cand };
    }
    // Fall back to the first result's downloadUrl even without a DOI echo.
    const first = results.find((r) => r.downloadUrl);
    return { pdfUrl: first?.downloadUrl || null };
  } catch {
    return { pdfUrl: null };
  }
}

// CrossRef API - Search and metadata
export async function crossrefSearch({ query, rows = 10, offset = 0, validate_downloads = true, only_available = false, signal }) {
  try {
    const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${rows}&offset=${offset}`;
    await paperRateLimiter.acquire('crossref', { signal });
    const { data } = await getWithRetry(url, { signal });
    const result = data;

    if (!result.message || !result.message.items) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ results: [] }) }],
      };
    }

    let results = result.message.items.map(item => {
      const authors = item.author?.slice(0, 3).map(a =>
        `${a.given || ''} ${a.family || ''}`.trim()
      ) || [];

      return {
        title: item.title?.[0] || 'No title',
        doi: item.DOI,
        authors: authors,
        year: item.published?.['date-parts']?.[0]?.[0],
        journal: item['container-title']?.[0],
        type: item.type,
        citations: item['is-referenced-by-count'] || 0,
        // CrossRef DOES return abstracts (as JATS XML) for the publishers that
        // deposit them — roughly a sixth of results. They were simply not being
        // read, so every CrossRef hit looked abstract-less.
        abstract: item.abstract || '',
        url: `https://doi.org/${item.DOI}`
      };
    });

    // Add download validation if requested
    if (validate_downloads) {
      results = await batchValidateDownloads(results);
    }

    // Filter only available papers if requested
    if (only_available) {
      results = results.filter(result => result.download_status?.available === true);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ results }) }],
    };
  } catch (error) {
    throw new Error(`CrossRef search failed: ${error.message}`);
  }
}

/**
 * Abstracts for a batch of PMC ids, keyed by id.
 *
 * esummary — which the search already calls — returns no abstract field at all,
 * so this is a separate efetch. It is batched over the whole page (one extra
 * request per search, not one per paper) and returns whatever it managed to
 * parse: an abstract is a nicety, and failing to get one must never cost the
 * caller its search results.
 */
async function fetchPmcAbstracts(ids, signal) {
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${ids}&retmode=xml`;
  await paperRateLimiter.acquire('pubmed', { signal });
  const { data } = await getWithRetry(url, { signal, responseType: 'text' });
  const xml = typeof data === 'string' ? data : String(data);

  const out = {};
  // Split per article so an abstract is attributed to the right paper; a single
  // global regex over the batch would assign them all to the first id.
  const articles = xml.split(/<article[\s>]/).slice(1);
  for (const article of articles) {
    // PMC tags the bare numeric accession as `pmcaid`; the `pmcid` form carries
    // a "PMC" prefix and `pmcid-ver` a version suffix, neither of which matches
    // the id esearch returned. Accept both, normalising off any prefix.
    const id = (
      article.match(/<article-id[^>]*pub-id-type="pmcaid"[^>]*>(\d+)</)?.[1] ??
      article.match(/<article-id[^>]*pub-id-type="pmcid"[^>]*>PMC(\d+)</)?.[1]
    );
    if (!id) continue;
    const block = article.match(/<abstract[^>]*>([\s\S]*?)<\/abstract>/)?.[1];
    if (!block) continue;
    const text = block
      // Section titles run into the following sentence without a separator.
      .replace(/<\/(?:title|p|sec)>/g, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) out[id] = text;
  }
  return out;
}

// PubMed Central search via E-utilities
export async function pubmedCentralSearch({ query, max_results = 10, retstart = 0, validate_downloads = true, only_available = false, signal }) {
  try {
    // Step 1: Search for article IDs
    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pmc&term=${encodeURIComponent(query)}&retmax=${max_results}&retstart=${retstart}&retmode=json`;
    await paperRateLimiter.acquire('pubmed', { signal });
    const { data: searchData } = await getWithRetry(searchUrl, { signal });
    const searchResult = searchData;

    if (!searchResult.esearchresult || !searchResult.esearchresult.idlist || searchResult.esearchresult.idlist.length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ results: [] }) }],
      };
    }

    const ids = searchResult.esearchresult.idlist.join(',');

    // Step 2: Fetch article summaries (second outbound call => a second pubmed slot)
    const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pmc&id=${ids}&retmode=json`;
    await paperRateLimiter.acquire('pubmed', { signal });
    const { data: summaryData } = await getWithRetry(summaryUrl, { signal });
    const summaryResult = summaryData;

    // Step 3: abstracts. esummary carries no abstract at all, so PMC hits used
    // to arrive with none — the reader could not tell what the paper was about
    // without importing it. efetch returns the full record; one batched call
    // covers the whole page, and a failure here degrades to "no abstract"
    // rather than losing the results.
    const abstracts = await fetchPmcAbstracts(ids, signal).catch(() => ({}));

    let results = searchResult.esearchresult.idlist.map((id) => {
      const article = summaryResult.result[id];
      if (!article) return null;

      const authors = article.authors?.slice(0, 3).map(a => a.name) || [];
      const yearMatch = article.pubdate?.match(/(\d{4})/);

      // esummary does NOT expose a top-level `doi` field — the DOI lives in the
      // `articleids` array alongside the pmid and pmcid. Reading `article.doi`
      // silently yielded undefined for EVERY result, so PubMed hits arrived with
      // no DOI at all and could not be matched against the same paper from
      // another index.
      const idOf = (type) => article.articleids?.find(x => x.idtype === type)?.value || null;

      return {
        title: article.title,
        pmc_id: `PMC${id}`,
        pmid: idOf('pmid'),
        url: `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${id}/`,
        pdf_url: `https://pmc.ncbi.nlm.nih.gov/articles/PMC${id}/pdf/`,
        authors: authors,
        journal: article.fulljournalname,
        year: yearMatch ? parseInt(yearMatch[1]) : null,
        doi: idOf('doi'),
        abstract: abstracts[id] || ''
      };
    }).filter(Boolean);

    // Add download validation if requested
    if (validate_downloads) {
      results = await batchValidateDownloads(results);
    }

    // Filter only available papers if requested
    if (only_available) {
      results = results.filter(result => result.download_status?.available === true);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ results }) }],
    };
  } catch (error) {
    throw new Error(`PubMed Central search failed: ${error.message}`);
  }
}

/**
 * Largest slice arXiv will reliably serve in one request.
 *
 * Their API manual asks callers to "request smaller slices", and it is enforced
 * rather than advisory: asking for 50 or 75 results returned HTTP 503 (and
 * sometimes 429) after ~46 seconds, so arXiv contributed ZERO rows to every
 * large search while also being slow enough to blow the caller's deadline. 25
 * comes back in ~11s and succeeds.
 */
const ARXIV_PAGE = 25;

// arXiv API search
export async function arxivSearch({ query, max_results = 10, start = 0, validate_downloads = true, only_available = false, signal }) {
  try {
    // Fetch in slices arXiv will actually serve, then concatenate. One large
    // request is not equivalent: it fails outright rather than returning fewer.
    const entries = [];
    for (let offset = 0; offset < max_results; offset += ARXIV_PAGE) {
      const want = Math.min(ARXIV_PAGE, max_results - offset);
      const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=${start + offset}&max_results=${want}`;
      await paperRateLimiter.acquire('arxiv', { signal });
      let page;
      try {
        const { data } = await getWithRetry(url, { signal });
        page = await parseXML(data);
      } catch (err) {
        // Keep the slices already in hand: a partial arXiv result is strictly
        // better than discarding it because a later page was throttled.
        if (entries.length > 0) break;
        throw err;
      }
      const got = page?.feed?.entry;
      if (!got) break;
      const list = Array.isArray(got) ? got : [got];
      entries.push(...list);
      // A short page means the result set is exhausted; asking again just
      // spends another 3s slot on an empty answer.
      if (list.length < want) break;
    }

    if (entries.length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ results: [] }) }],
      };
    }

    let results = entries.map(entry => {
      const title = entry.title[0].replace(/\s+/g, ' ').trim();
      const authors = entry.author.slice(0, 3).map(a => a.name[0]);
      const id = entry.id[0];

      // Extract arXiv ID properly (handles both old and new formats)
      // Old: http://arxiv.org/abs/physics/0503114v1 -> physics/0503114v1
      // New: http://arxiv.org/abs/2301.07041v1 -> 2301.07041v1
      const pathParts = id.split('/');
      const arxivId = pathParts.includes('abs')
        ? pathParts.slice(pathParts.indexOf('abs') + 1).join('/')
        : pathParts.pop();

      const published = entry.published[0].substring(0, 10);
      const abstract = entry.summary[0].replace(/\s+/g, ' ').trim();
      const pdfLink = entry.link.find(l => l.$.title === 'pdf');
      const yearMatch = published.match(/^(\d{4})/);

      // Construct PDF URL from arXiv ID if not found in links
      const pdfUrl = pdfLink?.$.href || `https://arxiv.org/pdf/${arxivId}.pdf`;

      return {
        title,
        arxiv_id: arxivId,
        url: id,
        authors: authors,
        year: yearMatch ? parseInt(yearMatch[1]) : null,
        published,
        abstract,
        pdf_url: pdfUrl
      };
    });

    // Add download validation if requested
    if (validate_downloads) {
      results = await batchValidateDownloads(results);
    }

    // Filter only available papers if requested
    if (only_available) {
      results = results.filter(result => result.download_status?.available === true);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ results }) }],
    };
  } catch (error) {
    throw new Error(`arXiv search failed: ${error.message}`);
  }
}

// bioRxiv search (using their API)
export async function biorxivSearch({ query, max_results = 10, offset = 0, validate_downloads = true, only_available = false, signal }) {
  try {
    // Europe PMC, NOT api.biorxiv.org/details.
    //
    // The bioRxiv API has no query parameter at all: /details/biorxiv/<from>/<to>
    // is a DATE-WINDOW LISTING, paginated 30 rows at a time via a cursor. The
    // previous implementation requested a three-year window and filtered the
    // response by substring — but that response is only the first 30 of ~169,000
    // papers, so the search read 0.02% of the corpus and matched a query against
    // whatever happened to be posted on those days. It was simultaneously very
    // slow (a large listing per call) and almost always empty.
    //
    // Europe PMC indexes bioRxiv preprints and exposes a real server-side query
    // with abstracts, DOIs, author lists and citation counts in one request.
    // SRC:PPR restricts to preprints; PUBLISHER:"bioRxiv" keeps this tool's
    // contract (bioRxiv only) rather than silently widening to all preprint
    // servers.
    const europePmcQuery = `(${query}) AND SRC:PPR AND PUBLISHER:"bioRxiv"`;
    const url =
      'https://www.ebi.ac.uk/europepmc/webservices/rest/search' +
      `?query=${encodeURIComponent(europePmcQuery)}` +
      `&format=json&resultType=core&pageSize=${Math.min(max_results + offset, 100)}`;

    await paperRateLimiter.acquire('biorxiv', { signal });
    const { data } = await getWithRetry(url, {
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const collection = data?.resultList?.result;
    if (!Array.isArray(collection) || collection.length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ results: [] }) }],
      };
    }

    const page = collection.slice(offset, offset + max_results);
    if (page.length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ results: [] }) }],
      };
    }

    let results = page.map(paper => {
      // Europe PMC gives authors as structured objects; fall back to the
      // pre-joined string when the structured list is absent.
      const authorList = paper.authorList?.author;
      const authors = Array.isArray(authorList) && authorList.length > 0
        ? authorList.map(a => a.fullName || `${a.firstName || ''} ${a.lastName || ''}`.trim()).filter(Boolean)
        : (paper.authorString || '').split(',').map(a => a.trim()).filter(Boolean);

      const year = paper.pubYear ? parseInt(paper.pubYear, 10) : null;

      return {
        title: paper.title,
        doi: paper.doi || null,
        // Prefer the DOI link: Europe PMC's own preprint URLs are not stable
        // for every record, whereas the DOI always resolves to the preprint.
        url: paper.doi
          ? `https://www.biorxiv.org/content/${paper.doi}`
          : `https://europepmc.org/article/${paper.source}/${paper.id}`,
        authors: authors.slice(0, 3),
        year: Number.isFinite(year) ? year : null,
        published: paper.firstPublicationDate || null,
        abstract: paper.abstractText || '',
        citations: paper.citedByCount || 0
      };
    });

    // Add download validation if requested
    if (validate_downloads) {
      results = await batchValidateDownloads(results);
    }

    // Filter only available papers if requested
    if (only_available) {
      results = results.filter(result => result.download_status?.available === true);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ results }) }],
    };
  } catch (error) {
    throw new Error(`bioRxiv search failed: ${error.message}`);
  }
}
