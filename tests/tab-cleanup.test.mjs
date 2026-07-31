// The extension must not leave tabs in the user's daily Chrome.
//
// Three leak sites were reported live -- pdf.sciencedirectassets.com (ScienceDirect),
// watermark02.silverchair.com (OUP/ACS) and data.mendeley.com -- and all three are the
// same bug: withClearedTab only closed its tab when body() returned ok, and the paths that
// reach those hosts (navigate-at-PDF, then a fetch of the settled url) fail routinely.
// A tab per attempt accumulated.
//
// background.js is a service worker with no exports, so it is evaluated here in a
// function scope with a fake `chrome`, and withClearedTab is pulled out of that scope.
// The alternative -- asserting on source text -- would pass on code that never runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Evaluate background.js against a fake chrome and hand back withClearedTab plus the
 * fake's tab bookkeeping.
 *
 * pageIsCleared is answered by the fake executeScript rather than really run, so the
 * challenge wait resolves on the first poll and no test sits through AUTO_CLEAR_MS.
 */
async function loadBackground() {
  // background.js carries the allowlist INLINE rather than importing it: an ES-module
  // import of ./allowlist.js failed to register in Chrome even though the export was
  // present and Node resolved every name, which left the worker dead and the bridge socket
  // missing. So there is no import to strip: the source is used as-is, and only the browser
  // globals are injected. A real dynamic import would need `chrome` at module scope, which
  // is exactly what the fake below provides and only within this call.
  const src = readFileSync(join(repoRoot, 'extension/background.js'), 'utf8');
  assert.doesNotMatch(
    src, /^import\s/m,
    'background.js must not import: the worker has to load without a module graph',
  );

  const created = [];
  const removed = [];
  const activated = [];
  let nextId = 1;
  const onCreatedListeners = new Set();
  const onUpdatedListeners = new Set();
  // What pageIsCleared reports. A string now, not a boolean: focus depends on WHY a page is
  // not cleared, so the tests have to be able to say "challenged" vs "merely loading".
  const state = { clearReason: 'cleared', scriptingThrows: false };

  const chrome = {
    tabs: {
      async create({ url }) {
        const tab = { id: nextId++, url, status: 'complete' };
        created.push(tab);
        for (const l of onCreatedListeners) l(tab);
        return tab;
      },
      async get(id) {
        const t = created.find((c) => c.id === id);
        if (!t || removed.includes(id)) throw new Error('No tab with id');
        return t;
      },
      async query() {
        return created.filter((t) => !removed.includes(t.id));
      },
      async update(id, props) {
        const t = await chrome.tabs.get(id);
        if (typeof props.url === 'string') {
          t.url = props.url;
          for (const l of onUpdatedListeners) l(t.id, { url: t.url }, t);
        }
        if (props.active === true) activated.push(id);
        return t;
      },
      async reload(id) {
        await chrome.tabs.get(id);
      },
      async remove(id) {
        if (removed.includes(id)) throw new Error('No tab with id');
        removed.push(id);
      },
      onCreated: {
        addListener: (l) => onCreatedListeners.add(l),
        removeListener: (l) => onCreatedListeners.delete(l),
        // Exposed so a test can fire a tab the fake did not create -- a tab of the USER'S
        // own. Without this the mid-download test read `__listeners || []`, which was
        // undefined, so it iterated an empty array: no tab was ever announced and the
        // assertion "9001 was not closed" passed against a tab that never existed.
        __listeners: onCreatedListeners,
      },
      onUpdated: {
        addListener: (l) => onUpdatedListeners.add(l),
        removeListener: (l) => onUpdatedListeners.delete(l),
      },
      /** Simulate a target="_blank" handoff: a tab the extension did not create itself. */
      spawnChild(openerTabId, url) {
        const tab = { id: nextId++, url, status: 'complete', openerTabId };
        created.push(tab);
        for (const l of onCreatedListeners) l(tab);
        return tab;
      },
      /**
       * A handoff with NO openerTabId: rel="noopener", or Chrome opening the PDF viewer or
       * the download in a new window. This is the ScienceDirect leak the opener chain
       * cannot see.
       */
      spawnOrphan(url) {
        const tab = { id: nextId++, url, status: 'complete' };
        created.push(tab);
        for (const l of onCreatedListeners) l(tab);
        return tab;
      },
      /**
       * As above, but Chrome commits the url only after creation -- so onCreated sees an
       * empty url and only the later update or the final sweep can match it.
       */
      spawnOrphanLate(url) {
        const tab = { id: nextId++, url: '', status: 'loading' };
        created.push(tab);
        for (const l of onCreatedListeners) l(tab);
        tab.url = url;
        tab.status = 'complete';
        return tab;
      },
      /** A tab of the user's own. No openerTabId, and a url this call never asked for. */
      spawnUserTab(url) {
        const tab = { id: nextId++, url, status: 'complete' };
        created.push(tab);
        for (const l of onCreatedListeners) l(tab);
        return tab;
      },
    },
    scripting: {
      async executeScript({ func }) {
        if (state.scriptingThrows) throw new Error('Cannot access contents of the page');
        // Only the clear poll is answered with the reason string; every other injected
        // function (probe, fetch, link harvest) gets a benign truthy result.
        if (func && func.name === 'pageIsCleared') return [{ result: state.clearReason }];
        return [{ result: true }];
      },
    },
    alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
    runtime: {
      // A port that never disconnects. Throwing here instead would send the module-scope
      // connect() into its reconnect backoff, leaving live timers in every loaded copy.
      connectNative: () => ({
        postMessage() {},
        onMessage: { addListener() {} },
        onDisconnect: { addListener() {} },
      }),
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
      // The popup's channel. Registered at top level because MV3 requires a synchronous
      // listener, so every harness that evaluates the worker has to carry it.
      onMessage: { addListener() {} },
    },
  };

  // Only the browser globals are injected. The allowlist is INLINE in background.js now,
  // so passing those bindings as parameters too would collide with the file's own
  // declarations ("Identifier 'ALLOWED_HOSTS' has already been declared").
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'chrome', 'console',
    `${src}\nreturn { withClearedTab, waitForTabCleared, pageIsCleared };`,
  );
  const mod = factory(chrome, { warn() {}, log() {} });
  return { ...mod, chrome, created, removed, activated, state };
}

