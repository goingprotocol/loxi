# Cloudflare Pages (demo deploy)

This repo can deploy the browser demo as a static site via **Cloudflare Pages**.

## Cloudflare Pages settings

- **Production branch**: `main`
- **Build command**: `./scripts/build_pages.sh`
- **Build output directory**: `dist`

## What gets deployed

- `dist/demo/` – the UI and JS worker demo
- `dist/examples/` – sample problem JSON files
- `dist/wasm/` – the WASM bundle built via `wasm-pack`

The demo code dynamically loads the WASM module from:

- local dev: `../crates/loxi-wasm/pkg/loxi_wasm.js`
- Pages deploy: `../wasm/loxi_wasm.js`

## Local preview

Build:

```bash
./scripts/build_pages.sh
```

Serve:

```bash
python3 -m http.server 8000 --directory dist
```

Then open `http://localhost:8000/` (it redirects to `/demo/`).

