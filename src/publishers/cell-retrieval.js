// Cell Press (cell.com) article retrieval through the browser bridge.
//
// Why the bridge: all three cell.com PDF URL patterns return 403 to a plain HTTP client
// (measured 2026-07-26 -- showPdf?pii=, /article/<PII>/pdf, /<journal>/pdf/<PII>.pdf).
// The gate is a Cloudflare managed challenge, which only a real browser clears, so the
// fetch happens inside the user's own Chrome. This module just decides ownership and
// builds URLs.
//
// ---------------------------------------------------------------------------
// The hard part: cell.com and ScienceDirect are indistinguishable by DOI prefix
// ---------------------------------------------------------------------------
//
// Both platforms are Elsevier, both mint 10.1016/* DOIs, and both resolve through
// linkinghub.elsevier.com, which routes onward only with JavaScript. A server-side
// redirect chain therefore stops at linkinghub for BOTH, so the final host is simply not
// observable that way (verified across six journals spanning both platforms). The
// authoritative discriminator is the journal, and the journal comes from Crossref.
//
// ---------------------------------------------------------------------------
// Chosen strategy: hybrid -- offline table first, Crossref only for the unknown
// ---------------------------------------------------------------------------
//
// The three options were: (a) a hardcoded journal table, (b) always ask Crossref,
// (c) table first with a Crossref fallback. This implements (c), for two reasons.
//
// 1. The table is right for the overwhelming majority and costs nothing. Cell Press is
//    about 55 journals; their DOI tokens (j.heliyon, j.isci, j.xcrm, j.cub, ...) and their
//    ISSNs were enumerated from Crossref and are embedded below. A known token answers
//    instantly, offline, on the resolve path.
//
// 2. The Crossref fallback is close to free, which is what makes (c) beat (a). The reply
//    carries resource.primary.URL -- the exact linkinghub URL the doi.org redirect would
//    have produced -- so we seed the shared PII cache from it. The cell and ScienceDirect
//    sources both need that PII and would otherwise have paid for a doi.org round trip to
//    get it. The fallback therefore SUBSTITUTES for a network call rather than adding one.
//
// Pure (b) was rejected: it would put a Crossref request in front of every Elsevier DOI
// including the ~55 journals we already know for certain, for no gain. Pure (a) was
// rejected because Cell Press launches journals (Newton and Nexus are recent) and a stale
// table would silently misroute them to ScienceDirect forever, with nothing to notice it.
//
// ACCEPTED FAILURE MODE: when Crossref itself is unreachable, an unknown-token 10.1016 DOI
// is treated as NOT cell.com. A new Cell Press journal is then handed to the ScienceDirect
// source, whose URL pattern does not serve it, and the download fails. This is deliberately
// the cheap direction to be wrong in: every bridge source is headed:false and races in
// parallel, so a misroute costs one race slot, not a user-visible stall. Being wrong the
// other way (claiming ScienceDirect DOIs on a Crossref outage) would have the cell source
// swallow the whole 10.1016 space.
//
// One DOI token is genuinely ambiguous and must never be answered from the table:
// 10.1016/j.ccr.* is Cancer Cell (Cell Press) for older articles AND Coordination Chemistry
// Reviews (ScienceDirect) for current ones. Both were confirmed live. It is listed as
// ambiguous below and always goes to Crossref.

import { paperRateLimiter } from '../utils/rate-limiter.js';
import { createLogger } from '../utils/logger.js';
import {
  elsevierPii,
  normalizePii,
  punctuatePii,
  piiFromUrl,
  seedPii,
} from './elsevier-pii.js';

const logger = createLogger('cell-retrieval');

// Elsevier's registrant prefix. Necessary but nowhere near sufficient: it also covers all
// of ScienceDirect, which is the entire reason this module needs a discriminator.
const ELSEVIER_PREFIX = /^10\.1016\//i;

// Modern Elsevier DOI shape: 10.1016/j.<journal-token>.<rest>
const JOURNAL_TOKEN = /^10\.1016\/j\.([a-z0-9]+)\./i;

