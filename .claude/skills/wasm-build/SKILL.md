---
name: wasm-build
description: Build one or all WASM crates for the Loxi project using wasm-pack. Use when the user wants to rebuild browser artifacts (VRP solver, matrix engine, asset manager, AI engine, partitioner).
argument-hint: "[vrp|matrix|asset-manager|ai|partitioner|all]"
allowed-tools: Bash
---

# WASM Build

Build Loxi WASM crates with wasm-pack. Target: `$ARGUMENTS` (default: all)

## Crate locations and output paths

| Target | Crate path | Output dir |
|--------|-----------|------------|
| vrp | `protocol/crates/logistics/loxi-vrp` | `apps/worker-web/public/assets/pkg/vrp` |
| matrix | `protocol/crates/logistics/loxi-matrix` | `apps/worker-web/public/assets/pkg/matrix` |
| asset-manager | `protocol/crates/net/loxi-asset-manager` | `apps/worker-web/public/assets/pkg/asset_manager` |
| ai | `protocol/crates/ai/loxi-ai` | `apps/worker-web/public/assets/pkg/ai` |
| partitioner | `protocol/crates/logistics/loxi-partitioner` | `apps/worker-web/public/assets/pkg/partitioner` |

## Build command template
```bash
wasm-pack build <crate-path> --target web --out-dir <absolute-output-dir> --release
```

Always use absolute paths for `--out-dir`.

## Steps

1. Check that `wasm-pack` is installed: `wasm-pack --version`
2. For each target in `$ARGUMENTS` (or all if empty), run the build command
3. Verify the `.wasm` file exists in the output dir after each build
4. Report size of the `.wasm` file

## Output format
For each crate:
- ✅ Built `<name>.wasm` (X MB) or ❌ FAILED with error snippet
- Total build time

If a build fails, show the last 20 lines of cargo output.

## Notes
- Requires `wasm-pack` and the `wasm32-unknown-unknown` target: `rustup target add wasm32-unknown-unknown`
- The `loxi-asset-manager` crate requires `crate-type = ["cdylib", "rlib"]` in its Cargo.toml (already set)
- For `loxi-matrix`, the Valhalla WASM engine at `engine/src/valhalla_engine.wasm` must exist
