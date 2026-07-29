# Corpus Retriever

<img width="1280" height="800" alt="screenshot-1-idle" src="https://github.com/user-attachments/assets/32ad9f8d-1203-4004-ba9f-c0581e84bf53" />

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
  Sci-Hub — no mirror served it
  Anna's Archive — not there
  Unpaywall — no free copy
  Springer — needs a subscription
```

That list is the point: it tells you whether the paper is behind a paywall, or simply not
online anywhere — two very different problems.

## What it saves you

The hunting. Checking the free archives, then the publisher, then finding the real PDF link on
a page designed to hide it — and, when a paper is paywalled, going to the shadow libraries by
hand.

It tries all of that in one click, in the order most likely to produce the PDF without
interrupting you.

**On paywalled papers it does reach Sci-Hub, LibGen and Anna's Archive.** Those host papers
without the publisher's permission, and downloading from them is copyright infringement in
most countries. It is a real capability, not a footnote: for a paywalled article, that
fallback is usually what produces the PDF. Use it knowing that.

## Privacy

- No accounts, no analytics, no tracking.
- No server run by the developer — there isn't one.
- What you paste goes to the paper libraries and publishers. The PDF goes to your Downloads
  folder. Nothing goes anywhere else.

Full policy: <https://zothie.github.io/corpus-studio/privacy.html>

## Where papers come from

It tries sources in order and stops at the first real PDF.

**1. Shadow libraries** — Sci-Hub · Anna's Archive · LibGen

**2. Free archives** — always readable, tried in parallel:
Unpaywall · OpenAlex · PubMed Central · CORE

**3. Publishers** — using your own browser session:
SSRN · DigitalCommons · Mendeley Data · Cell · ScienceDirect · Nature · Springer · Wiley ·
ACS · OUP

Publishers come last because they are the only source that can interrupt you: that is the
step where a tab opens and asks you to prove you are human. Everything ahead of it runs
silently, so most downloads finish without one.

**Search** (used by the desktop integration, not the popup): SSRN · arXiv · PubMed ·
bioRxiv/medRxiv, with Crossref resolving DOIs to titles.

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
npm test        # 97 tests
npm run check   # syntax-check the worker and the popup
```

`extension/background.js` contains no `import` statements, by necessity: a static import
breaks service-worker registration and a dynamic one throws at runtime and kills the worker
silently. The sibling modules are inlined into it, so **editing a sibling alone changes
nothing at runtime** — re-run `scripts/inline-search-sources.mjs`.

See `CLAUDE.md` for the rest of the MV3 constraints, each of which has already cost a bug.

## The retrieval ladder

Three phases, and the order is load-bearing:

1. **Mirrors, first** — Sci-Hub, Anna's Archive, LibGen. They hold the paywalled majority and
   answer without a challenge and without a human, so trying them first is what keeps most
   downloads from needing a tab at all. Time-boxed as a group so three slow sources cannot
   make a download look hung.
2. **Open access, in parallel** — a direct URL if supplied, plus Unpaywall, OpenAlex, PubMed
   Central, CORE. Nothing here opens a tab or involves a human either.
3. **Publishers, in sequence** — last, because this is the only phase that can open a tab and
   park on a human clearing a challenge. It should run only once everything free has missed.

A source failing in a way that looks like a global outage is parked for 30 minutes, so a dead
domain does not re-cost every later download.

The order is asserted in `tests/quick-download.test.mjs` against the shipped worker source.
It was documented as load-bearing and checked nowhere, which meant it could be reordered with
the whole suite still green.

## Packaging a zip

```bash
npm run build:mirrors   # everything, exactly as this repo runs it
npm run build           # same, minus the mirrors
```

Both write `dist-store/corpus-retriever-<version>.zip` and drop the manifest `key`, so the
packaged copy gets a fresh extension ID rather than colliding with an unpacked one.

`npm run build` additionally removes phase 3 — code, hostnames and host permissions.
Deleting `mirror-sources.js` is **not** sufficient, because its functions are inlined into
`background.js`; both regions are fenced with `---8<---` markers and cut, and the script greps
the finished staging directory and refuses to produce a zip if a single reference survives.
That check exists because an earlier version silently shipped twelve of them.

Bump `"version"` in `extension/manifest.json` between packages — anywhere you upload will
reject a re-upload at the same version.

## Driving it from a desktop application

The extension also answers over Chrome's native messaging, so a local app can request a paper
instead of the user typing into the panel.

```
desktop app --unix socket--> src/bridge/corpus-retriever-host.js --stdio--> extension
```

[Corpus Studio](https://github.com/Zothie/corpus-studio) uses this. Nothing about the
extension depends on it: with no host installed the channel is simply never connected, and the
toolbar panel works normally.
