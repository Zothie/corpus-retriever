// Host allowlist and credential tiers for the browser bridge -- the EXTENSION's copy.
//
// Byte-identical to the region between the same markers in src/bridge/allowed-hosts.js,
// apart from the `export` keywords this file needs. tests/allowed-hosts.test.mjs and
// tests/url-tier.test.mjs extract this region, evaluate it standalone, and run the same
// adversarial vector table through both copies, so drift is a test failure rather than a
// silent security hole. Edit both or neither.
//
// The rationale for the two grant shapes, for why DigitalCommons is an explicit host list
// instead of an open .edu pattern, and for why the credential tier is derived from the url
// rather than chosen by the caller, all live in the header of src/bridge/allowed-hosts.js.
// Do not restate it here; it would drift.

// ---8<--- allowlist parity region ---8<---
export const ALLOWED_HOSTS = [
  'ssrn.com',
  // Elsevier platforms fetched through the bridge. Each is a publisher-owned
  // domain whose whole subdomain tree serves that publisher, so a suffix match
  // is the right granularity and a path constraint would only be theatre.
  'cell.com',
  'data.mendeley.com',
  'sciencedirect.com',
  // Springer Nature, not Elsevier. Included because unlike ScienceDirect it hosts its
  // OWN open-access PDFs: in a 7-paper sample, 6 had no working pdf route outside
  // nature.com, so the bridge is the only way to reach them.
  'nature.com',
  // Publishers outside Elsevier and Springer Nature, all added for the same measured
  // reason: each answers a plain client with a wall (Cloudflare 403 for the three below,
  // an F5 "Client Challenge" for link.springer.com) AND hosts its own free PDFs with no
  // copy anywhere the captcha-free sources can reach. Measured 2026-07-26 over 40-DOI
  // samples per prefix; the per-publisher numbers are in each *-retrieval.js header.
  'link.springer.com',
  'onlinelibrary.wiley.com',
  'pubs.acs.org',
  'academic.oup.com',
  // Silverchair's watermark host, where OUP and ACS actually SERVE the file. The article
  // page is on academic.oup.com and the download is a signed handoff to
  // watermark02.silverchair.com/<id>.pdf?token=..., so granting only the landing host meant
  // the tab followed the handoff, failed the origin re-pin, and then waited out its whole
  // budget on a page that could never satisfy it. Measured 2026-07-30 on 10.1093/nar/gkaa1100.
  //
  // Credentialed like the publishers it serves: the token authorises the file, but the
  // session is what authorises the token.
  'silverchair.com',
  // elsevier.com is deliberately absent: linkinghub.elsevier.com is only ever a
  // redirect hop while resolving a DOI to a PII, and our own plain HTTP client
  // does that server-side. It never goes through the bridge, so it needs no
  // credentialed-fetch grant.
];

