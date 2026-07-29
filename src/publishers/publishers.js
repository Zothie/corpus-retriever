// Declarative registry of publishers served by the browser bridge.
//
// The bridge transport (extension -> native host -> unix socket -> desktop client) is already
// publisher-agnostic: it takes {url, referer} and returns PDF bytes fetched from inside
// the user's real Chrome. What was publisher-specific was the resolver branch in
// save-to-vault.js. This module turns that branch into data: each entry says which
// papers it owns, how to turn a DOI or URL into an identifier, and which URLs the tab
// should open and fetch.
//
// `matches` is ASYNC-CAPABLE on purpose. cell.com and ScienceDirect share the 10.1016
// registrant prefix and both resolve to linkinghub.elsevier.com, which routes onward
// only with JavaScript -- so the final host is not discoverable from a server-side
// redirect chain. The only authoritative discriminator is the journal, which means a
// network lookup (api.crossref.org/works/<doi> -> container-title). Allowing `matches`
// to return a Promise and awaiting it in findPublisher keeps that possible without
// reshaping the registry later. Synchronous matchers (SSRN's is a regexp) still work
// unchanged, since `await` on a boolean is a boolean.
//
// A network-backed matcher MUST stay testable offline: memoize it and take its lookup
// as an injectable dependency, because the registry's mutual-exclusion test calls every
// entry's `matches` for every sample and must not hit the network to do so. That is what
// the third `options` argument is for: findPublisher forwards it verbatim, so a caller
// (or a test) can hand the matcher a fake discriminator. Matchers with no network
// dependency simply ignore it.
//
// Entry shape:
//   name        string   -- source name in the resolver
//   hosts       string[] -- lowercase hosts this publisher fetches from
//   matches     (doi, url, options) => boolean | Promise<boolean>
//   extractId   (doi, url) => string | null  -- synchronous, pure
//   resolveId   (doi, url, options) => Promise<string|null>  -- OPTIONAL, and present only
//                when the identifier cannot always be derived offline. cell.com needs a
//                PII, which is a redirect away, so its extractId answers only from a URL
//                or an already-memoized resolve and resolveId does the round trip.
//                Consumers should prefer resolveId when an entry has one.
//   landingUrl  (id) => string   -- page the tab opens; the challenge clears here
//   pdfUrl      (id) => string | null -- direct PDF url when one is constructible. null
//                means "read the links out of the rendered page instead".
//   preferPdfLink RegExp -- OPTIONAL, and meaningful only when pdfUrl returns null. Picks
//                the full text out of a page that links several PDFs (OUP also links its
//                supplementary material). Absent means "take the first candidate".
//   manualLabel string   -- label for the human-visible fallback link
//   headed      boolean  -- always false: bridge sources race in parallel
//   accessGate  object   -- OPTIONAL. Present only where most content is unreachable and
//                the attempt must therefore be bounded before a tab is opened. Shape:
//                { classify(doi, options) => Promise<verdict>,
//                  shouldSkip(verdict) => boolean,
//                  budgetMs(verdict) => number,
//                  isRefusal(body) => boolean }. A missing accessGate means "attempt,
//                with the caller's normal budget", so no other entry needs one.
//   samples     {doi, url}[] -- non-empty; what the registry tests exercise the entry
//                with. URL-driven publishers (DigitalCommons has no DOI pattern) set
//                doi:null and supply url. An entry whose extractId cannot answer from a
//                DOI alone must include a sample carrying a URL, so the synchronous URL
//                guards still have something to build from. Omitting samples would
//                silently skip the two guard tests, so they are required.

