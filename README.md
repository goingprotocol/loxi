# Loxi Protocol - Unified Node Architecture

Loxi is an interoperable logistics protocol providing a modular, browser-agnostic engine for complex Routing (VRP), Geographic Partitioning (H3), and Street-Level Matrix calculation (Valhalla).

## Architecture: "Brain & Body"

Loxi follows a modular separation of concerns:

- **The Brain (Algorithm Cartridges)**: Pure logic for VRP, Partitioning, and Routing. These are compiled to WASM to run anywhere (Browsers, Mobile, Servers).
- **The Body (The Node)**: The Loxi node (Orchestrator + Logistics crate) handles networking (WebSockets), I/O, and runtime management.

## Project Structure

The project uses a **Cartridge Architecture** under `protocol/crates/logistics/`:

- **loxi-logistics**: The Body. Main node logic, artifact server, and orchestration client.
- **loxi-matrix**: Cartridge. Rust-C++ Bridge for Valhalla.
- **loxi-vrp**: Cartridge. VRP solver based on `vrp-rs`.
- **loxi-partitioner**: Cartridge. H3-based geographic clustering.
- **loxi-worker-pkg**: Templates for independent WASM workers.

## Prerequisites

- **Rust (Nightly)**: `rustup toolchain install nightly`
- **wasm-pack**: `cargo install wasm-pack`
- **Node.js 18+** (for UI and simulation)

## Build & Run Flow

### 1. Build WASM Artifacts
This script compiles the Rust crates, injects worker templates, and pulls the pre-compiled Valhalla engine into a unified `public/` distribution folder.
```bash
bash scripts/build_artifacts.sh
```

### 2. Run the Unified Node
Run the Loxi node serving the built artifacts and the Valhalla tiles.
```bash
./scripts/run_node.sh
```
*Note: This command starts the Orchestrator (3005) and the Logistics Node (8080).*

## Core Components

### Valhalla Engine (loxi-matrix)
The Valhalla C++ engine is pre-compiled to WASM/JS and located in `protocol/crates/logistics/loxi-matrix/engine/src/`. 
- **binding.cpp**: The C++ bridge exposing Valhalla to JS/Rust.
- **Dockerfile**: Used for the C++ toolchain environment.
- **Official Binaries**: `valhalla_engine.wasm/js` are tracked in the repo to allow development without requiring a complex C++ emscripten setup.

### Distribution Folder
The folder `protocol/crates/logistics/loxi-logistics/public/` is the **Single Source of Truth** for artifacts. It is served by the node and consumed by workers.

## Tiles Data
Routing tiles must be placed in:
`protocol/crates/logistics/loxi-logistics/data/valhalla_tiles/`
(Include the `0`, `1`, `2` directories and `valhalla.json`).

## Maintenance & Cleanup
- Use `scripts/build_artifacts.sh` to refresh WASM packages.
- `.loxi_data.json` is automatically generated for persistence (can be deleted to reset state).
- Intermediate C++ build files (`.o`, `.a`) should not be tracked.