test('a successful fetch closes its tab', async () => {
  const { withClearedTab, removed } = await loadBackground();
  const r = await withClearedTab('https://www.sciencedirect.com/science/article/pii/S123', async () => ({ ok: true }));
  assert.equal(r.ok, true);
  assert.deepEqual(removed, [1]);
});

test('a FAILED fetch closes its tab too', async () => {
  // The reported bug. ScienceDirect and OUP fail routinely (paywall, 403 after the
  // navigate-at-PDF), and every one of those used to leave a tab behind.
  const { withClearedTab, removed } = await loadBackground();
  const r = await withClearedTab('https://www.sciencedirect.com/science/article/pii/S123', async () => ({
    ok: false,
    error: 'not a pdf (starts with "<!DOC")',
  }));
  assert.equal(r.ok, false);
  assert.deepEqual(removed, [1], 'a failed attempt must not leave a tab in the user session');
});

test('a throw inside the body still closes the tab', async () => {
  const { withClearedTab, removed } = await loadBackground();
  const r = await withClearedTab('https://academic.oup.com/article/1', async () => {
    throw new Error('driving the tab blew up');
  });
  assert.equal(r.ok, false);
  assert.deepEqual(removed, [1]);
});

test('a tab the extension opened as a target=_blank handoff is closed', async () => {
  // watermark02.silverchair.com (OUP/ACS) and pdf.sciencedirectassets.com are reached this
  // way. The spawned tab is outside the tracked tabId, so it needs the opener chain.
  const { withClearedTab, chrome, removed } = await loadBackground();
  await withClearedTab('https://academic.oup.com/article/1', async (tabId) => {
    chrome.tabs.spawnChild(tabId, 'https://watermark02.silverchair.com/x.pdf');
    return { ok: false, error: 'http 403' };
  });
  assert.deepEqual(removed.sort(), [1, 2], 'the handoff tab must be closed as well');
});

