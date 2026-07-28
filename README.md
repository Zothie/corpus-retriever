# Corpus Retriever

A Chrome extension that saves an academic paper to your browser's Downloads folder.

Paste a DOI, an arXiv ID, a doi.org link, or a direct PDF link into the toolbar panel. The
extension works through the open-access indexes and then the publisher's own site, and hands
the PDF to Chrome's download manager.

It does **not** bypass paywalls. It fetches from inside your own browser session, so it can
retrieve papers you already have the right to read — nothing more.

## Why an extension

Publishers serve a JS challenge (Cloudflare, AWS WAF, F5) that cannot be satisfied from
outside a real browser: `cf_clearance` is bound to the TLS fingerprint, UA and IP that earned
it, and headless Chrome is re-challenged even holding a valid one. Running inside the user's
own Chrome is the only path to those PDFs.

## Layout

```
extension/     the extension itself — this is what Chrome loads
scripts/       build-store-package.mjs, which produces the Web Store zip
tests/         node --test
```

## Develop

Load `extension/` unpacked at `chrome://extensions` (Developer mode → Load unpacked).
`manifest.json` carries a `key`, so the extension ID is stable across reloads and the native
messaging host registration keeps working.

```bash
npm test      # unit tests
npm run check # syntax-check the worker and the popup
```

After changing anything, reload the extension at `chrome://extensions`.

## Build for the Chrome Web Store

```bash
npm run build   # -> dist-store/corpus-retriever-<version>.zip
```

The Store build is a **different artifact** from the development copy:

- `key` is removed, so the Store assigns its own extension ID
- mirror sources and their host permissions are stripped, and the build refuses to produce a
  zip if a single reference survives

Bump `"version"` in `extension/manifest.json` before every re-upload — the Store rejects a
re-upload at the same version.

## Sources

**Search:** SSRN, arXiv, PubMed, bioRxiv/medRxiv (Crossref resolves DOIs).

**Download:** a direct URL if given, then Unpaywall / OpenAlex / PubMed Central / CORE in
parallel, then SSRN, DigitalCommons, Mendeley Data, Cell, ScienceDirect, Nature, Springer,
Wiley, ACS and OUP in sequence.

Unpaywall and PubMed Central **require** a contact email and reject requests without one. Set
it once in the panel's Settings, or the entire open-access phase is skipped and every download
takes the slow path.

## Driving it from a desktop app

The extension also answers over Chrome's native messaging, so a local application can request
a paper instead of the user typing into the panel.

```
desktop app --unix socket--> src/bridge/paper-bridge-host.js --stdio--> extension
```

[Corpus Studio](https://github.com/Zothie/science-search-aggregator) uses this. Nothing about
the extension depends on it: with no host installed the channel is simply never connected and
the toolbar panel works normally.

## Repository layout

```
extension/     the extension itself — load THIS unpacked
src/publishers/  the publisher resolvers, in Node form; extension/publishers-bundle.js
                 is GENERATED from them by scripts/bundle-publishers.mjs
src/bridge/    the native-messaging host, and the allowlist it shares with the extension
scripts/       bundle-publishers, inline-search-sources, build-store-package
tests/         node --test
```

The extension ships **no dependencies** — it is plain MV3 JavaScript. `axios` and `xml2js` are
devDependencies used only by the Node-side resolvers and their tests.

See `CLAUDE.md` for the MV3 constraints that are not guessable from the code.
