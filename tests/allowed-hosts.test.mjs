// The allowlist is the trust boundary for the browser bridge: whatever reaches the
// unix socket can make credentialed fetches at any host it permits. It exists in two
// independent copies (Node and the Chrome extension) which must agree, so this file
// defines ONE vector table and runs it through both.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  isAllowedUrl,
  ALLOWED_HOSTS,
  PATH_CONSTRAINED_HOSTS,
} from '../src/bridge/allowed-hosts.js';
import { publisherHosts } from '../src/publishers/publishers.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const START = '// ---8<--- allowlist parity region ---8<---';
const END = '// ---8<--- end allowlist parity region ---8<---';

/** The marked block of a file, or throws if the markers are missing or malformed. */
function parityRegion(relPath) {
  const src = readFileSync(join(repoRoot, relPath), 'utf8');
  const from = src.indexOf(START);
  const to = src.indexOf(END);
  assert.ok(from !== -1, `${relPath}: missing parity start marker`);
  assert.ok(to > from, `${relPath}: missing or misplaced parity end marker`);
  return src.slice(from + START.length, to).trim();
}

/**
 * Evaluates the extension's copy standalone. It is plain script text (no imports and
 * no chrome.* calls inside the region), so a Function wrapper is enough to get an
 * isolated scope with its own bindings -- the point is that nothing here can close
 * over the Node implementation and make the parity check pass by aliasing.
 *
 * KNOWN LIMIT: this runs the extension's source on Node's WHATWG URL, not Chrome's.
 * Both implement the same spec (UTS46 non-transitional), and the two checks are
 * ANDed in production -- the Node copy gates the socket before the extension ever
 * sees the request -- so an engine divergence fails closed rather than open. What
 * this file proves is that the two sources agree; it cannot prove the two engines
 * do. Anything relying on engine-specific URL behaviour is out of its reach.
 */
function loadExtensionCopy() {
  // `export ` is stripped because the extension's copy is now its own ES module (it has to
  // be, so search-sources.js can import the tier resolver instead of carrying a third
  // copy). The Function wrapper is still the point: it gives the extension's source its
  // own bindings, so nothing here can close over the Node implementation and make the
  // parity check pass by aliasing.
  const code = parityRegion('extension/allowlist.js').replace(/^export /gm, '');
  return new Function(`${code}\nreturn { isAllowedUrl, ALLOWED_HOSTS, PATH_CONSTRAINED_HOSTS };`)();
}

const ext = loadExtensionCopy();

// --- the single shared vector table -------------------------------------------------
// [input, expected, why]. Every entry runs through both implementations.