// DigitalCommons/bepress instances on third-party university domains. Exact host,
// bepress paths only. See the header comment for why this is not an open .edu rule.
// Every host below was verified live on 2026-07-26 by fetching https://<host>/ and
// confirming the bepress markers in the response ("bepress", "Digital Commons",
// "yui3-seed"). Three entries are the canonical targets of a redirect from an older
// name, and the old name is deliberately NOT listed because it only ever 301s here:
// repository.lsu.edu (was digitalcommons.lsu.edu), digitalcommons.lib.uconn.edu (was
// digitalcommons.uconn.edu) and oasis.library.unlv.edu (was digitalscholarship.unlv.edu).
// Coverage is knowingly partial -- see the header. Add a host only after checking it
// actually serves bepress; a guessed hostname is a grant handed to whoever registers it.
export const PATH_CONSTRAINED_HOSTS = [
  { host: 'aquila.usm.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.calpoly.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.chapman.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.du.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.georgiasouthern.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.kennesaw.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.law.uw.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.lib.uconn.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.odu.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.pepperdine.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.unf.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.unl.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.unomaha.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.uri.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.usf.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.usu.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'digitalcommons.wayne.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'docs.lib.purdue.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'ecommons.udayton.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'egrove.olemiss.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'engagedscholarship.csuohio.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'epublications.marquette.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'ideaexchange.uakron.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'ir.lib.uwo.ca', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'nsuworks.nova.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'oasis.library.unlv.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'openscholarship.wustl.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'opensiuc.lib.siu.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'repository.lsu.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'researchrepository.wvu.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'scholar.smu.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'scholarcommons.sc.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'scholarship.richmond.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'scholarsarchive.byu.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'scholarworks.uni.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'stars.library.ucf.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'surface.syr.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'thekeep.eiu.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'uknowledge.uky.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
  { host: 'via.library.depaul.edu', paths: ['/cgi/viewcontent.cgi', '/context/'] },
];

// Percent-encoded path separators and dot segments. URL normalises a literal
// "../" but leaves "%2e%2e%2f" encoded, so under a PREFIX rule a path like
// "/context/..%2f..%2fwp-admin" would satisfy the prefix test here while an
// origin that decodes encoded slashes (Apache AllowEncodedSlashes On, and
// several app servers by default) resolves it to "/wp-admin". Whether that
// escape lands depends on the far end, which we cannot see, so refuse the
// encoding rather than reason about somebody else's server config.
const ENCODED_PATH_SEPARATOR = /%(2f|5c|2e)/i;

// Hosts we fetch WITHOUT the user's cookies.
//
// Mirrors, open-access APIs and search APIs. The user has no account on any of them, so
// sending credentials is a liability rather than a capability: it would attach whatever
// session Chrome happens to hold to a request that gains nothing from it.
//
// Kept SEPARATE from ALLOWED_HOSTS rather than merged with a flag, because the two lists
// answer different questions. ALLOWED_HOSTS is "may this be fetched AS THE USER", which is
// the dangerous grant and stays as narrow as it was. This list is "may this be fetched at
// all", which is a much weaker permission -- an anonymous fetch of a public API is close to
// what any web page can already do.
//
// Sci-Hub is here, but its tier is honest rather than absolute: clearing its captcha
// requires a real tab, and a tab is a full credentialed session no fetch option can strip.
// What the anonymous tier buys is that the BYTES are fetched without ambient authority and
// no publisher cookie is ever sent to a mirror.
const ANONYMOUS_HOSTS = [
  // Sci-Hub. The mirror set rotates, so the live list is polled from a CSV at runtime and
  // every entry is checked against this list before use -- a rotating list is not a licence
  // to fetch a host nobody vetted.
  'sci-hub.ru',
  'sci-hub.st',
  'sci-hub.su',
  'sci-hub.red',
  'sci-hub.box',
  // Where the live mirror list is published. Granted only so the list can be READ; every
  // host it names is then intersected with the entries above, so this cannot widen the
  // grant -- a spoofed list can only remove mirrors, never add one. Found by reading the
  // "Open in Sci-Hub" extension, which polls it rather than hardcoding domains that rotate.
  'cdn.lowyiyiu.com',
  // Mirrors.
  // The LIVE domains, not the historical ones. Measured 2026-07-28: libgen.is/.rs/.st and
  // annas-archive.org/.se are dead (DNS gaierror or TCP timeout) while every host below
  // answered 200. Probing the dead ones first produced a wrong conclusion -- that both
  // mirror networks were blocked from this machine -- so the live set is recorded here
  // explicitly and availability is decided per run rather than assumed.
  'libgen.bz',
  'libgen.li',
  'libgen.la',
  'libgen.vg',
  'libgen.gl',
  'annas-archive.gd',
  'annas-archive.pk',
  'annas-archive.gl',
  'annas-archive.li',
  // Open-access PUBLISHERS whose PDFs the OA resolvers hand back directly. These are not
  // walled and need no session -- they are here so an OA candidate is fetchable at all.
  //
  // This list is knowingly incomplete and always will be: Unpaywall and OpenAlex can return
  // a pdf on ANY repository or publisher that deposited one, and enumerating every OA host
  // on the internet is not possible. The consequence is honest -- an OA pdf on an unlisted
  // host is refused and the paper falls through to another source -- and the alternative
  // (trusting whatever host an API names) would let a compromised or spoofed API response
  // point a fetch anywhere. Measured 2026-07-28: journals.plos.org was refused this way,
  // which is what prompted adding these rather than relaxing the rule.
  'journals.plos.org',
  'plos.org',
  'www.frontiersin.org',
  'frontiersin.org',
  'www.mdpi.com',
  'mdpi.com',
  'peerj.com',
  'elifesciences.org',
  'zenodo.org',
  'osf.io',
  // Broad open-access coverage, added 2026-07-30 after a measured failure: OpenAlex handed
  // back a valid 2.16 MB PDF on genomebiology.biomedcentral.com, the tier check refused it,
  // and the download spent eighteen seconds opening Sci-Hub, Anna's and LibGen tabs for a
  // paper open access was giving away. The list above was too narrow to be useful.
  //
  // These are ANONYMOUS: credentialsFor still answers 'omit' for every one, so no cookie is
  // ever sent to any of them. The grant is only "these bytes may be fetched at all".
  //
  // Deliberately wide, including hosts we have not yet needed. An OA resolver can name any
  // repository that deposited a copy, so a list that only grows when a user reports a
  // failure means every new publisher costs somebody a broken download first.
  'biomedcentral.com', 'springeropen.com',
  'science.org', 'hindawi.com',
  'tandfonline.com', 'sagepub.com', 'journals.sagepub.com', 'cambridge.org',
  'rsc.org', 'pubs.rsc.org', 'iop.org', 'iopscience.iop.org',
  'aps.org', 'journals.aps.org', 'aip.org', 'pubs.aip.org', 'ieee.org',
  'ieeexplore.ieee.org', 'acm.org', 'dl.acm.org', 'jstage.jst.go.jp',
  'scielo.br', 'scielo.org', 'degruyter.com', 'karger.com', 'thieme-connect.de',
  'emerald.com', 'inderscience.com', 'copernicus.org', 'pnas.org', 'www.pnas.org',
  'jamanetwork.com', 'bmj.com', 'www.bmj.com', 'thelancet.com', 'nejm.org',
  'ahajournals.org', 'physiology.org', 'asm.org', 'journals.asm.org',
  'biologists.com', 'rupress.org', 'cshlp.org', 'embopress.org', 'jbc.org',
  'jimmunol.org', 'haematologica.org', 'aacrjournals.org', 'ashpublications.org',
  'jci.org',
  // Repositories, preprint servers and aggregators.
  'figshare.com', 'dryad.org', 'datadryad.org', 'chemrxiv.org',
  'researchsquare.com', 'preprints.org', 'hal.science', 'archives-ouvertes.fr',
  'semanticscholar.org', 'base-search.net', 'openaire.eu', 'dspace.mit.edu',
  'escholarship.org', 'repec.org', 'econstor.eu', 'jstor.org',
  // Repository SOFTWARE domains -- where most green OA actually lives.
  'bepress.com', 'dspace.org', 'eprints.org', 'digitalcommons.net',
  'contentdm.oclc.org',
  // Object storage the above redirect into. A PDF very often ends up on one of these, and
  // a grant that stops at the publisher's own domain dies at the redirect.
  'cloudfront.net', 'amazonaws.com', 'blob.core.windows.net',
  'storage.googleapis.com', 'figstatic.com',
  // Measured 2026-07-30, the same way PLOS was found: a real download resolved to one of
  // these and was refused, so the extension went off to open mirror tabs for a paper it
  // already had. BioMedCentral hosts the whole BMC/Genome Biology family; science.org is
  // where AAAS serves its own free-to-read PDFs.
  'genomebiology.biomedcentral.com',
  'biomedcentral.com',
  'springeropen.com',
  'www.science.org',
  'science.org',
  // Open-access APIs and their download hosts.
  'api.unpaywall.org',
  'api.openalex.org',
  'api.core.ac.uk',
  'core.ac.uk',
  'www.ebi.ac.uk',
  'europepmc.org',
  'pmc.ncbi.nlm.nih.gov',
  'ftp.ncbi.nlm.nih.gov',
  'eutils.ncbi.nlm.nih.gov',
  'api.crossref.org',
  // PMCID lookup lives on the main NCBI host, not on eutils.
  'www.ncbi.nlm.nih.gov',
  'doi.org',
  'dx.doi.org',
  // Search APIs. api.ssrn.com is a plain CORS API and is NOT the Cloudflare-challenged
  // papers.ssrn.com: measured 2026-07-28, a service-worker fetch returns 200 with results,
  // which is what removed the Python/curl_cffi dependency.
  'api.ssrn.com',
  'export.arxiv.org',
  'arxiv.org',
  'api.biorxiv.org',
  // Google Scholar. Reached with a TAB rather than a fetch -- it has no API, blocks
  // datacenter traffic, and serves consent/captcha interstitials, which is exactly the
  // case this extension exists for: from the user's own logged-in browser on a residential
  // IP it is an ordinary page. A headless fetcher needs Puppeteer for it; this does not.
  'scholar.google.com',
  // The preprint PDFs themselves, which is where searchBiorxiv's pdfUrl points. Granted
  // separately from api.biorxiv.org because they are different hosts and the API host
  // serves no files.
  'biorxiv.org',
  'medrxiv.org',
];

/** The two grants a URL can fall under, plus "no grant at all". */
export const TIER = {
  CREDENTIALED: 'credentialed',
  ANONYMOUS: 'anonymous',
  NONE: null,
};

/**
 * Which tier a URL falls under. THE ONLY place a credential decision is made.
 *
 * Returning a tier rather than a boolean is the point. The previous shape let each call
 * site pass its own `credentials`, defaulting to 'include' -- fail-open, so one missed
 * argument anywhere would have been a silent credentialed fetch to a mirror. Deriving the
 * tier from the URL inside the fetch primitive means a caller CANNOT choose, and adding a
 * host to the wrong list is the only way to get it wrong.
 *
 * Checked credentialed-first so a host on both lists gets the stronger grant, and so the
 * anonymous list can never quietly downgrade a publisher.
 */
export function urlTier(url) {
  if (typeof url !== 'string') return TIER.NONE;
  // An EXACT entry in the anonymous list beats the credentialed SUFFIX grant.
  //
  // api.ssrn.com is the case this exists for. ALLOWED_HOSTS grants 'ssrn.com' by suffix,
  // which would otherwise swallow api.ssrn.com and send the user's SSRN session to a
  // search API that neither needs nor should receive it. papers.ssrn.com is unaffected --
  // it is not an exact entry here, so it keeps the credentialed grant it has always had.
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (ANONYMOUS_HOSTS.includes(host)) {
      // Still has to clear the structural checks below.
      return anonymousTierFor(url);
    }
  } catch {
    return TIER.NONE;
  }
  if (isAllowedUrl(url)) return TIER.CREDENTIALED;
  return anonymousTierFor(url);
}