test('a grandchild tab is adopted through the opener chain', async () => {
  const { withClearedTab, chrome, removed } = await loadBackground();
  await withClearedTab('https://www.sciencedirect.com/science/article/pii/S123', async (tabId) => {
    const child = chrome.tabs.spawnChild(tabId, 'https://pdf.sciencedirectassets.com/a');
    chrome.tabs.spawnChild(child.id, 'https://pdf.sciencedirectassets.com/b');
    return { ok: true };
  });
  assert.deepEqual(removed.sort(), [1, 2, 3]);
});

test("a tab of the user's own is NEVER closed", async () => {
  // The hard requirement. Closing a user's tab is far worse than leaking one, so adoption
  // is by opener chain only -- never by url match, which would hit a tab the user opened
  // on the same publisher while the fetch was running.
  const { withClearedTab, chrome, removed } = await loadBackground();
  await withClearedTab('https://www.sciencedirect.com/science/article/pii/S123', async () => {
    chrome.tabs.spawnUserTab('https://www.sciencedirect.com/science/article/pii/S123');
    chrome.tabs.spawnUserTab('https://pdf.sciencedirectassets.com/somebody-elses');
    return { ok: true };
  });
  assert.deepEqual(removed, [1], 'only the extension-created tab may be removed');
});

test('a handoff tab with NO openerTabId is closed when its url is one we asked for', async () => {
  // The reported ScienceDirect leak. Chrome does not set openerTabId for a rel="noopener"
  // link, for the internal PDF viewer, or for a handoff it opens in a NEW WINDOW, so the
  // opener chain never fired and pdf.sciencedirectassets.com tabs accumulated.
  const { withClearedTab, chrome, removed } = await loadBackground();
  const pdf = 'https://pdf.sciencedirectassets.com/presigned/x.pdf';
  await withClearedTab('https://www.sciencedirect.com/science/article/pii/S123', async (tabId, deadline, origin, requestUrl) => {
    requestUrl(pdf);
    chrome.tabs.spawnOrphan(pdf);
    return { ok: false, error: 'http 403' };
  });
  assert.deepEqual(removed.sort(), [1, 2], 'an opener-less handoff to a url we requested must be closed');
});

test('a handoff whose url is committed after creation is still closed', async () => {
  // onCreated fires with an empty url, so only the onUpdated listener or the final sweep
  // can match it. Both exist for this.
  const { withClearedTab, chrome, removed } = await loadBackground();
  const pdf = 'https://watermark02.silverchair.com/late.pdf';
  await withClearedTab('https://academic.oup.com/article/1', async (tabId, deadline, origin, requestUrl) => {
    requestUrl(pdf);
    chrome.tabs.spawnOrphanLate(pdf);
    return { ok: true };
  });
  assert.deepEqual(removed.sort(), [1, 2]);
});

test('the final sweep never adopts a tab that predates the call', async () => {
  // The sweep is the loosest of the three mechanisms, so it is the one that must be proven
  // safe: a user tab already sitting on the very url we are about to request stays open.
  const { withClearedTab, chrome, removed } = await loadBackground();
  const pdf = 'https://pdf.sciencedirectassets.com/presigned/x.pdf';
  chrome.tabs.spawnUserTab(pdf);
  await withClearedTab('https://www.sciencedirect.com/science/article/pii/S123', async (tabId, deadline, origin, requestUrl) => {
    requestUrl(pdf);
    return { ok: true };
  });
  assert.deepEqual(removed, [2], "the user's pre-existing tab on the same url must survive");
});