const VECTORS = [
  // accepted: SSRN
  ['https://papers.ssrn.com/sol3/Delivery.cfm?abstractid=1', true, 'ssrn delivery'],
  ['https://download.ssrn.com/14/01/28/ssrn_id1.pdf?X-Amz-Signature=x', true, 'ssrn download'],
  ['https://ssrn.com/abstract=1', true, 'ssrn apex'],
  ['https://sub.sub.ssrn.com/x', true, 'nested subdomain'],
  ['https://PAPERS.SSRN.COM/x', true, 'uppercase host'],
  ['HTTPS://Papers.Ssrn.Com/x', true, 'uppercase scheme and host'],

  // accepted: the hosts added for the Elsevier platforms
  ['https://www.cell.com/action/showPdf?pii=X', true, 'cell showPdf'],
  ['https://www.cell.com/heliyon/pdf/S2405-8440.pdf', true, 'cell journal pdf'],
  ['https://cell.com/x', true, 'cell apex'],
  ['https://data.mendeley.com/datasets/x/1', true, 'mendeley dataset'],
  ['https://www.sciencedirect.com/science/article/pii/X/pdfft', true, 'sciencedirect pdfft'],
  ['https://www.nature.com/articles/s41598-020-69209-2.pdf', true, 'nature pdf'],
  ['https://nature.com/articles/x', true, 'nature apex'],

  // accepted: the publishers granted for their own Cloudflare/F5-walled PDFs. Each is
  // granted at the SUBDOMAIN, not the apex -- link.springer.com, not springer.com -- so
  // the reject vectors below check the parent stays out.
  ['https://link.springer.com/content/pdf/10.1007/s11367-021-01974-2.pdf', true, 'springer pdf'],
  ['https://onlinelibrary.wiley.com/doi/pdfdirect/10.1002/advs.202004433', true, 'wiley pdfdirect'],
  ['https://www.onlinelibrary.wiley.com/doi/pdfdirect/10.1002/x', true, 'wiley www subdomain'],
  ['https://pubs.acs.org/doi/pdf/10.1021/acs.est.0c02765', true, 'acs pdf'],
  ['https://academic.oup.com/nar/article-pdf/49/D1/D480/35364011/gkaa1100.pdf', true, 'oup article-pdf'],
  // Silverchair's watermark host: where OUP and ACS actually serve the file, reached by a
  // signed handoff off the article page. Granting only the landing host left the tab
  // following a redirect it could never satisfy, so it waited out its whole budget.
  ['https://watermark02.silverchair.com/gkaa1100.pdf?token=AQECAHi208BE49O', true, 'oup watermark handoff'],

  // accepted: DigitalCommons, only on a listed host AND a bepress path
  ['https://digitalcommons.unl.edu/cgi/viewcontent.cgi?article=1&context=x', true, 'bepress viewcontent'],
  ['https://digitalcommons.usu.edu/context/etd/article/1/type/native/viewcontent', true, 'bepress context prefix'],

  // rejected: DigitalCommons host allowed, path not
  ['https://digitalcommons.unl.edu/', false, 'listed host, root path'],
  ['https://digitalcommons.unl.edu/wp-admin', false, 'listed host, admin path'],
  ['https://digitalcommons.unl.edu/cgi/viewcontent.cgi.evil', false, 'path suffix is not an exact match'],
  ['https://digitalcommons.unl.edu/x/cgi/viewcontent.cgi', false, 'bepress path must not float'],
  ['https://digitalcommons.unl.edu/contextual/x', false, 'prefix rule requires the trailing slash'],
  ['https://digitalcommons.unl.edu/cgi%2fviewcontent.cgi', false, 'percent-encoded separator'],
  ['https://digitalcommons.unl.edu/a/../wp-admin', false, 'dot segments do not reach a bepress path'],
  ['https://digitalcommons.unl.edu/context/..%2f..%2fwp-admin', false, 'encoded slash escape from the prefix rule'],
  ['https://digitalcommons.unl.edu/context/..%2F..%2Fwp-admin', false, 'encoded slash escape, uppercase'],
  ['https://digitalcommons.unl.edu/context/%2e%2e/%2e%2e/wp-admin', false, 'encoded dot segments'],
  ['https://digitalcommons.unl.edu/context/..%5c..%5cwp-admin', false, 'encoded backslash escape'],
  ['https://digitalcommons.unl.edu:8080/cgi/viewcontent.cgi', false, 'explicit port on a bepress host'],

  // accepted: URL normalises dot segments, so this simply IS the bepress path
  ['https://digitalcommons.unl.edu/a/../cgi/viewcontent.cgi', true, 'dot segments normalise to the bepress path'],

  // rejected: the grants name hosts, not services
  ['https://papers.ssrn.com:9000/x', false, 'nonstandard port on a suffix-granted host'],
  ['https://www.cell.com:8443/x', false, 'nonstandard port on cell'],

  // rejected: the .edu set is NOT open, with or without a bepress path
  ['https://evil.edu/wp-admin', false, 'unlisted .edu, hostile path'],
  ['https://evil.edu/cgi/viewcontent.cgi', false, 'unlisted .edu, bepress path -- the whole point'],
  ['https://evil.edu/context/x', false, 'unlisted .edu, context path'],
  // vc.bridgew.edu really does run bepress, and is deliberately not on the list. Coverage
  // is partial by design: an instance is granted only after someone verifies it, so
  // "genuinely bepress" is not by itself a reason to accept.
  ['https://vc.bridgew.edu/cgi/viewcontent.cgi', false, 'real but unlisted bepress instance'],
  ['https://scholarworks.wm.edu/cgi/viewcontent.cgi', false, 'unlisted repository host'],
  ['https://repo.ac.uk/cgi/viewcontent.cgi', false, 'unlisted ac.uk'],
  ['https://sub.digitalcommons.unl.edu/cgi/viewcontent.cgi', false, 'no subdomain suffix on third-party hosts'],
  ['https://digitalcommons.unl.edu.evil.com/cgi/viewcontent.cgi', false, 'listed host as a prefix label'],
  ['https://library.unl.edu/cgi/viewcontent.cgi', false, 'sibling host on the same university'],

  // rejected: lookalikes of the new hosts
  ['https://cell.com.evil.com/x', false, 'cell suffix trick'],
  ['https://notcell.com/x', false, 'cell without the dot boundary'],
  ['https://data.mendeley.com.evil.com/x', false, 'mendeley suffix trick'],
  ['https://mendeley.com/x', false, 'parent of an allowlisted subdomain is not allowlisted'],
  ['https://data.mendeley.com.br/x', false, 'ccTLD extension of the allowlisted host'],
  ['https://sciencedirect.com.evil.com/x', false, 'sciencedirect suffix trick'],
  ['https://nature.com.evil.com/x', false, 'nature suffix trick'],
  ['https://notnature.com/x', false, 'nature substring trick'],
  // rejected: the parents of the four subdomain grants. Granting springer.com would pull
  // in every Springer Nature property, and wiley.com/acs.org/oup.com likewise -- only the
  // one platform subdomain that serves the PDFs is trusted.
  ['https://springer.com/x', false, 'springer apex is not granted'],
  ['https://www.springer.com/x', false, 'springer www is not granted'],
  ['https://link.springer.com.evil.com/x', false, 'springer suffix trick'],
  ['https://wiley.com/x', false, 'wiley apex is not granted'],
  ['https://onlinelibrary.wiley.com.evil.com/x', false, 'wiley suffix trick'],
  ['https://acs.org/x', false, 'acs apex is not granted'],
  ['https://pubs.acs.org.evil.com/x', false, 'acs suffix trick'],
  ['https://oup.com/x', false, 'oup apex is not granted'],
  ['https://academic.oup.com.evil.com/x', false, 'oup suffix trick'],

  ['https://elsevier.com/x', false, 'elsevier is deliberately not granted'],
  ['https://linkinghub.elsevier.com/retrieve/pii/X', false, 'linkinghub is resolved server-side, not bridged'],
  ['https://evil.com/?u=https://cell.com/x', false, 'allowlisted host in the query'],
  ['https://evil.com/#https://data.mendeley.com/x', false, 'allowlisted host in the fragment'],

  // rejected: lookalikes of SSRN
  ['https://ssrn.com.evil.com/x', false, 'ssrn suffix trick'],
  ['https://SSRN.COM.EVIL.COM/x', false, 'uppercase suffix trick'],
  ['https://notssrn.com/x', false, 'ssrn without the dot boundary'],
  ['https://evil.com/?a=ssrn.com', false, 'ssrn in the query'],
  ['https://evil.com/ssrn.com', false, 'ssrn in the path'],
  ['https://evil.com/x#ssrn.com', false, 'ssrn in the fragment'],
  ['https://evil.com/x#.ssrn.com', false, 'dotted ssrn in the fragment'],
  ['https://evil.com/x?next=https://papers.ssrn.com/y', false, 'ssrn in a redirect parameter'],
  ['https://evil.com/.ssrn.com/x', false, 'dotted ssrn as a path segment'],

  // rejected: malformed host labels
  ['https://.ssrn.com/x', false, 'leading dot'],
  ['https://..ssrn.com/x', false, 'doubled leading dot'],
  ['https://ssrn.com./x', false, 'trailing-dot FQDN'],
  ['https://papers.ssrn.com./x', false, 'trailing-dot FQDN with subdomain'],
  ['https://ssrn.com.evil.com./x', false, 'trailing-dot hostile mirror'],
  ['https://.cell.com/x', false, 'leading dot on a new host'],
  ['https://cell.com./x', false, 'trailing dot on a new host'],
  ['https://.data.mendeley.com/x', false, 'leading dot on the mendeley host'],
  ['https://digitalcommons.unl.edu./cgi/viewcontent.cgi', false, 'trailing dot on a bepress host'],

  // rejected: homographs and encoded separators
  ['https://\u0455srn.com/x', false, 'cyrillic dze homograph'],
  ['https://ssrn.co\u0271/x', false, 'latin m with hook homograph'],
  ['https://xn--srn-hmc.com/x', false, 'punycode form'],
  ['https://ssrn.com\u3002evil.com/x', false, 'ideographic full stop maps to a dot'],
  ['https://ssrn.com%2eevil.com/x', false, 'percent-encoded dot'],
  ['https://evil.com%2fssrn.com/x', false, 'percent-encoded slash'],
  ['https://\u0441ell.com/x', false, 'cyrillic es homograph of cell.com'],

  // rejected: IP literals and internal targets
  ['https://127.0.0.1/x', false, 'loopback v4'],
  ['https://localhost/x', false, 'loopback name'],
  ['https://169.254.169.254/latest/meta-data/', false, 'cloud metadata'],
  ['https://[::1]/x', false, 'loopback v6'],
  ['https://[::1]:443/x', false, 'loopback v6 with port'],
  ['https://[::ffff:127.0.0.1]/x', false, 'v4-mapped v6'],
  ['https://[fe80::1]/x', false, 'link-local v6'],
  ['https://0x7f000001/x', false, 'hex-encoded v4'],
  ['https://2130706433/x', false, 'integer-encoded v4'],

  // rejected: non-https schemes
  ['http://papers.ssrn.com/x', false, 'plain http'],
  ['http://www.cell.com/x', false, 'plain http on a new host'],
  ['http://digitalcommons.unl.edu/cgi/viewcontent.cgi', false, 'plain http on a bepress host'],
  ['ftp://papers.ssrn.com/x', false, 'ftp'],
  ['file:///etc/passwd', false, 'file'],
  ['data:text/html,<b>x</b>', false, 'data'],
  ['javascript:fetch("https://papers.ssrn.com")', false, 'javascript'],
  ['ws://papers.ssrn.com/x', false, 'websocket'],
  ['blob:https://papers.ssrn.com/1234', false, 'blob'],
  ['//papers.ssrn.com/x', false, 'protocol-relative'],
  ['papers.ssrn.com/x', false, 'bare host'],

  // rejected: embedded credentials
  ['https://user:pass@papers.ssrn.com/x', false, 'user and password'],
  ['https://user@papers.ssrn.com/x', false, 'user only'],
  ['https://:pass@papers.ssrn.com/x', false, 'password only'],
  ['https://papers.ssrn.com@evil.com/x', false, 'userinfo misread trick'],
  ['https://www.cell.com@evil.com/x', false, 'userinfo misread trick on a new host'],
  ['https://u:p@digitalcommons.unl.edu/cgi/viewcontent.cgi', false, 'credentials on a bepress host'],

  // rejected: junk strings
  ['not a url', false, 'not a url'],
  ['', false, 'empty string'],
  [' https://evil.com/x', false, 'leading whitespace'],
  ['https://evil.com\n/x', false, 'embedded newline'],
  ['https://evil.com/x\u0000.ssrn.com', false, 'embedded nul'],

  // rejected: non-strings, which must not be coerced
  [null, false, 'null'],
  [undefined, false, 'undefined'],
  [0, false, 'zero'],
  [42, false, 'number'],
  [true, false, 'boolean'],
  [{}, false, 'plain object'],
  [{ toString: () => 'https://papers.ssrn.com/x' }, false, 'friendly toString'],
  [['https://papers.ssrn.com/x'], false, 'single-element array'],
  [['https://papers.ssrn.com/x', 'https://evil.com/x'], false, 'two-element array'],
  [new URL('https://papers.ssrn.com/x'), false, 'URL object'],
  [Symbol.iterator, false, 'symbol'],
];

