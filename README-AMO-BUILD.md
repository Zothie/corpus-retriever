# Build instructions for AMO reviewers

Corpus Retriever — Firefox package
`corpus-retriever-<version>-firefox-mirrors.xpi`

---

## TL;DR

```sh
./scripts/build-release.sh --mirrors
```

Output (the Firefox one is the submitted package):

```
dist-store/corpus-retriever-<version>-firefox-mirrors.xpi
dist-store/corpus-retriever-<version>-mirrors.zip
dist-store/corpus-retriever-<version>-SOURCE.zip
```

---

## 1. Operating system and build environment

| | |
|---|---|
| OS used for the submitted build | Ubuntu 24.04.4 LTS (x86_64) |
| Also works on | any Linux, macOS. Windows via WSL (the build script is `/bin/sh`) |
| Node.js | **20.20.2** (any 20.x or 22.x works) |
| npm | **10.8.2** (ships with Node 20) |
| Other tools | `zip` (from `zip`, preinstalled on Ubuntu); `git` only if cloning |
| Network | needed for `npm ci` only |

### Installing Node

Ubuntu/Debian:

```sh
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

macOS: `brew install node@20`
Any OS: https://nodejs.org/en/download — the LTS installer.

Verify:

```sh
node -v   # v20.x or v22.x
npm -v    # 10.x
zip -v    # any
```

---

## 2. Step-by-step build

The one-command script `./scripts/build-release.sh` runs exactly these steps in order.
They are order-dependent — steps 3 and 4 generate files the next step reads.

```sh
# 1. dependencies (all are BUILD-time devDependencies; none ship in the package)
npm ci

# 2. vendor the qpdf WebAssembly build (third party, see §4)
npm run vendor:qpdf

# 3. generate the publisher bundle
node scripts/bundle-publishers.mjs

# 4. inline shared modules into the background script (see §4)
node scripts/inline-search-sources.mjs

# 5. produce the .xpi
node scripts/build-store-package.mjs --firefox --with-mirrors
```

Result: `dist-store/corpus-retriever-<version>-firefox-mirrors.xpi`

To verify the build reproduces the submission:

```sh
unzip -p dist-store/corpus-retriever-<version>-firefox-mirrors.xpi manifest.json
# the submitted version, background.scripts = ["vendor/qpdf.js","background.js"],
# gecko.id = {5b4e01ed-e5d0-41d0-b57d-409f183d0620}
```

---

## 3. Running the tests (optional)

```sh
npm test     # 140 tests, no network required
```

---

## 4. Generated and third-party files — full disclosure

Three files in the package are not authored by hand. Nothing is minified, obfuscated or
transpiled by us; all first-party code ships exactly as written and is readable.

### `vendor/qpdf.js` + `vendor/qpdf.wasm` — THIRD PARTY

An Emscripten (C++ → WebAssembly) build of [qpdf](https://github.com/qpdf/qpdf),
**Apache-2.0**, taken from the npm package
[`@neslinesli93/qpdf-wasm@0.3.0`](https://www.npmjs.com/package/@neslinesli93/qpdf-wasm).

Vendored **byte-for-byte unmodified** by `scripts/vendor-qpdf.mjs`, which copies the two
files out of `node_modules/`. It is not compiled by this build. The `.js` glue arrives
minified from upstream — it is an open-source third-party library, which AMO's policy
exempts from the "cannot be minified" rule.

Purpose: losslessly recompress downloaded PDFs before saving, to reduce file size. It is
optional by construction — if the module fails to load, downloads proceed unslimmed.

### `extension/background.js` — partly generated (CONCATENATION ONLY)

`scripts/inline-search-sources.mjs` appends the contents of six first-party modules into a
marked region of `background.js`:

```
extension/devlog.js
extension/search-sources.js
extension/oa-sources.js
extension/availability.js
extension/slim-pdf.js
extension/mirror-sources.js
```

This is a **plain textual concatenation**. The only transformation is removing the
`export ` keyword and one `import` line — no minification, no renaming, no transpilation.
The output is byte-comparable to the inputs and every one of those files is present in this
source tree, unmodified and readable.

**Why it is necessary:** an MV3 background script cannot use ES modules. A static `import`
breaks registration outright, and a dynamic `import()` throws when a message arrives, killing
the background context silently. The modules therefore have to be textually present. They are
kept as separate files because they are separately unit-tested (see `tests/`).

### `extension/publishers-bundle.js` — generated

Produced by `scripts/bundle-publishers.mjs` from the per-publisher resolver definitions in
this repository. Concatenation only; readable output.

---

## 5. What the build script does to the manifest

`scripts/build-store-package.mjs --firefox` transforms `extension/manifest.json`
(the Chrome/development manifest) into the Firefox one — see `scripts/firefox-manifest.mjs`:

- replaces `background.service_worker` with `background.scripts`
  (Firefox MV3 has no service worker; the background is an event page)
- prepends `vendor/qpdf.js` to `background.scripts`
  (an event page has no `importScripts`, so the glue is loaded as a script entry instead)
- removes the Chrome-only `key` field
- adds `browser_specific_settings.gecko` — id, `strict_min_version` 140.0, and
  `data_collection_permissions: { required: ["none"] }`

`strict_min_version` is 140.0 because two things require it: host permissions are only
granted at install time from Firefox 127, and `data_collection_permissions` is only
understood from 140.

---

## 6. Source repository

https://github.com/corpus-hub/corpus-retriever

The submitted archive is the same tree.