test('a pre-existing user tab that NAVIGATES to a requested url is never adopted', async () => {
  // chrome.tabs.onUpdated is global: it fires for every tab in every window, including ones
  // that predate the call. Without the `seen` filter, a user browsing to the same PDF while
  // a fetch happened to be running would have their tab closed under them.
  const { withClearedTab, chrome, removed } = await loadBackground();
  const pdf = 'https://pdf.sciencedirectassets.com/presigned/x.pdf';
  const mine = chrome.tabs.spawnUserTab('https://example.invalid/');
  await withClearedTab('https://www.sciencedirect.com/science/article/pii/S123', async (tabId, deadline, origin, requestUrl) => {
    requestUrl(pdf);
    await chrome.tabs.update(mine.id, { url: pdf });
    return { ok: true };
  });
  assert.deepEqual(removed, [2], "a user's own tab navigating to the same url must survive");
});

test('the landing url is not a provenance signal', async () => {
  // The user plausibly has the article page open themselves, so the landing url is
  // deliberately never registered for url-matching. Only navigation TARGETS are.
  const { withClearedTab, chrome, removed } = await loadBackground();
  const landing = 'https://www.cell.com/cell/fulltext/S0092';
  await withClearedTab(landing, async () => {
    chrome.tabs.spawnUserTab(landing);
    return { ok: true };
  });
  assert.deepEqual(removed, [1], 'a user tab on the landing url must not be adopted');
});

test('the onCreated listener does not outlive the call', async () => {
  // A service worker handles many requests. A listener left registered per request would
  // let a later call adopt tabs on behalf of a finished one, and leak listeners besides.
  const { withClearedTab, chrome, removed } = await loadBackground();
  let openerId = null;
  await withClearedTab('https://academic.oup.com/article/1', async (tabId) => {
    openerId = tabId;
    return { ok: true };
  });
  chrome.tabs.spawnChild(openerId, 'https://watermark02.silverchair.com/late.pdf');
  assert.deepEqual(removed, [1], 'a tab created after the call returned must not be touched');
});

test('a page that clears immediately is never brought to the foreground', async () => {
  // The common case. Stealing focus on every download would be intolerable.
  const { withClearedTab, activated } = await loadBackground();
  await withClearedTab('https://papers.ssrn.com/abstract=1', async () => ({ ok: true }));
  assert.deepEqual(activated, [], 'a silent clear must not surface the tab');
});

test('an UNCLEARED page is surfaced even when no challenge marker matched', async () => {
  // The cell.com report: focus used to depend on whether a publisher's challenge widget
  // happened to be recognised, so an undetected challenge left the tab hidden and waiting
  // for a human who never saw it. The bounded fallback makes focus a function of elapsed
  // time instead, so every publisher that stalls behaves identically.
  const { waitForTabCleared, chrome, state, activated } = await loadBackground();
  state.clearReason = 'loading';
  const tab = await chrome.tabs.create({ url: 'https://www.cell.com/x' });
  const r = await waitForTabCleared(tab.id, Date.now() + 1500, null, { autoClearMs: 100, surfaceMs: 300 });
  assert.equal(r.cleared, false);
  assert.equal(r.surfaced, true, 'a stalled page must be surfaced regardless of markers');
  assert.ok(activated.includes(tab.id));
});

test('a detected challenge is surfaced after the auto-clear grace period', async () => {
  const { waitForTabCleared, chrome, state } = await loadBackground();
  state.clearReason = 'challenge:cf';
  const tab = await chrome.tabs.create({ url: 'https://papers.ssrn.com/abstract=1' });
  const r = await waitForTabCleared(tab.id, Date.now() + 1500, null, { autoClearMs: 100, surfaceMs: 60000 });
  assert.equal(r.surfaced, true, 'a marker means a human is wanted, so do not wait for the fallback');
  assert.match(r.reason, /^challenge:/);
});

test('an uncleared wait always terminates, so the tab can be cleaned up', async () => {
  // The leak's root cause: the second challenge wait used an Infinity deadline, so the
  // promise could never settle and withClearedTab's finally never ran.
  const { waitForTabCleared, chrome, state } = await loadBackground();
  state.clearReason = 'challenge:cf';
  const tab = await chrome.tabs.create({ url: 'https://papers.ssrn.com/abstract=1' });
  const r = await waitForTabCleared(tab.id, Date.now() + 500, null, { autoClearMs: 0, surfaceMs: 0 });
  assert.equal(r.cleared, false, 'the wait must resolve rather than hang forever');
});

