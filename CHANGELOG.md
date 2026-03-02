# Changelog

## [Unreleased] — 2026-03-02

### Added

- VIP / trusted-partner matching is now live. Set `LOXI_TRUSTED_PARTNERS` to a comma-separated list of node IDs in the orchestrator `.env`; those nodes get Tier 1 priority in the scheduler. Previously the constant was hardcoded empty and the code path never fired.
- Rate limiting on `POST /logistics/submit-problem`: 20 requests per second per IP with a burst allowance of 5, powered by `governor 0.6`. Requests exceeding the limit receive HTTP 429 with a JSON error body. Read-only routes are unaffected.
- Parallel auction dispatch: the Logistics Architect now batches all partition auction messages into a single WebSocket flush rather than sending them sequentially, cutting time-to-first-bid for multi-partition jobs.
- Auction persistence via `sled`. In-flight auctions survive an orchestrator restart — on startup the node reloads all pending auctions from `data/loxi_auctions.db`, clears stale worker assignments, and re-queues the tasks. State is updated on every transition (created, assigned, completed/removed).
- OPFS matrix caching in the browser worker. Before computing a distance matrix, the worker derives a SHA-256 cache key from the stop list and origin, reads from the Origin Private File System on a hit, and writes back on a miss. Identical problems solved twice skip Valhalla entirely.
- OPFS quota eviction: after each cache write the worker checks storage utilisation; if usage exceeds 80% it deletes the oldest cache files until usage drops to 70%.
- Multi-city tile support in `scripts/download_tiles.sh`. Set `LOXI_CITIES` to a comma-separated list of Geofabrik region slugs (e.g. `south-america/argentina-latest,south-america/uruguay-latest`) and the script downloads all PBF files and builds a single Valhalla tile tree covering every region.
- Playwright E2E test harness at `tests/e2e/`. The smoke test opens two worker tabs, connects both to the grid, dispatches a 10-stop problem, waits for the matrix and VRP steps to complete, and asserts the solution is returned via the API. A new `.github/workflows/e2e.yml` workflow runs it on every pull request.
- Docker Compose setup (`compose.yml` + `Dockerfile.node`). Running `docker compose up --build` starts the orchestrator/API server and the worker-web Vite dev server with no manual Rust toolchain installation required.
- GitHub Actions workflow for publishing the SDK to npm. Pushing a `sdk-v*` tag triggers a build and `npm publish --access public` using an `NPM_TOKEN` repository secret.

### Changed

- SDK package renamed from `@loxi/worker-sdk` to `@loxi/worker-device`, aligning the package name with the exported `LoxiWorkerDevice` class. `publishConfig.access` is now set to `"public"` and the `files` field restricts the tarball to `dist/` only.

---

## [Unreleased] — 2026

### Added

- Ticket verification on the WebSocket data plane. The orchestrator now signs a short-lived RS256 JWT for every lease it issues. Workers must present this ticket when connecting to `/logistics/data`; connections without a valid ticket are rejected before any problem payload is sent.
- Live worker count endpoint (`GET /workers/count`) backed by an atomic counter that increments and decrements as nodes connect and disconnect. The worker UI polls this every five seconds and shows the count in the header.
- CSV and JSON stop upload in the worker UI. You can now load real-world stops from a CSV file (any column layout with `lat` and `lon` headers) or paste a JSON array directly into the text area — no need to generate random stops for a demo.
- Solution export. Once a mission completes, two download buttons appear in the header: **CSV** (one row per stop with route ID, coordinates, and sequence order) and **GeoJSON** (a FeatureCollection with LineString routes and Point features for each stop).
- Solution metrics panel in the Mission Architect section showing total route distance in kilometres, number of vehicles used, and unassigned stop count — computed as soon as the solution arrives.
- Time-window tooltips on map markers. Hovering a stop now shows its ID and delivery window in `HH:MM–HH:MM` format.
- `VITE_ARCHITECT_URL` environment variable for the worker UI, replacing the hardcoded `localhost:8080`. An `.env.example` file documents both configurable URLs.
- TTL eviction in the orchestrator watchdog. Completed auctions are now purged after one hour, preventing unbounded growth of the in-memory auction map during long-running sessions.

### Fixed

- Duplicate solution submissions no longer overwrite a completed auction. If a worker reconnects after a timeout and submits a result for an auction that already resolved, the duplicate is silently dropped.
- The Heavy (500-stop) problem generation button now shows a confirmation dialog explaining the hardware and time requirements before dispatching, preventing accidental load during demos.
- Task failure events now display a "will retry in ~120s" message in the telemetry log, making the orchestrator's recovery behaviour visible to the operator.
- Removed a debug `console.log` that ran on every render and logged internal map state to the browser console.

### Removed

- Removed unused crates from the workspace: `loxi-compute`, `loxi-net-core`, `loxi-net-wasm`, and `loxi-asset-manager`. The workspace is leaner and the remaining crates have no unused dependencies.

---

## [0.1.0] — 2026 — POC

### Added

- Grid Orchestrator with auction-based task dispatch, three-tier affinity matching (artifact cache → hardware score → queue), and a binary-heap scheduler.
- Task timeout watchdog: workers silent for more than 120 seconds are evicted and their tasks automatically re-queued.
- RS256 JWT ticket signing for lease assignments.
- Logistics Architect implementing a three-tier problem pipeline: direct VRP for small problems, geographic partitioning for medium ones, and a full matrix → partitioner → VRP pipeline for large ones.
- WASM cartridges for the VRP solver (vrp-pragmatic), road-distance matrix engine (Valhalla), and H3 geographic partitioner.
- React worker UI with live telemetry, Leaflet map with Valhalla polyline rendering, and hardware preset selection.
- `LoxiWorkerDevice` TypeScript SDK for embedding a worker in any web application.
- `Signal` message type for WebRTC peer-to-peer signaling between workers.
- Domain ID parametrization — the `logistics` domain ID is now a runtime parameter rather than a hardcoded string, making the orchestrator reusable across domains.
- Full POC bootability: `rustls-tls` for TLS without a system OpenSSL dependency, fixed RSA key parsing from `.env` files, and `scripts/run_node.sh` for one-command startup.