import {
  isSsrnDoi,
  ssrnAbstractId,
  ssrnAbstractUrl,
  ssrnDeliveryUrl,
} from './ssrn-retrieval.js';
import {
  isDigitalCommonsUrl,
  digitalCommonsPdfUrl,
  digitalCommonsLandingUrl,
  digitalCommonsHosts,
} from './digitalcommons-retrieval.js';
import {
  isMendeleyDoi,
  isMendeleyUrl,
  mendeleyDatasetId,
  mendeleyLandingUrl,
} from './mendeley-retrieval.js';
import {
  isCellDoi,
  cellPii,
  cellLandingUrl,
  cellPdfUrl,
} from './cell-retrieval.js';
import {
  isScienceDirectDoi,
  scienceDirectPii,
  scienceDirectLandingUrl,
  scienceDirectPdfUrl,
  classifyScienceDirectAccess,
  shouldSkipBridge,
  bridgeBudgetMs,
  isPaywallHtml,
} from './sciencedirect-retrieval.js';
import {
  isNatureDoi,
  natureArticleId,
  natureLandingUrl,
  naturePdfUrl,
} from './nature-retrieval.js';
import {
  isSpringerDoi,
  springerArticleId,
  springerLandingUrl,
  springerPdfUrl,
} from './springer-retrieval.js';
import {
  isWileyDoi,
  wileyArticleId,
  wileyLandingUrl,
  wileyPdfUrl,
} from './wiley-retrieval.js';
import {
  isAcsDoi,
  acsArticleId,
  acsLandingUrl,
  ACS_PDF_LINK,
} from './acs-retrieval.js';
import {
  isOupDoi,
  oupArticlePath,
  cachedOupPath,
  oupPath,
  oupLandingUrl,
} from './oup-retrieval.js';
import { piiFromUrl, cachedPii } from './elsevier-pii.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('publishers');