test('a non-scriptable document (Chrome PDF viewer) ends the wait instead of polling out', async () => {
  // Navigating at a PDF gives the tab a document no extension may script. Without this the
  // poll would be refused every 750 ms for the whole hour budget.
  const { waitForTabCleared, chrome, state } = await loadBackground();
  state.scriptingThrows = true;
  const tab = await chrome.tabs.create({ url: 'https://pdf.sciencedirectassets.com/x.pdf' });
  const started = Date.now();
  const r = await waitForTabCleared(tab.id, Date.now() + 60000, null, { autoClearMs: 0, surfaceMs: 60000 });
  assert.equal(r.nonScriptable, true);
  assert.ok(Date.now() - started < 20000, 'must give up on the DOCUMENT_CONFIRM_MS timescale');
});

test("pageIsCleared detects ScienceDirect's interactive Cloudflare variant", async () => {
  // Measured 2026-07-28 on a 403 article response: title is plain "ScienceDirect" and every
  // pre-existing marker is false, so the page read as cleared and the fetch pulled the
  // interstitial HTML. Three template-owned handles catch it.
  // pageIsCleared is serialised into the page by chrome.scripting and reads the real
  // document/window, so it cannot be invoked here. Its SOURCE is the artefact that ships,
  // so assert on the marker set directly -- that is exactly what Chrome injects.
  const { pageIsCleared } = await loadBackground();
  const src = pageIsCleared.toString();
  assert.match(src, /_cf_chl_opt/, 'the interactive-variant window flag must be checked');
  assert.match(src, /#challenge-error-text/);
  assert.match(src, /#captcha-box/);
  assert.match(src, /are you a robot/i);
  // Strip comments first: the rationale for REJECTING this marker names it, and asserting
  // against the raw source would fail on the explanation rather than on the code.
  const code = src.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(
    code, /challenge-platform/,
    'cdn-cgi/challenge-platform survives clearing under Bot Management and would wedge the wait',
  );
  assert.match(src, /readyState !== 'loading'/, 'one hung subresource must not read as challenged');
});

test('a bounded caller closes its tab when the page never clears', async () => {
  // Scholar's case, and a leak found by measurement rather than by reading. It originally
  // wrapped withClearedTab in a Promise.race against a 30s timeout -- but Promise.race does
  // not CANCEL the loser, so the call returned an error at 30s while withClearedTab kept
  // waiting out its full one-hour budget, and the tab it holds is closed only by its own
  // finally. Observed with a fake chrome: created 1, removed 0.
  //
  // The fix is to bound the WAIT rather than race around it, which is what the budgetMs
  // parameter is for. This asserts the tab is gone once the bounded call returns.
  const { withClearedTab, removed, created, state } = await loadBackground();
  state.clearReason = 'challenge:cloudflare';
  const out = await withClearedTab('https://scholar.google.com/scholar', async () => 'unused', 300);
  assert.equal(out.ok, false, 'a page that never clears must report failure, not results');
  assert.equal(created.length, 1);
  assert.deepEqual(removed, created.map((t) => t.id), 'the tab must be closed on this path too');
});

test('one call never closes another concurrent call\'s tab', async () => {
  // Measured before the fix: created 2, removed 3 -- call A adopted and closed call B's
  // live tab mid-fetch, and removed one tab twice. Adoption by url is what finds a handoff
  // tab when Chrome gives it no openerTabId, but two calls for the SAME url each register
  // it, and sources race in save_to_vault so that is ordinary rather than exotic.
  const { withClearedTab, created, removed } = await loadBackground();
  const url = 'https://www.sciencedirect.com/science/article/pii/S1/pdfft';

  let bClosedEarly = false;
  const a = withClearedTab(url, async (_t, _d, _o, requestUrl) => {
    requestUrl?.(url);
    await new Promise((r) => setTimeout(r, 30));
    return 'a';
  });
  const b = withClearedTab(url, async (tabId, _d, _o, requestUrl) => {
    requestUrl?.(url);
    await new Promise((r) => setTimeout(r, 200));
    bClosedEarly = removed.includes(tabId);
    return 'b';
  });
  await Promise.all([a, b]);

  assert.equal(bClosedEarly, false, "the second call's tab must still be open while it works");
  assert.equal(created.length, 2);
  assert.equal(removed.length, 2, 'each tab closed exactly once');
});

test('an ADOPTED handoff tab is protected from a concurrent call too', async () => {
  // Only the CREATED tab used to reach tabsOwnedByAnyCall, so a handoff tab adopted by
  // opener chain -- the target=_blank case the adoption logic exists for -- stayed invisible
  // to every other call. A second call for the same url could then re-adopt it and close it
  // mid-fetch. Registering on adoption, not just on creation, is what closes that.
  const { withClearedTab, chrome, removed } = await loadBackground();
  const url = 'https://www.sciencedirect.com/science/article/pii/S9/pdfft';

  let handoffId = null;
  let handoffClosedEarly = false;
  const a = withClearedTab(url, async (tabId) => {
    const child = chrome.tabs.spawnChild(tabId, 'https://pdf.sciencedirectassets.com/x.pdf');
    handoffId = child.id;
    await new Promise((r) => setTimeout(r, 200));
    handoffClosedEarly = removed.includes(handoffId);
    return 'a';
  });
  // Starts after the handoff exists, and asks for the very url that handoff is showing.
  await new Promise((r) => setTimeout(r, 40));
  const b = withClearedTab(url, async (_t, _d, _o, requestUrl) => {
    requestUrl?.('https://pdf.sciencedirectassets.com/x.pdf');
    await new Promise((r) => setTimeout(r, 30));
    return 'b';
  });
  await Promise.all([a, b]);

  assert.equal(handoffClosedEarly, false,
    "a concurrent call must not close the first call's adopted handoff tab");
  assert.equal(removed.filter((id) => id === handoffId).length, 1,
    'the handoff tab must be closed exactly once, by its owner');
});

test('a tab the user opens BY HAND mid-download is never closed', async () => {
  // The user reported this risk and it was real. Measured before the fix: opening the same
  // paper by hand while a download ran got that tab adopted by url and closed in the
  // finally. `seen` did not save it -- a tab the user opens during the call is also
  // "created while this call ran", so seen is not provenance.
  //
  // What separates the two is TIME. A rel=noopener handoff carries no openerTabId, so it
  // cannot be told from a user tab by provenance alone, but Chrome performs it within
  // milliseconds of our navigation while a human takes seconds.
  const { withClearedTab, chrome, created, removed } = await loadBackground();
  const url = 'https://libgen.bz/get.php?md5=x';

  await withClearedTab(url, async (_tabId, _d, _o, requestUrl) => {
    requestUrl?.(url);
    // Long enough to be a human rather than a handoff -- which means PAST
    // HANDOFF_WINDOW_MS (1500ms), not merely "a little later". This slept 60ms and called
    // itself human-length, which is inside the handoff window: had the fake ever announced
    // the tab, the call would have adopted and closed it. The delay has to clear the actual
    // threshold or the test asserts the opposite of its own title.
    await new Promise((r) => setTimeout(r, 1700));
    const byHand = { id: 9001, url, status: 'complete' };
    const listeners = chrome.tabs.onCreated.__listeners;
    assert.ok(listeners && listeners.size > 0,
      'the fake must actually announce the tab, or this test asserts nothing');
    for (const l of listeners) l(byHand);
    return 'done';
  }, 5000);

  assert.ok(!removed.includes(9001), "a tab the user opened must never be closed");
  assert.deepEqual(removed, created.map((t) => t.id), 'only the extension\'s own tab closes');
});
