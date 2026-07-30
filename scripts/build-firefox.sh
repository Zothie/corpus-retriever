#!/bin/sh
# Build the Firefox (AMO) package from a clean checkout, in one command.
#
#   ./scripts/build-firefox.sh
#
# Produces: dist-store/corpus-retriever-<version>-firefox-mirrors.xpi
#
# Every step is here rather than in a list a human has to follow in order, because the steps
# are ORDER-DEPENDENT and two of them generate files the next one reads: the publisher bundle
# feeds the inliner, and the inliner feeds the packager. Running them out of order silently
# produces a package built from stale generated code.

set -e

cd "$(dirname "$0")/.."

echo "==> node $(node -v), npm $(npm -v)"

# 1. Dependencies. All are devDependencies used at BUILD time; none ship in the package.
echo "==> npm ci"
npm ci

# 2. Vendor the qpdf WebAssembly build.
#
# Copies extension/vendor/qpdf.{js,wasm} out of node_modules/@neslinesli93/qpdf-wasm. This is
# THIRD-PARTY, Apache-2.0, and is vendored byte-for-byte unmodified -- it is not compiled
# here. It arrives minified from upstream; that is the one machine-generated artifact in the
# package, and it is an open-source third-party library.
echo "==> vendor qpdf"
npm run vendor:qpdf

# 3. Generate the publisher bundle from the per-publisher resolvers.
echo "==> bundle publishers"
node scripts/bundle-publishers.mjs

# 4. Inline the shared modules into the background script.
#
# NOT minification and NOT transpilation -- a plain concatenation, preserving the original
# source verbatim (only `export ` keywords and one import line are removed). An MV3 background
# script cannot use `import`: a static import breaks registration outright and a dynamic
# import() throws at message time, so the modules have to be textually present. Every inlined
# file is in this source tree, unmodified and readable.
echo "==> inline modules into background.js"
node scripts/inline-search-sources.mjs

# 5. Package.
echo "==> package"
node scripts/build-store-package.mjs --firefox --with-mirrors

echo
echo "Done. The .xpi is in dist-store/"
ls -1 dist-store/*.xpi