/**
 * ANONYMOUS or NONE, applying every structural check isAllowedUrl makes.
 *
 * An anonymous fetch still leaves the user's browser from the user's IP, so "no cookies"
 * is not a reason to relax the host parsing. Split out so the exact-match branch above and
 * the suffix branch here cannot drift into two different notions of a valid host.
 */
function anonymousTierFor(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return TIER.NONE;
  }
  if (u.protocol !== 'https:') return TIER.NONE;
  if (u.username || u.password) return TIER.NONE;
  if (u.port !== '') return TIER.NONE;
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) return TIER.NONE;
  return ANONYMOUS_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
    ? TIER.ANONYMOUS
    : TIER.NONE;
}

/** The fetch credentials a URL's tier permits, or null when it may not be fetched. */
export function credentialsFor(url) {
  const tier = urlTier(url);
  if (tier === TIER.CREDENTIALED) return 'include';
  if (tier === TIER.ANONYMOUS) return 'omit';
  return null;
}

/** True when url is https and its host and path are covered by one of the two grants. */
export function isAllowedUrl(url) {
  // Only accept a real string. Coercing via String() would let an array, a URL
  // object or anything with a friendly toString() through the gate, and the
  // caller would then hand the un-coerced value to the fetch layer.
  if (typeof url !== 'string') return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  // Reject embedded credentials: https://papers.ssrn.com@evil.com/ has host evil.com,
  // but the userinfo makes it easy to misread. Refuse outright.
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  // Fail closed on anything that is not a plain sequence of non-empty labels.
  // This drops the trailing-dot FQDN form ("ssrn.com."), leading/doubled dots
  // (".ssrn.com" would otherwise satisfy the endsWith test) and IPv6 literals,
  // which URL exposes bracketed as "[::1]".
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) return false;
  // Pin the port. The grants name hosts, not services; without this a caller
  // could aim a credentialed fetch at any port on a granted host.
  if (u.port !== '') return false;
  if (ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  // Path-constrained grant. u.pathname is already dot-segment normalised by URL,
  // so "/a/../cgi/viewcontent.cgi" simply IS "/cgi/viewcontent.cgi" and matching
  // it is correct rather than a bypass. Percent-encoding is NOT normalised,
  // which is the case ENCODED_PATH_SEPARATOR handles.
  const rule = PATH_CONSTRAINED_HOSTS.find((r) => host === r.host);
  if (!rule) return false;
  if (ENCODED_PATH_SEPARATOR.test(u.pathname)) return false;
  return rule.paths.some((p) => (p.endsWith('/') ? u.pathname.startsWith(p) : u.pathname === p));
}
// ---8<--- end allowlist parity region ---8<---

/**
 * May a tab be opened here?
 *
 * Deliberately looser than isAllowedUrl, and only for navigation. On a bepress host the
 * challenge has to be solved on the article's landing page, whose path is arbitrary
 * (/jate/vol15/iss2/1), while the byte-returning grant is pinned to /cgi/viewcontent.cgi.
 * Opening a tab returns nothing to the caller -- pageIsCleared reads only location.origin
 * and challenge markers -- so the capability being granted here is "show the user a page
 * on a host we already trust", not "read it". Every path that returns bytes still goes
 * through isAllowedUrl.
 */
export function isAllowedNavigationUrl(url) {
  if (isAllowedUrl(url)) return true;
  if (typeof url !== 'string') return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (u.port !== '') return false;
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) return false;
  return PATH_CONSTRAINED_HOSTS.some((r) => host === r.host);
}

