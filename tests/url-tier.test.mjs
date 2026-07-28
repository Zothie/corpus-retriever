// The credential tier, and why it is derived rather than passed.
//
// Before this existed, `workerFetch(url, maxBytes, credentials = 'include')` let every call
// site choose, and defaulted to the dangerous option. With only publishers in the grant
// that was survivable. Adding mirrors makes it a hole: one forgotten argument would fetch
// LibGen carrying whatever session Chrome holds.
//
// So the invariant under test is NOT "call sites pass the right thing" -- it is "call sites
// cannot pass anything". credentialsFor() is the single decision point, and these tests
// pin its answers, especially the refusals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { urlTier, credentialsFor, TIER, isAllowedUrl } from '../src/bridge/allowed-hosts.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('publishers are credentialed, and unchanged by the split', () => {
  for (const url of [
    'https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1',
    'https://www.cell.com/action/showPdf?pii=X',
    'https://link.springer.com/content/pdf/10.1007/x.pdf',
    'https://onlinelibrary.wiley.com/doi/pdfdirect/10.1002/x',
    'https://pubs.acs.org/doi/10.1021/x',
    'https://academic.oup.com/nar/article/1/1/1/1',
    'https://www.nature.com/articles/x.pdf',
    'https://digitalcommons.unl.edu/cgi/viewcontent.cgi?article=1&context=x',
  ]) {
    assert.equal(urlTier(url), TIER.CREDENTIALED, url);
    assert.equal(credentialsFor(url), 'include', url);
  }
});

test('mirrors, OA APIs and search APIs are anonymous', () => {
  for (const url of [
    'https://sci-hub.ru/10.1016/j.jfineco.2019.05.005',
    'https://libgen.bz/index.php?req=x',
    'https://annas-archive.gd/scidb/10.1/x',
    'https://api.unpaywall.org/v2/10.1/x?email=a@b.c',
    'https://api.openalex.org/works/doi:10.1/x',
    'https://api.ssrn.com/papers/v1/papers/search/advanced?text=x',
    'https://export.arxiv.org/api/query?search_query=x',
    'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed',
    'https://api.biorxiv.org/details/biorxiv/10.1101/x',
    'https://scholar.google.com/scholar?q=x',
  ]) {
    assert.equal(urlTier(url), TIER.ANONYMOUS, url);
    assert.equal(credentialsFor(url), 'omit', url);
  }
});

test('an unlisted host is refused outright, not fetched anonymously', () => {
  // The distinction that matters: "not on any list" means "not ours to fetch", NOT "safe
  // to fetch without cookies". Returning 'omit' here would turn the extension into an
  // open proxy that happens not to send cookies.
  for (const url of [
    'https://evil.com/x.pdf',
    'https://example.org/paper.pdf',
    'https://google.com/',
  ]) {
    assert.equal(urlTier(url), TIER.NONE, url);
    assert.equal(credentialsFor(url), null, url);
  }
});

test('the anonymous tier applies every structural check the credentialed one does', () => {
  // An anonymous fetch still leaves the user's browser from the user's IP, so a crafted
  // host must not reach the network just because no cookies would ride along.
  for (const url of [
    'http://sci-hub.ru/x',                    // not https
    'https://user:pw@sci-hub.ru/x',           // embedded credentials
    'https://sci-hub.ru:8443/x',              // pinned port
    'https://sci-hub.ru./x',                  // trailing-dot FQDN
    'https://.sci-hub.ru/x',                  // leading dot
    'https://sci-hub.ru.evil.com/x',          // suffix trick
    'https://notsci-hub.ru/x',                // missing dot boundary
    'https://evil.com/?u=https://sci-hub.ru/', // allowlisted host in the query
    'not a url',
    '',
    null,
    undefined,
    42,
    ['https://sci-hub.ru/x'],
  ]) {
    assert.equal(urlTier(url), TIER.NONE, JSON.stringify(url));
    assert.equal(credentialsFor(url), null, JSON.stringify(url));
  }
});

test('a subdomain of an anonymous host is anonymous, not refused', () => {
  assert.equal(urlTier('https://www.sci-hub.ru/x'), TIER.ANONYMOUS);
  assert.equal(urlTier('https://libgen.bz/x'), TIER.ANONYMOUS);
});