export const PUBLISHERS = [
  {
    name: 'ssrn',
    hosts: ['ssrn.com'],
    matches: (doi) => isSsrnDoi(doi),
    extractId: (doi) => ssrnAbstractId(doi),
    landingUrl: (id) => ssrnAbstractUrl(id),
    pdfUrl: (id) => ssrnDeliveryUrl(id),
    manualLabel: 'SSRN abstract page',
    headed: false,
    samples: [{ doi: '10.2139/ssrn.2386457', url: null }],
  },
  {
    // URL-driven, not DOI-driven: bepress repositories have no DOI namespace of their
    // own, so this entry only ever fires on a web_fulltext_* discovery URL whose host is
    // a known instance. `matches` ignores the DOI argument entirely, which is also why it
    // can never collide with a DOI-based publisher.
    name: 'digitalcommons',
    // Every listed instance, sourced from the allowlist. These are third-party university
    // hosts under a path-constrained grant, not suffix-granted publisher domains -- see
    // src/bridge/allowed-hosts.js.
    hosts: digitalCommonsHosts(),
    matches: (doi, url) => isDigitalCommonsUrl(url),
    // The identifier IS the URL. There is no shorter stable id: the /cgi/ form's identity
    // lives in the article= and context= query parameters, so stripping anything loses it.
    extractId: (doi, url) => digitalCommonsPdfUrl(url),
    landingUrl: (id) => digitalCommonsLandingUrl(id),
    pdfUrl: (id) => digitalCommonsPdfUrl(id),
    manualLabel: 'DigitalCommons download page',
    headed: false,
    samples: [
      { doi: null, url: 'https://digitalcommons.unl.edu/cgi/viewcontent.cgi?article=1000&context=libraryscience' },
      { doi: null, url: 'https://digitalcommons.usu.edu/context/etd/article/1000/type/native/viewcontent' },
    ],
  },
  {
    // Mendeley Data datasets. Claimed by DOI (10.17632, Mendeley Data's own registrant
    // prefix, shared with nothing else here) or by dataset URL.
    name: 'mendeley',
    hosts: ['data.mendeley.com'],
    matches: (doi, url) => isMendeleyDoi(doi) || isMendeleyUrl(url),
    extractId: (doi, url) => mendeleyDatasetId(doi, url),
    landingUrl: (id) => mendeleyLandingUrl(id),
    // No constructible PDF url: the file URLs exist only in the hydrated DOM (see the
    // header of mendeley-retrieval.js for the measurement). The resolver opens the
    // landing page with the bridge's fetch_links capability, picks the .pdf href with
    // pickPdfLink, and only then fetches it down the normal fetch_pdf path.
    pdfUrl: () => null,
    manualLabel: 'Mendeley Data dataset page',
    headed: false,
    samples: [
      { doi: '10.17632/hxfhg7ycpr.1', url: null },
      { doi: null, url: 'https://data.mendeley.com/datasets/hxfhg7ycpr/1' },
    ],
  },
  {
    // Cell Press. Shares the 10.1016 registrant prefix with ScienceDirect, so the matcher
    // is the only one here that cannot decide from the identifier's shape alone -- see the
    // header of cell-retrieval.js for the journal-table-plus-Crossref-fallback rationale
    // and the failure mode it accepts. `options` is forwarded straight through so the
    // Crossref discriminator can be faked offline.
    name: 'cell',
    hosts: ['cell.com'],
    matches: (doi, url, options) => isCellDoi(doi, options),
    // Synchronous and pure, so the registry guards can call it: it answers from a URL that
    // already carries the PII, or from a resolve some earlier caller memoized. It returns
    // null for a bare DOI that has not been resolved yet, which is what resolveId is for.
    extractId: (doi, url) => piiFromUrl(url) || cachedPii(doi) || null,
    resolveId: (doi, url, options) => (piiFromUrl(url)
      ? Promise.resolve(piiFromUrl(url))
      : cellPii(doi, options)),
    landingUrl: (id) => cellLandingUrl(id),
    pdfUrl: (id) => cellPdfUrl(id),
    manualLabel: 'Cell Press article page',
    headed: false,
    // Each sample carries the linkinghub URL as well as the DOI because extractId is
    // synchronous and a bare DOI has no PII until something resolves it. Heliyon and
    // iScience are decided by the DOI token table; the Current Biology entry is in the
    // legacy S<ISSN>(yy) DOI form, which is decided from the ISSN embedded in the DOI.
    samples: [
      {
        doi: '10.1016/j.heliyon.2023.e13212',
        url: 'https://linkinghub.elsevier.com/retrieve/pii/S240584402300419X',
      },
      {
        doi: '10.1016/j.isci.2023.106041',
        url: 'https://linkinghub.elsevier.com/retrieve/pii/S2589004223001189',
      },
      {
        doi: '10.1016/S0960-9822(20)30832-0',
        url: 'https://linkinghub.elsevier.com/retrieve/pii/S0960982220308320',
      },
    ],
  },
  {
    // ScienceDirect: the rest of Elsevier. Defined as the exact complement of the cell
    // entry inside the 10.1016 prefix -- see the header of sciencedirect-retrieval.js for
    // why the prefix alone settles "is Elsevier" and why no second Crossref check is worth
    // making. Because both matchers consult the same discriminator, they partition the
    // prefix and the registry's mutual-exclusion guard holds by construction rather than by
    // two journal tables happening to agree.
    //
    // MUST stay after the cell entry is NOT true, and deliberately so: mutual exclusion is
    // structural here, so ordering carries no meaning and cannot be quietly depended on.
    name: 'sciencedirect',
    hosts: ['sciencedirect.com'],
    matches: (doi, url, options) => isScienceDirectDoi(doi, options),
    // Same shape as cell's: synchronous and pure so the registry guards can call it, with
    // resolveId doing the round trip a bare DOI needs.
    extractId: (doi, url) => piiFromUrl(url) || cachedPii(doi) || null,
    resolveId: (doi, url, options) => (piiFromUrl(url)
      ? Promise.resolve(piiFromUrl(url))
      : scienceDirectPii(doi, options)),
    landingUrl: (id) => scienceDirectLandingUrl(id),
    pdfUrl: (id) => scienceDirectPdfUrl(id),
    manualLabel: 'ScienceDirect article page',
    headed: false,
    // OPTIONAL, and only this entry has one. Most of ScienceDirect is paywalled and the
    // user has no institutional access, so the common outcome is a tab that clears the
    // challenge and is handed an HTML paywall page. Since every publisher source races in
    // parallel, that failure must not hold a race slot for the full challenge timeout.
    // accessGate lets Task 6's wiring ask, before opening a tab: skip this paper entirely
    // (a cheaper source already has a free PDF off Elsevier), or attempt it on a reduced
    // budget. See the header of sciencedirect-retrieval.js for why is_oa=false shortens
    // the budget but must never skip the attempt. Consumers must treat a missing
    // accessGate as "attempt, with no special budget".
    accessGate: {
      classify: (doi, options) => classifyScienceDirectAccess(doi, options),
      shouldSkip: (access) => shouldSkipBridge(access),
      budgetMs: (access) => bridgeBudgetMs(access),
      // Consulted only for a body that already failed the %PDF- check, to tell a paywall
      // (stop) from an uncleared challenge (a retry may help).
      isRefusal: (body) => isPaywallHtml(body),
    },
    // Journal of Financial Economics is the modern j.<token> shape, undecidable offline and
    // settled by the discriminator; the second is the legacy S<ISSN>(yy) shape, whose
    // embedded ISSN is decided offline. Both carry a linkinghub URL for the same reason the
    // cell samples do.
    samples: [
      {
        doi: '10.1016/j.jfineco.2019.05.005',
        url: 'https://linkinghub.elsevier.com/retrieve/pii/S0304405X19301199',
      },
      {
        doi: '10.1016/S0304-405X(99)00003-3',
        url: 'https://linkinghub.elsevier.com/retrieve/pii/S0304405X99000033',
      },
    ],
  },
  {
    // Springer Nature, not Elsevier -- the only non-Elsevier publisher here. Included
    // because it hosts its own open-access PDFs behind a JS challenge: in a 7-paper
    // sample of OA Nature-family articles, 6 had no working pdf route outside
    // nature.com, so the existing captcha-free sources reach nothing for them. That is
    // the opposite of ScienceDirect, whose free PDFs always live somewhere else.
    //
    // The 10.1038 prefix belongs to Springer Nature alone, and the article id in the DOI
    // is the path, so both the landing page and the PDF are constructible offline -- no
    // Crossref lookup and no DOM read.
    name: 'nature',
    hosts: ['nature.com'],
    matches: (doi) => isNatureDoi(doi),
    extractId: (doi) => natureArticleId(doi),
    landingUrl: (id) => natureLandingUrl(id),
    pdfUrl: (id) => naturePdfUrl(id),
    manualLabel: 'Nature article page',
    headed: false,
    samples: [
      { doi: '10.1038/s41598-020-69209-2', url: null },
      { doi: '10.1038/nature12373', url: null },
    ],
  },
  {
    // Springer proper (link.springer.com), the 10.1007 prefix -- distinct from the nature
    // entry's 10.1038 even though both are Springer Nature, because they are different
    // platforms with different URL shapes and different walls (F5 here as on nature.com).
    //
    // Low OA rate: 37 of 40 sampled DOIs were closed, so this source usually resolves to a
    // paywall page the %PDF- check rejects. Registered anyway because when a Springer
    // article IS free its publisher PDF is on link.springer.com and nothing else in the
    // pipeline can fetch it. No accessGate: unlike ScienceDirect, a free Springer article
    // has no cheaper route, so there is never a reason to skip the attempt.
    name: 'springer',
    hosts: ['link.springer.com'],
    matches: (doi) => isSpringerDoi(doi),
    extractId: (doi) => springerArticleId(doi),
    landingUrl: (id) => springerLandingUrl(id),
    pdfUrl: (id) => springerPdfUrl(id),
    manualLabel: 'Springer article page',
    headed: false,
    samples: [
      { doi: '10.1007/s11367-021-01974-2', url: null },
      { doi: '10.1007/s10021-019-00449-8', url: null },
    ],
  },
  {
    // Wiley. Cloudflare 403s every plain client, and all ten free PDFs in a 40-DOI sample
    // were on onlinelibrary.wiley.com with no copy anywhere else -- see the header of
    // wiley-retrieval.js, including why the shared 10.1111 prefix is claimed whole.
    name: 'wiley',
    hosts: ['onlinelibrary.wiley.com'],
    matches: (doi) => isWileyDoi(doi),
    extractId: (doi) => wileyArticleId(doi),
    landingUrl: (id) => wileyLandingUrl(id),
    pdfUrl: (id) => wileyPdfUrl(id),
    manualLabel: 'Wiley article page',
    headed: false,
    samples: [
      { doi: '10.1002/advs.202004433', url: null },
      { doi: '10.1111/1740-9713.01393', url: null },
    ],
  },
  {
    // ACS. Cloudflare 403s every plain client, and all ten free PDFs in a 40-DOI sample
    // were on pubs.acs.org -- chemistry is poorly covered by the OA mirrors the other
    // sources use, so the bridge is the only route to a free ACS article.
    //
    // Like OUP (and for the same reason -- both run on Silverchair) the PDF url is NOT
    // constructible: the download path carries a journal code and an internal asset id.
    // The url Unpaywall reports, /doi/pdf/<doi>, 404s. See acs-retrieval.js.
    name: 'acs',
    hosts: ['pubs.acs.org'],
    matches: (doi) => isAcsDoi(doi),
    extractId: (doi) => acsArticleId(doi),
    landingUrl: (id) => acsLandingUrl(id),
    pdfUrl: () => null,
    preferPdfLink: ACS_PDF_LINK,
    manualLabel: 'ACS article page',
    headed: false,
    // Verified live through the bridge: the /doi/<doi> landing page for the first DOI
    // yields the real Silverchair download link.
    samples: [
      { doi: '10.1021/jacs.6c07767', url: null },
      { doi: '10.1021/09826-toc', url: null },
    ],
  },
  {
    // OUP. The only entry here whose PDF url is NOT constructible: OUP's download path
    // carries an internal asset id that appears nowhere in the DOI, and advance articles
    // use a different shape again. pdfUrl therefore returns null and the resolver reads the
    // link out of the rendered page, the same path Mendeley Data takes.
    //
    // The landing page IS resolvable offline: doi.org 302s straight to the article URL and
    // that redirect is served to a plain client, so only the destination is walled.
    // extractId is synchronous and answers from a discovery URL or a memoized resolve;
    // resolveId does the round trip a bare DOI needs, exactly as the Elsevier pair do.
    name: 'oup',
    hosts: ['academic.oup.com'],
    matches: (doi, url) => isOupDoi(doi) || Boolean(oupArticlePath(url)),
    extractId: (doi, url) => oupArticlePath(url) || cachedOupPath(doi) || null,
    resolveId: (doi, url, options) => (oupArticlePath(url)
      ? Promise.resolve(oupArticlePath(url))
      : oupPath(doi, options)),
    landingUrl: (id) => oupLandingUrl(id),
    // No constructible PDF url -- see the header of oup-retrieval.js for both observed
    // download path shapes and why neither is derivable from the DOI.
    pdfUrl: () => null,
    // An OUP article page links its supplementary material as .pdf too, and those satisfy
    // the shape rules and the %PDF- check just as well as the full text does. Without this
    // the first link wins and a supplement gets filed as the paper, which is worse than a
    // failed download because nothing downstream can detect it.
    //
    // THREE shapes, all observed. The first two are paths on academic.oup.com itself; the
    // third is the signed handoff to Silverchair's watermark host, measured 2026-07-30:
    //   .../article-pdf/49/D1/D1/...
    //   .../advance-article-pdf/doi/...
    //   https://watermark02.silverchair.com/gkaa1100.pdf?token=AQECAHi208BE49O...
    // The handoff is what a browser actually follows, and matching only the first two left
    // the page's real link on the floor while the tab sat open to its budget.
    preferPdfLink: /\/(advance-)?article-pdf\/|watermark\d*\.silverchair\.com\/.+\.pdf/,
    manualLabel: 'OUP article page',
    headed: false,
    // Each sample carries the article URL as well as the DOI because extractId is
    // synchronous and a bare DOI has no path until something resolves it. The second is the
    // advance-article shape, which differs from the volume/issue one.
    samples: [
      {
        doi: '10.1093/nar/gkaa1100',
        url: 'https://academic.oup.com/nar/article/49/D1/D480/6006196',
      },
      {
        doi: '10.1093/bjs/znad132',
        url: 'https://academic.oup.com/bjs/article/110/8/996/7163415',
      },
    ],
  },
];

