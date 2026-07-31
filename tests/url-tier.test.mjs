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

/**
 * The EXTENSION's own copy of the tier logic, evaluated as a plain script.
 *
 * The shipping decision is made by extension/allowlist.js (inlined into background.js), not
 * by the Node bridge copy this file imports at the top. A test that asks only the bridge can
 * be green while the code that actually talks to publishers leaks, so any assertion about a
 * grant boundary has to ask this one too.
 */
function loadExtensionCopy() {
  const src = readFileSync(join(repoRoot, 'extension/allowlist.js'), 'utf8')
    .replace(/^export /gm, '');
  return new Function(`${src}\nreturn { urlTier, credentialsFor, isAllowedUrl, TIER };`)();
}

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

test('the anonymous carve-out covers the whole subtree, not just the exact host', () => {
  // The hole this closes. The carve-out used to be an EXACT-match test against
  // ANONYMOUS_HOSTS, so it answered for api.ssrn.com and nothing below it:
  // sub.api.ssrn.com matched no anonymous entry exactly, fell through to the 'ssrn.com'
  // suffix in ALLOWED_HOSTS, and came back CREDENTIALED. That is the exact leak the
  // api.ssrn.com entry exists to prevent, reachable one label further down -- and the host
  // is DNS-controlled by whoever runs ssrn.com, not by us.
  //
  // The rule is now "the more specific grant wins", measured by matched-suffix length, so
  // 'api.ssrn.com' (12) beats 'ssrn.com' (8) for every host under it.
  // BOTH copies, not just the Node one this file imports.
  //
  // This assertion used to run against src/bridge/allowed-hosts.js alone, and the leak it
  // describes is in code that SHIPS -- the copy inlined into extension/background.js, via
  // extension/allowlist.js. Reverting the extension copy to the old exact-match rule left
  // this test green while sub.api.ssrn.com was once again being handed the user's SSRN
  // cookies, which is the whole failure the test is named after. Parity is asserted
  // elsewhere, but parity checks a fixed handful of urls and did not include this one, so
  // the leak fell between the two. Each copy is now exercised directly.
  const extension = loadExtensionCopy();
  for (const url of [
    'https://sub.api.ssrn.com/x',
    'https://a.b.api.ssrn.com/x',
  ]) {
    assert.equal(urlTier(url), TIER.ANONYMOUS, `bridge: ${url}`);
    assert.equal(credentialsFor(url), 'omit', `bridge: ${url}`);
    assert.equal(extension.urlTier(url), extension.TIER.ANONYMOUS, `extension: ${url}`);
    assert.equal(extension.credentialsFor(url), 'omit', `extension: ${url}`);
  }

  // The other direction still holds: a host under the credentialed suffix that is NOT under
  // any anonymous entry keeps its cookies, and a near-miss name is not caught by accident.
  for (const url of ['https://xapi.ssrn.com/x', 'https://papers.ssrn.com/x']) {
    assert.equal(urlTier(url), TIER.CREDENTIALED, `bridge: ${url}`);
    assert.equal(extension.urlTier(url), extension.TIER.CREDENTIALED, `extension: ${url}`);
  }
});

test('no credentialed host sits underneath an anonymous grant', () => {
  // The invariant that makes "more specific wins" safe to apply in both directions. If a
  // publisher were ever added underneath an anonymous entry, the specificity rule could
  // DOWNGRADE it and the fetch would silently lose the session it needs. Checked against
  // the real lists rather than argued, so adding such a host fails here instead of in the
  // field.
  const src = readFileSync(join(repoRoot, 'extension/allowlist.js'), 'utf8');
  const list = (name) => {
    const block = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(src);
    assert.ok(block, `${name} not found`);
    return block[1]
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .flatMap((line) => [...line.matchAll(/'([^']+)'/g)].map((m) => m[1]));
  };
  const anonymous = list('ANONYMOUS_HOSTS');
  const credentialed = list('ALLOWED_HOSTS');
  assert.ok(anonymous.length > 100 && credentialed.length > 5);

  const shadowed = credentialed
    .filter((h) => anonymous.some((a) => h === a || h.endsWith(`.${a}`)))
    .map((h) => `${h} is covered by an anonymous grant`);
  assert.deepEqual(shadowed, []);
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
  //
  // ONE exemption, and only one: a function INJECTED INTO A PAGE cannot call credentialsFor,
  // because that lives in the worker and is not in scope there. inPageFetchAsBase64 is that
  // function, and it must pass 'omit' -- the host it reads answers
  // `Access-Control-Allow-Origin: *`, and CORS forbids pairing a wildcard origin with
  // credentials, so 'include' fails before any code sees the response. The exemption is
  // narrow by construction: 'omit' can only ever REDUCE what is sent, so the hole this test
  // exists to prevent -- a call site quietly requesting cookies -- stays closed.
  const source = ['extension/background.js', 'extension/search-sources.js']
    .map((f) => readFileSync(join(repoRoot, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1'))
    .join('\n');

  // 'include' is forbidden outright, anywhere, no exemption.
  assert.deepEqual(
    source.match(/credentials:\s*'include'/g) || [], [],
    "credentials: 'include' must come from credentialsFor(url), never a literal",
  );

  // 'omit' is allowed only inside the in-page fetch helper. Checked by counting: if a second
  // one appears anywhere else, this fails and the author has to justify it here.
  const omits = source.match(/credentials:\s*'omit'/g) || [];
  assert.equal(
    omits.length, 1,
    `expected exactly one 'omit' (inPageFetchAsBase64), found ${omits.length}`,
  );
  const helper = source.slice(source.indexOf('function inPageFetchAsBase64'));
  const helperEnd = helper.indexOf('\n}\n');
  assert.match(
    helper.slice(0, helperEnd), /credentials:\s*'omit'/,
    "the one permitted 'omit' must be the one inside inPageFetchAsBase64",
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