// Legacy shape: 10.1016/S<print-ISSN><year><sequence>, e.g. 10.1016/S0960-9822(20)30832-0.
// The ISSN is embedded verbatim, which makes these decidable offline with no table of
// tokens at all -- the ISSN set below is enough.
const LEGACY_ISSN_DOI = /^10\.1016\/S(\d{4})-?([0-9X]{4})[(\d]/i;

// Cell Press journal DOI tokens, enumerated from Crossref (2026-07-26) by querying each
// journal title under prefix:10.1016 and collecting the j.<token> actually minted.
// Deliberately excludes the ambiguous token below.
export const CELL_PRESS_DOI_TOKENS = new Set([
  'ajhg', 'bpj', 'bpr', 'ccell', 'celrep', 'cell', 'cels', 'checat', 'chembiol', 'chom',
  'cmet', 'chempr', 'crmeth', 'crsus', 'cub', 'devcel', 'device', 'heliyon', 'immuni',
  'isci', 'it', 'joule', 'matt', 'medj', 'molcel', 'molmed', 'molp', 'neuron', 'newton',
  'omtm', 'omtn', 'omton', 'oneear', 'patter', 'pt', 'stem', 'stemcr', 'str', 'tcb',
  'tibs', 'tibtech', 'tics', 'tig', 'tim', 'tips', 'tplants', 'trecan', 'trechm', 'tree',
  'tem', 'tins', 'xcrm', 'xcrp', 'xgen', 'xplc', 'xpro', 'ymthe', 'ynexs',
]);

// Tokens shared between a Cell Press journal and a non-Cell-Press Elsevier journal. These
// can only be settled by asking what the specific article's journal is.
//   ccr -> Cancer Cell (to ~2013) and Coordination Chemistry Reviews (both confirmed live)
export const AMBIGUOUS_DOI_TOKENS = new Set(['ccr']);

// ISSNs of the Cell Press journals above. Used for two things: deciding legacy
// S<ISSN>(yy) DOIs offline, and checking Crossref's answer by a stable key rather than by
// a display title (titles carry HTML entities and get renamed; ISSNs do not).
export const CELL_PRESS_ISSNS = new Set([
  '0002-9297', '1537-6605', // The American Journal of Human Genetics
  '0006-3495', '1542-0086', // Biophysical Journal
  '2667-0747', // Biophysical Reports
  '1535-6108', // Cancer Cell
  '0092-8674', // Cell
  '2451-9456', // Cell Chemical Biology
  '2666-979X', // Cell Genomics
  '1931-3128', // Cell Host and Microbe
  '1550-4131', // Cell Metabolism
  '2211-1247', // Cell Reports
  '2666-3791', // Cell Reports Medicine
  '2667-2375', // Cell Reports Methods
  '2666-3864', // Cell Reports Physical Science
  '2949-7906', // Cell Reports Sustainability
  '1934-5909', // Cell Stem Cell
  '2405-4712', // Cell Systems
  '2451-9294', // Chem
  '2667-1093', // Chem Catalysis
  '0960-9822', // Current Biology
  '1534-5807', // Developmental Cell
  '2666-9986', // Device
  '2405-8440', // Heliyon
  '1074-7613', // Immunity
  '2589-0042', // iScience
  '2542-4351', // Joule
  '2590-2385', // Matter
  '2666-6340', // Med
  '1097-2765', // Molecular Cell
  '1674-2052', '1752-9867', // Molecular Plant
  '1525-0016', '1525-0024', // Molecular Therapy
  '2329-0501', // Molecular Therapy - Methods and Clinical Development
  '2162-2531', // Molecular Therapy - Nucleic Acids
  '2950-3299', // Molecular Therapy - Oncology
  '0896-6273', // Neuron
  '2950-6360', // Newton
  '2950-1601', // Nexus
  '2590-3322', // One Earth
  '2666-3899', // Patterns
  '2590-3462', // Plant Communications
  '2666-1667', // STAR Protocols
  '2213-6711', // Stem Cell Reports
  '0969-2126', '1878-4186', // Structure
  '0968-0004', // Trends in Biochemical Sciences
  '0167-7799', // Trends in Biotechnology
  '2405-8033', // Trends in Cancer
  '0962-8924', // Trends in Cell Biology
  '2589-5974', // Trends in Chemistry
  '1364-6613', // Trends in Cognitive Sciences
  '0169-5347', // Trends in Ecology and Evolution
  '1043-2760', // Trends in Endocrinology and Metabolism
  '0168-9525', // Trends in Genetics
  '1471-4906', // Trends in Immunology
  '0966-842X', // Trends in Microbiology
  '1471-4914', // Trends in Molecular Medicine
  '0166-2236', // Trends in Neurosciences
  '1471-4922', // Trends in Parasitology
  '0165-6147', // Trends in Pharmacological Sciences
  '1360-1385', '1878-4372', // Trends in Plant Science
]);

/** Journal titles are only a fallback key; normalise away entities, case and punctuation. */
function normalizeTitle(title) {
  return String(title || '')
    .replace(/&amp;/g, '&')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Checked only when Crossref returns no usable ISSN. Every one of these corresponds to an
// ISSN above; the duplication is the point, so a record missing its ISSN still resolves.
const CELL_PRESS_TITLES = new Set([
  'cell', 'cancer cell', 'cell chemical biology', 'cell genomics', 'cell host and microbe',
  'cell metabolism', 'cell reports', 'cell reports medicine', 'cell reports methods',
  'cell reports physical science', 'cell reports sustainability', 'cell stem cell',
  'cell systems', 'chem', 'chem catalysis', 'current biology', 'developmental cell',
  'device', 'heliyon', 'immunity', 'iscience', 'joule', 'matter', 'med', 'molecular cell',
  'neuron', 'newton', 'nexus', 'one earth', 'patterns', 'star protocols', 'structure',
  'biophysical journal', 'biophysical reports', 'molecular therapy',
  'molecular therapy nucleic acids', 'molecular therapy methods and clinical development',
  'molecular therapy oncology', 'stem cell reports',
  'the american journal of human genetics', 'molecular plant', 'plant communications',
  'trends in biochemical sciences', 'trends in biotechnology', 'trends in cancer',
  'trends in cell biology', 'trends in chemistry', 'trends in cognitive sciences',
  'trends in ecology and evolution', 'trends in endocrinology and metabolism',
  'trends in genetics', 'trends in immunology', 'trends in microbiology',
  'trends in molecular medicine', 'trends in neurosciences', 'trends in parasitology',
  'trends in pharmacological sciences', 'trends in plant science',
]);

/** True for any 10.1016 DOI. The Elsevier space as a whole, cell.com and ScienceDirect both. */
export function isElsevierDoi(doi) {
  return typeof doi === 'string' && ELSEVIER_PREFIX.test(doi.trim());
}

/**
 * Decide from the DOI string alone, with no network access.
 * Returns true (Cell Press), false (Elsevier but not Cell Press), or null ("ask Crossref").
 */
export function classifyCellDoiOffline(doi) {
  if (!isElsevierDoi(doi)) return false;
  const trimmed = doi.trim();

  const legacy = trimmed.match(LEGACY_ISSN_DOI);
  if (legacy) {
    const issn = `${legacy[1]}-${legacy[2]}`.toUpperCase();
    // The ISSN is in the DOI itself, so this is decidable both ways offline.
    return CELL_PRESS_ISSNS.has(issn);
  }

  const token = trimmed.match(JOURNAL_TOKEN)?.[1]?.toLowerCase();
  if (!token) return null;
  if (AMBIGUOUS_DOI_TOKENS.has(token)) return null;
  if (CELL_PRESS_DOI_TOKENS.has(token)) return true;
  // An unrecognised token is NOT a decision: it could be a Cell Press journal launched
  // after this table was built. Defer.
  return null;
}

// doi -> boolean. Crossref answers are memoized; the matcher can be called by several
// racing sources for the same DOI.
const journalCache = new Map();

/** Test seam: forget every memoized Crossref verdict. */
export function clearCellJournalCache() {
  journalCache.clear();
}

/**
 * Default discriminator: ask Crossref which journal an Elsevier DOI belongs to.
 *
 * Also harvests resource.primary.URL into the shared PII cache. That URL is the linkinghub
 * address the doi.org redirect would have returned, so this lookup doubles as the PII
 * resolve both Elsevier sources need -- which is what keeps the fallback cheap.
 */
async function lookupViaCrossref(doi, { signal } = {}) {
  await paperRateLimiter.acquire('crossref', { signal }).catch(() => {});
  const response = await fetch(
    `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
    { signal, headers: { Accept: 'application/json' } },
  );
  // A 404 is a real answer ("Crossref does not know this DOI"), not a transport failure,
  // but it tells us nothing about the journal, so it is still "unknown".
  if (!response.ok) throw new Error(`crossref HTTP ${response.status}`);
  const message = (await response.json())?.message;
  if (!message) throw new Error('crossref returned no message');

  const pii = piiFromUrl(message.resource?.primary?.URL);
  if (pii) seedPii(doi, pii);

  return {
    issns: (message.ISSN || []).map((s) => String(s).toUpperCase()),
    title: message['container-title']?.[0] || null,
  };
}

/** Is this Crossref record one of the Cell Press journals? ISSN first, title as fallback. */
function isCellPressJournal({ issns = [], title = null } = {}) {
  if (issns.some((issn) => CELL_PRESS_ISSNS.has(issn))) return true;
  // Only trust the title when there is no ISSN to judge by. A known ISSN that is absent
  // from our set is a definite "not Cell Press", and a title match must not override it.
  if (issns.length > 0) return false;
  return CELL_PRESS_TITLES.has(normalizeTitle(title));
}

/**
 * Does this DOI belong to a cell.com journal?
 *
 * Offline table first; Crossref only for DOIs the table cannot decide. `lookup` is
 * injectable so tests -- and the publisher registry's mutual-exclusion guard, which calls
 * every matcher over every sample -- stay entirely offline. Never throws: a failed lookup
 * means "not cell.com", per the accepted failure mode in the header.
 */
export async function isCellDoi(doi, { lookup = lookupViaCrossref, signal } = {}) {
  const offline = classifyCellDoiOffline(doi);
  if (offline !== null) return offline;

  const key = doi.trim().toLowerCase();
  if (journalCache.has(key)) return journalCache.get(key);

  const pending = (async () => {
    try {
      return isCellPressJournal(await lookup(doi.trim(), { signal }));
    } catch (err) {
      logger.debug(`journal lookup failed for ${doi}, treating as not cell.com: ${err.message}`);
      return false;
    }
  })();

  journalCache.set(key, pending);
  const claimed = await pending;
  journalCache.set(key, claimed);
  return claimed;
}

/**
 * DOI -> PII, via the shared Elsevier resolver. Memoized there and shared with the
 * ScienceDirect source; returns null rather than throwing when the resolve fails.
 */
export async function cellPii(doi, options = {}) {
  return elsevierPii(doi, options);
}

/**
 * The article landing page. This is the page the bridge tab opens so the Cloudflare
 * challenge clears on the cell.com origin before the PDF is fetched same-origin.
 *
 * /action/showPdf is deliberately NOT used as the landing page even though it is the
 * canonical PDF endpoint: landing on a PDF gives the challenge nothing to render into.
 * The journal-agnostic /article/<PII> route serves the article for every Cell Press title,
 * so we do not have to map a DOI token to a journal slug.
 */
export function cellLandingUrl(pii) {
  const compact = normalizePii(pii);
  if (!compact) return null;
  return `https://www.cell.com/article/${compact}/fulltext`;
}

/**
 * The canonical PDF endpoint. cell.com's own download button points at
 * /action/showPdf?pii=<punctuated PII>, so the punctuated spelling is used here.
 */
export function cellPdfUrl(pii) {
  const punctuated = punctuatePii(pii);
  if (!punctuated) return null;
  return `https://www.cell.com/action/showPdf?pii=${encodeURIComponent(punctuated)}`;
}

/**
 * Secondary PDF route, kept for the bridge to retry with. Some titles serve the PDF from
 * the article path when showPdf does not, and it takes the compact spelling.
 */
export function cellArticlePdfUrl(pii) {
  const compact = normalizePii(pii);
  if (!compact) return null;
  return `https://www.cell.com/article/${compact}/pdf`;
}