// The DigitalCommons instance list is long and every entry is the same shape, so its
// accept vectors are generated rather than typed out. Generated from the Node copy's list
// but run through BOTH implementations, so a host present in one copy and missing from
// the other still fails here (and again in the textual parity test below).
for (const { host } of PATH_CONSTRAINED_HOSTS) {
  VECTORS.push(
    [`https://${host}/cgi/viewcontent.cgi?article=1&context=x`, true, `${host} viewcontent`],
    [`https://${host}/context/x/article/1/type/native/viewcontent`, true, `${host} context prefix`],
    // The grant is host AND path; a listed instance must not become an any-path grant.
    [`https://${host}/wp-admin`, false, `${host} non-bepress path`],
    [`https://${host}/`, false, `${host} root path`],
  );
}

function label(input) {
  return typeof input === 'string' ? JSON.stringify(input) : String(typeof input);
}

test('node implementation matches the vector table', () => {
  for (const [input, expected, why] of VECTORS) {
    assert.equal(isAllowedUrl(input), expected, `${why}: ${label(input)}`);
  }
});

test('extension implementation matches the same vector table', () => {
  for (const [input, expected, why] of VECTORS) {
    assert.equal(ext.isAllowedUrl(input), expected, `${why}: ${label(input)}`);
  }
});