/**
 * First entry that claims this paper, or null. Awaits `matches` so a publisher whose
 * discriminator needs a network lookup (see the cell.com note above) fits the same
 * interface as a regexp matcher. Entries are expected to be mutually exclusive; the
 * registry test enforces that, so first-match cannot silently hide an overlap.
 *
 * `options` is passed to every matcher untouched. It exists so a network-backed
 * discriminator can be given an injected lookup (and an AbortSignal) instead of reaching
 * for the network itself, which is what keeps the registry's guards offline.
 */
export async function findPublisher(doi, url = null, options = {}) {
  for (const entry of PUBLISHERS) {
    let claimed = false;
    try {
      claimed = await entry.matches(doi, url, options);
    } catch (err) {
      // A matcher that throws (a failed network discriminator, a bad argument) must not
      // abort the whole resolver; treat it as "not mine" and let the other sources race.
      // Logged rather than swallowed, so a permanently broken matcher is visible instead
      // of just never firing.
      logger.debug(`publisher ${entry.name} matcher failed: ${err.message}`);
      claimed = false;
    }
    if (claimed) return entry;
  }
  return null;
}

/**
 * Every host any entry fetches from, deduplicated.
 *
 * This is NOT the allowlist and must never become its source. ALLOWED_HOSTS in
 * src/bridge/allowed-hosts.js is the credentialed-fetch trust boundary and stays
 * hand-maintained (it also has to be kept in step with the extension's own copy);
 * deriving it from this file would let any registry edit silently widen the grant.
 * The intended consumer is a test asserting these hosts are a SUBSET of the allowlist,
 * so a new publisher fails loudly until someone deliberately widens the boundary.
 */
export function publisherHosts() {
  return [...new Set(PUBLISHERS.flatMap((entry) => entry.hosts.map((h) => h.trim().toLowerCase())))];
}