test('credentialed wins when a host could match both lists', () => {
  // Checked credentialed-first so the anonymous list can never quietly DOWNGRADE a
  // publisher. papers.ssrn.com is credentialed even though ssrn.com also appears in the
  // anonymous set via api.ssrn.com.
  assert.equal(urlTier('https://papers.ssrn.com/x'), TIER.CREDENTIALED);
  assert.equal(isAllowedUrl('https://papers.ssrn.com/x'), true);

  // api.ssrn.com is the inverse, and the reason exact-match beats suffix-match.
  // isAllowedUrl says TRUE here -- the credentialed grant lists 'ssrn.com' by suffix, and
  // that is not a bug in isAllowedUrl, whose job is only "is this host in the grant".
  // Deciding CREDENTIALS from it would send the user's SSRN session to a search API that
  // neither needs nor should receive it, so urlTier overrides with the exact entry.
  assert.equal(isAllowedUrl('https://api.ssrn.com/papers/v1/papers'), true);
  assert.equal(urlTier('https://api.ssrn.com/papers/v1/papers'), TIER.ANONYMOUS);
  assert.equal(credentialsFor('https://api.ssrn.com/papers/v1/papers'), 'omit');
});

// --- the invariant, enforced structurally -------------------------------------------

test('no fetch in the extension may pass a hardcoded credentials value', () => {
  // The actual regression guard. A future edit that reintroduces
  // `fetch(url, { credentials: 'include' })` anywhere in the extension puts the choice back
  // at the call site, which is the shape that made this a hole in the first place.
  // Every file in the extension that can fetch, not just background.js -- search-sources.js
  // makes its own requests and is exactly where a hardcoded credential would next appear.
  //
  // Strip comments first: the rationale for the anonymous retry legitimately mentions
  // credentials:'include' in prose, and matching that would make this unfixable-by-design.
  const hardcoded = ['extension/background.js', 'extension/search-sources.js']
    .flatMap((f) => readFileSync(join(repoRoot, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .match(/credentials:\s*'(include|omit)'/g) || []);
  assert.deepEqual(
    hardcoded, [],
    'credentials must come from credentialsFor(url), never a literal at the call site',
  );
});

test('workerFetch cannot be handed a credentials string', () => {
  // Its third parameter is a boolean that only DOWNGRADES. If it ever accepts a string
  // again, a caller can request 'include' for a mirror.
  const src = readFileSync(join(repoRoot, 'extension/background.js'), 'utf8');
  const sig = /async function workerFetch\(([^)]*)\)/.exec(src);
  assert.ok(sig, 'workerFetch not found');
  assert.match(sig[1], /forceAnonymous\s*=\s*false/, 'third arg must be the boolean downgrade');
  assert.doesNotMatch(sig[1], /credentials/, 'workerFetch must not take a credentials argument');
});

test('the extension and Node copies agree on every tier verdict', () => {
  // Same parity guarantee the allowlist already had, extended to the tier logic: the
  // extension carries its own copy inside the parity markers, and a drift there is a
  // security difference, not a style difference.
  // The extension's copy lives in its own module now, so the whole file IS the region.
  // Stripping `export ` is what makes it evaluable as a plain script here.
  const region = readFileSync(join(repoRoot, 'extension/allowlist.js'), 'utf8')
    .replace(/^export /gm, '');
  assert.ok(region.includes('function urlTier'), 'extension copy is missing urlTier');
  assert.ok(region.includes('function credentialsFor'), 'extension copy is missing credentialsFor');

  const ext = new Function(`${region}\nreturn { urlTier, credentialsFor, TIER };`)();
  for (const url of [
    'https://papers.ssrn.com/x',
    'https://sci-hub.ru/x',
    'https://api.ssrn.com/papers/v1/papers',
    'https://evil.com/x',
    'https://libgen.is/x',
    'https://sci-hub.ru.evil.com/x',
    'http://sci-hub.ru/x',
  ]) {
    assert.equal(ext.urlTier(url), urlTier(url), `tier drift for ${url}`);
    assert.equal(ext.credentialsFor(url), credentialsFor(url), `credentials drift for ${url}`);
  }
});