test('the vector table covers both outcomes and every granted host', () => {
  const accepted = VECTORS.filter(([, e]) => e === true).map(([u]) => u);
  assert.ok(accepted.length > 0, 'table has accept cases');
  assert.ok(VECTORS.filter(([, e]) => e === false).length > 50, 'table has substantial reject coverage');
  for (const host of ALLOWED_HOSTS) {
    // Exact or dot-boundary subdomain. A bare endsWith would let a "notcell.com"
    // vector pretend to cover cell.com.
    assert.ok(
      accepted.some((u) => {
        const h = new URL(u).hostname.toLowerCase();
        return h === host || h.endsWith(`.${host}`);
      }),
      `no accept vector exercises ${host}`,
    );
  }
  for (const { host } of PATH_CONSTRAINED_HOSTS) {
    assert.ok(
      accepted.some((u) => new URL(u).hostname.toLowerCase() === host),
      `no accept vector exercises ${host}`,
    );
  }
});

// --- parity of the two copies -------------------------------------------------------

test('the two allowlist copies are textually identical', () => {
  // The Node file is a module and the extension file is a script, so the only
  // permitted difference is the `export ` keyword. Anything else is drift.
  // Both files are ES modules now, so `export ` is stripped from BOTH sides rather than
  // one: the extension's copy became a module so search-sources.js could import the tier
  // resolver instead of carrying a third copy of it.
  const node = parityRegion('src/bridge/allowed-hosts.js').replace(/^export /gm, '');
  const extension = parityRegion('extension/allowlist.js').replace(/^export /gm, '');
  assert.equal(node, extension, 'allowlist parity regions have drifted');
});

