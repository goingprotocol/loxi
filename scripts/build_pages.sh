#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
WASM_PKG_DIR="${ROOT_DIR}/crates/loxi-wasm/pkg"

echo "=== Loxi Cloudflare Pages build ==="
echo "Root: ${ROOT_DIR}"
echo "Dist: ${DIST_DIR}"

rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}/demo" "${DIST_DIR}/examples" "${DIST_DIR}/wasm"

echo "Copying demo/ -> dist/demo/"
cp -R "${ROOT_DIR}/demo/." "${DIST_DIR}/demo/"

echo "Copying examples/ -> dist/examples/"
cp -R "${ROOT_DIR}/examples/." "${DIST_DIR}/examples/"

echo "Building WASM (best effort)..."
if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "WARN: wasm-pack not found."
  echo "      Attempting to install wasm-pack via cargo (recommended for Cloudflare Pages)..."
  if ! command -v cargo >/dev/null 2>&1; then
    echo "ERROR: cargo not found, cannot install wasm-pack."
    exit 1
  fi

  # Ensure the wasm32 target is available (rustup is present on most CI images).
  if command -v rustup >/dev/null 2>&1; then
    rustup target add wasm32-unknown-unknown || true
  fi

  # --locked for reproducibility and to avoid selecting newer dependency trees unexpectedly.
  cargo install wasm-pack --locked
fi

pushd "${ROOT_DIR}/crates/loxi-wasm" >/dev/null
wasm-pack build --target web --release
popd >/dev/null

if [[ ! -f "${WASM_PKG_DIR}/loxi_wasm.js" || ! -f "${WASM_PKG_DIR}/loxi_wasm_bg.wasm" ]]; then
  echo "ERROR: Missing wasm-pack output in ${WASM_PKG_DIR}."
  echo "       Install wasm-pack and re-run:"
  echo "         cargo install wasm-pack"
  echo "         ./scripts/build_pages.sh"
  exit 1
fi

echo "Copying WASM bundle -> dist/wasm/"
cp "${WASM_PKG_DIR}/loxi_wasm_bg.wasm" "${DIST_DIR}/wasm/"
cp "${WASM_PKG_DIR}/loxi_wasm.js" "${DIST_DIR}/wasm/"
cp "${WASM_PKG_DIR}/loxi_wasm.d.ts" "${DIST_DIR}/wasm/" 2>/dev/null || true
cp "${WASM_PKG_DIR}/loxi_wasm_bg.wasm.d.ts" "${DIST_DIR}/wasm/" 2>/dev/null || true

echo "Writing dist/index.html (redirect to /demo/)"
cat > "${DIST_DIR}/index.html" <<'HTML'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0; url=./demo/" />
    <title>Loxi Demo</title>
  </head>
  <body>
    <p>Redirecting to <a href="./demo/">demo</a>…</p>
  </body>
</html>
HTML

echo "✅ Pages build complete: ${DIST_DIR}"

