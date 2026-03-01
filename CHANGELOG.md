# Changelog

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