test('nothing outside the parity region can redefine the extension gate', () => {
  // The region test only sees the marked block, so a later push onto ALLOWED_HOSTS
  // or a second isAllowedUrl declaration elsewhere in the file would widen the real
  // grant invisibly. Assert the names are declared exactly once and never mutated
  // anywhere in the file. `export ` is now a permitted prefix on the declaration.
  const src = readFileSync(join(repoRoot, 'extension/allowlist.js'), 'utf8');
  for (const name of ['ALLOWED_HOSTS', 'PATH_CONSTRAINED_HOSTS']) {
    const decls = src.match(new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\b`, 'gm')) || [];
    assert.equal(decls.length, 1, `${name} must be declared exactly once`);
    const mutations =
      src.match(
        new RegExp(
          // Not preceded by a declarator, so the single legitimate `const NAME = [...]`
          // is not itself reported as a reassignment.
          `(?<!\\b(?:const|let|var)\\s)\\b${name}\\s*(?:\\.(?:push|pop|splice|unshift|fill|copyWithin|sort|reverse)\\b|\\[[^\\]]*\\]\\s*=[^=]|=[^=])`,
          'g',
        ),
      ) || [];
    assert.deepEqual(mutations, [], `${name} must never be mutated or reassigned`);
  }
  const fnDecls = src.match(
    /^\s*(?:export\s+)?(?:function\s+isAllowedUrl\b|(?:const|let|var)\s+isAllowedUrl\b)/gm,
  ) || [];
  assert.equal(fnDecls.length, 1, 'isAllowedUrl must be declared exactly once');
});

test('the extension copy is a real second implementation, not an alias', () => {
  assert.notEqual(ext.isAllowedUrl, isAllowedUrl);
  assert.notEqual(ext.ALLOWED_HOSTS, ALLOWED_HOSTS);
  assert.deepEqual(ext.ALLOWED_HOSTS, ALLOWED_HOSTS);
  assert.deepEqual(ext.PATH_CONSTRAINED_HOSTS, PATH_CONSTRAINED_HOSTS);
});

// --- shape of the grant itself ------------------------------------------------------

test('the allowlist is exactly the hosts we intend to grant', () => {
  assert.deepEqual(ALLOWED_HOSTS, [
    'ssrn.com',
    'cell.com',
    'data.mendeley.com',
    'sciencedirect.com',
    'nature.com',
    'link.springer.com',
    'onlinelibrary.wiley.com',
    'pubs.acs.org',
    'academic.oup.com',
    'silverchair.com',
  ]);
});

test('DigitalCommons is an explicit host list, never an open pattern', () => {
  assert.ok(PATH_CONSTRAINED_HOSTS.length > 0);
  for (const rule of PATH_CONSTRAINED_HOSTS) {
    assert.equal(typeof rule.host, 'string');
    assert.match(rule.host, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'hosts are literal, not patterns');
    assert.ok(Array.isArray(rule.paths) && rule.paths.length > 0, `${rule.host} needs paths`);
    for (const p of rule.paths) {
      assert.ok(
        p === '/cgi/viewcontent.cgi' || p === '/context/',
        `${rule.host}: ${p} is not a bepress content path`,
      );
    }
  }
});

test('no path-constrained host is also suffix-granted by ALLOWED_HOSTS', () => {
  // Otherwise the narrow rule would be dead code and the host would in fact hold
  // an any-path grant.
  for (const { host } of PATH_CONSTRAINED_HOSTS) {
    assert.ok(
      !ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)),
      `${host} is already suffix-granted, so its path constraint does nothing`,
    );
  }
});

// --- the registry may only use hosts the boundary already grants --------------------

test('every publisher registry host is covered by the allowlist', () => {
  const pathGranted = new Set(PATH_CONSTRAINED_HOSTS.map((r) => r.host));
  for (const host of publisherHosts()) {
    const covered =
      pathGranted.has(host) ||
      ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
    assert.ok(covered, `${host} is in the registry but not granted by allowed-hosts.js`);
  }
});

// Chrome refuses executeScript on any host absent from host_permissions, so an
// allowlist entry without a matching manifest grant is a source that silently
// never works. 38 DigitalCommons hosts were added to the allowlist in one commit
// and the manifest was not updated; this catches that class of drift.
test('every allowlisted host has a manifest host_permission', () => {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, 'extension/manifest.json'), 'utf8'),
  );
  const granted = manifest.host_permissions.join(' ');

  for (const host of ALLOWED_HOSTS) {
    assert.ok(granted.includes(host), `${host} is allowlisted but has no host_permission`);
  }
  for (const rule of PATH_CONSTRAINED_HOSTS) {
    assert.ok(
      granted.includes(rule.host),
      `${rule.host} is allowlisted but has no host_permission`,
    );
  }
});

test('every anonymous-tier host is granted in the manifest', () => {
  // The gap that shipped a broken source: medrxiv.org was in ANONYMOUS_HOSTS and emitted as
  // a pdfUrl for every medRxiv hit, but had no host_permissions entry -- so the worker was
  // not CORS-exempt for it and every such fetch failed with "Failed to fetch". The existing
  // manifest test iterated ALLOWED_HOSTS and PATH_CONSTRAINED_HOSTS only, so the whole
  // anonymous tier was unchecked.
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, 'extension/manifest.json'), 'utf8'),
  );
  const patterns = manifest.host_permissions || [];
  const granted = (host) => patterns.some((p) => {
    const m = /^(?:\*|https?):\/\/([^/]+)\//.exec(p);
    if (!m) return false;
    const pat = m[1];
    if (pat === host) return true;
    // Chrome allows `*` only as a leading label, matching the host and any subdomain.
    if (pat.startsWith('*.')) {
      const base = pat.slice(2);
      return host === base || host.endsWith(`.${base}`);
    }
    return false;
  });

  const src = readFileSync(join(repoRoot, 'extension/allowlist.js'), 'utf8');
  const block = /const ANONYMOUS_HOSTS = \[([\s\S]*?)\];/.exec(src);
  assert.ok(block, 'ANONYMOUS_HOSTS not found');
  // Line-wise, and comments stripped first: a quoted string picked out of the whole block
  // also matches the apostrophe in a comment ("the user's own browser"), which produced a
  // fake host name rather than a real finding.
  const hosts = block[1]
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .map((line) => /^\s*'([^']+)'\s*,?\s*$/.exec(line))
    .filter(Boolean)
    .map((m) => m[1]);
  assert.ok(hosts.length > 0);

  const ungranted = hosts.filter((h) => !granted(h));
  assert.deepEqual(
    ungranted, [],
    `anonymous hosts with no host_permissions entry: ${ungranted.join(', ')}`,
  );
});
