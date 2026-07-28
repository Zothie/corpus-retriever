# Corpus Retriever

**Paste a DOI. Get the PDF.**

A Chrome extension for downloading academic papers. Click the toolbar icon, paste the paper's
ID or link, and the PDF lands in your Downloads folder — named after the paper, not
`s41586-013-0123-4.pdf`.

---

## What you can paste

| | example |
|---|---|
| A DOI | `10.1038/nature12373` |
| A doi.org link | `https://doi.org/10.1038/nature12373` |
| An arXiv ID | `2301.00001` |
| A link to a PDF | `https://example.org/paper.pdf` |

If it does not recognise what you pasted, it says so straight away instead of searching for a
minute and failing.

## Setting it up

1. Install the extension.
2. Click the toolbar icon, open **Settings**, and enter your email address.
3. That's it.

**The email matters more than it looks.** Two of the big free-paper libraries (Unpaywall and
PubMed Central) refuse to answer requests that do not include a contact address — it is how
they prevent abuse. Without it, the extension has to skip them entirely and every download
becomes slower and more likely to fail. Your address goes only to those libraries. It is never
sent to us, and there is no "us" to send it to — no server, no account, no analytics.

Once entered, the Settings section hides itself. You only ever do this once.

## Using it

Paste and click **Download**.

- **Most papers take a few seconds.** Some take up to a minute, because the extension has to
  ask the publisher's website directly.
- **You can close the panel while it works.** The download keeps going.
- **A tab may open asking you to confirm you are human.** That is the publisher's check, not
  ours. Clear it and the download continues by itself.

When it works, you get the filename and where it came from. When it does not, you get a plain
reason and a short list of everywhere it looked:

```
Could not find a copy to download.

Where we looked
  Unpaywall — no free copy
  OpenAlex — no PDF there
  Springer — needs a subscription
  Wiley — no PDF there
```

That list is the point: it tells you whether the paper is behind a paywall, or simply not
online anywhere — two very different problems.

## What it does not do

**It does not get you past paywalls.** It fetches papers using your own browser session, the
same as if you clicked through the publisher's website yourself. If you cannot open a paper by
hand, this cannot open it either.

What it saves you is the hunting: checking four free archives, then the publisher, then
finding the actual PDF link on a page designed to hide it.

## Privacy

- No accounts, no analytics, no tracking.
- No server run by the developer — there isn't one.
- What you paste goes to the paper libraries and publishers. The PDF goes to your Downloads
  folder. Nothing goes anywhere else.

Full policy: <https://zothie.github.io/corpus-studio/privacy.html>

## Where papers come from

Free archives first, because they are fastest and always readable: **Unpaywall, OpenAlex,
PubMed Central, CORE**.

Then the publishers themselves: **SSRN, DigitalCommons, Mendeley Data, Cell, ScienceDirect,
Nature, Springer, Wiley, ACS, OUP**.

---

<br>

# For developers

Everything below this line is implementation detail. If you just want to download papers, you
are done.

## Why this is an extension and not a script

Publishers sit behind a JavaScript challenge (Cloudflare, AWS WAF, F5) that cannot be
satisfied from outside a real browser. A `cf_clearance` cookie is bound to the TLS
fingerprint, User-Agent and IP that earned it, and headless Chrome gets re-challenged even
when holding a valid one. Running inside the user's own browser is the only reliable path to
those PDFs.

## Install unpacked

`chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the
`extension/` directory (not the repository root — `src/`, `scripts/` and `tests/` must not
ship inside a loaded extension).

`manifest.json` carries a `key`, so the extension ID is stable across reloads and the native
messaging registration keeps working. After any change, reload from `chrome://extensions`.

## Repository layout

```
extension/          what Chrome loads
src/publishers/     the resolvers, in Node form; extension/publishers-bundle.js is GENERATED
                    from these by scripts/bundle-publishers.mjs
src/bridge/         the native-messaging host, and the allowlist both sides validate against
src/utils/          logger, per-source rate limiter, user-agent
scripts/            bundle-publishers, inline-search-sources, build-store-package
tests/              node --test
```

The extension itself ships **no dependencies** — it is plain MV3 JavaScript. `axios` and
`xml2js` are devDependencies of the Node-side resolvers and their tests only.

```bash
npm test        # 92 tests
npm run check   # syntax-check the worker and the popup
```

`extension/background.js` contains no `import` statements, by necessity: a static import
breaks service-worker registration and a dynamic one throws at runtime and kills the worker
silently. The sibling modules are inlined into it, so **editing a sibling alone changes
nothing at runtime** — re-run `scripts/inline-search-sources.mjs`.

See `CLAUDE.md` for the rest of the MV3 constraints, each of which has already cost a bug.

## The retrieval ladder

Three phases, and the order is load-bearing:

1. **Open access, in parallel** — a direct URL if supplied, plus Unpaywall, OpenAlex, PubMed
   Central, CORE. Nothing here opens a tab or involves a human.
2. **Publishers, in sequence** — may open a tab; may require the user to clear a challenge.
3. **Mirrors, last** — LibGen, Anna's Archive, Sci-Hub. Last on purpose: an unsigned mirror
   copy must not displace the publisher's own file, and the `%PDF-` check is five bytes of
   sanity, not proof of integrity. Time-boxed as a group so three slow sources cannot make a
   download look hung.

A source failing in a way that looks like a global outage is parked for 30 minutes, so a dead
domain does not re-cost every later download.

## Building for the Chrome Web Store

```bash
npm run build           # -> dist-store/corpus-retriever-<version>.zip
npm run build:mirrors   # keeps phase 3, for a build you load unpacked yourself
```

The Store build is a **different artifact** from the development copy:

- `key` is removed, so the Store assigns its own extension ID.
- **Phase 3 is stripped** — code, hostnames and host permissions. Store policy treats
  facilitating access to infringing copies as grounds for removal. Deleting
  `mirror-sources.js` is not sufficient, because its functions are inlined into
  `background.js`; both regions are fenced and cut, and the build greps the finished staging
  directory and refuses to produce a zip if one reference survives.

Bump `"version"` in `extension/manifest.json` before every re-upload — the Store rejects a
re-upload at the same version.

## Driving it from a desktop application

The extension also answers over Chrome's native messaging, so a local app can request a paper
instead of the user typing into the panel.

```
desktop app --unix socket--> src/bridge/paper-bridge-host.js --stdio--> extension
```

[Corpus Studio](https://github.com/Zothie/corpus-studio) uses this. Nothing about the
extension depends on it: with no host installed the channel is simply never connected, and the
toolbar panel works normally.
