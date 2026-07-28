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

**Download** runs as a three-phase ladder, and the order is load-bearing:

1. **Open access, in parallel** — a direct URL if you gave one, plus Unpaywall, OpenAlex,
   PubMed Central and CORE. Nothing here opens a tab or involves a human.
2. **Publishers, in sequence** — SSRN, DigitalCommons, Mendeley Data, Cell, ScienceDirect,
   Nature, Springer, Wiley, ACS, OUP. These may open a tab, and one may ask you to prove you
   are human.
3. **Mirrors, last** — LibGen, Anna's Archive, Sci-Hub. Last on purpose: an unsigned mirror
   copy must not displace the publisher's own file, and the `%PDF-` check is five bytes of
   sanity, not proof of integrity. The phase is time-boxed as a group so three slow sources
   cannot make a download look hung.

A source that fails with what looks like a global outage is parked for 30 minutes, so a dead
domain does not re-cost every later download.

Unpaywall and PubMed Central **require** a contact email and reject requests without one. Set
it once in the panel's Settings, or phase 1 is skipped entirely and every download takes the
slow path.

> **Mirrors are in this repository and in a development build, but they are stripped from the
> Chrome Web Store package** — `npm run build` removes the code, the hostnames and the host
> permissions, and refuses to produce a zip if a single reference survives. Store policy
> treats facilitating access to infringing copies as grounds for removal. `npm run
> build:mirrors` keeps them, for a build you load unpacked yourself.

## Driving it from a desktop app

The extension also answers over Chrome's native messaging, so a local application can request
a paper instead of the user typing into the panel.

```
desktop app --unix socket--> src/bridge/paper-bridge-host.js --stdio--> extension
```

[Corpus Studio](https://github.com/Zothie/corpus-studio) uses this. Nothing about the
extension depends on it: with no host installed the channel is simply never connected and the
toolbar panel works normally.

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

## Privacy

No analytics, no tracking, no accounts, and no server run by the developer. The identifier you
paste goes to the paper sources; the PDF goes to your Downloads folder.

Full policy: <https://zothie.github.io/corpus-studio/privacy.html>
