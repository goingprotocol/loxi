# Planned Improvements

This document lists non-critical enhancements identified after the pilot-ready hardening
sprint. None of these block the current demo; they represent the next development phase.

---

## 1. Matrix Caching Across Sessions (OPFS)

**Status:** ✅ Implemented
**Context:** The matrix engine recomputes travel-time matrices from scratch on every problem
submission. Because matrix calculation is the most compute-heavy step, persisting the output
to the browser's Origin Private File System (OPFS) between sessions would eliminate the
redundant work for problems that share stop locations.

**Implementation:** The matrix worker computes a SHA-256 cache key from the serialised stop
list and origin point using `crypto.subtle.digest`. On a cache hit the Valhalla computation
is skipped entirely and the cached result is posted directly. Results are written back to
OPFS after each solve. An eviction policy clears the oldest cached files when OPFS usage
exceeds 80 % of the browser-assigned quota.

**Acceptance criteria:** A worker that reconnects after a browser restart and receives a
problem whose matrix hash matches a cached entry skips the matrix computation phase entirely.

---

## 2. Job Persistence / Resume After Server Restart

**Status:** ✅ Implemented
**Context:** If the orchestrator or architect process is restarted mid-problem, all in-flight
auctions are lost. Workers that reconnect have no way to re-join an existing problem.

**Implementation:** In-flight auctions are persisted to a local [sled](https://docs.rs/sled)
embedded database (`data/loxi_auctions.db`) on every state transition. On startup the
orchestrator calls `load_all()`, re-inserts pending auctions into memory, clears stale
worker assignments, and re-queues them so workers can reclaim tasks normally. Completed
auctions are removed from the database immediately. The `SharedStore` is threaded through
all handlers via `Arc`.

**Acceptance criteria:** Active auctions and their payloads are written to a local durable
store. On restart, the orchestrator replays pending auctions and workers can reclaim tasks
they were assigned.

---

## 3. WebRTC P2P Payload Transfer

**Status:** Stub only — `send_and_receive()` returns an error
**Context:** Currently all data flows through the orchestrator relay (WebSocket). For large
payloads (e.g. dense distance matrices for 200+ stops), routing through the relay adds
latency and puts unnecessary load on the server.

**Acceptance criteria:** After winning an auction, the worker establishes a direct WebRTC
data-channel to the architect using the orchestrator's Signal relay for the SDP/ICE handshake.
Payload transfer bypasses the orchestrator entirely. Fallback to relay if WebRTC negotiation
fails within 5 seconds.

---

## 4. Multi-City Tile Support

**Status:** ✅ Implemented
**Context:** The Valhalla routing engine is pre-seeded with tiles for a single geographic
region. Problems that span multiple cities require tile sets for each region to be available
at routing time.

**Implementation:** `scripts/download_tiles.sh` reads a `LOXI_CITIES` environment variable
(comma-separated Geofabrik region slugs). All PBFs are downloaded in sequence and passed to
`valhalla_build_tiles` in a single invocation so Valhalla builds a unified multi-region tile
set. Defaults to `south-america/argentina-latest` when the variable is unset.

**Acceptance criteria:** The tile download script accepts a list of regions and builds a
single tile set that covers all of them.

---

## 5. OPFS Quota Eviction Policy

**Status:** ✅ Implemented (delivered together with item #1)
**Context:** Workers store WASM artifacts and matrix caches in OPFS. Browsers enforce per-origin
storage quotas; without eviction, a long-running worker will eventually hit the limit and fail
silently.

**Implementation:** After each matrix result is written to OPFS, `navigator.storage.estimate()`
is called. If `usage / quota > 0.80`, cached `.json` files are sorted by `lastModified` and
deleted oldest-first until usage drops below 70 %.

**Acceptance criteria:** OPFS usage stays bounded. Eviction runs automatically after each
cache write.

---

## 6. Rate Limiting on REST Endpoints

**Status:** ✅ Implemented
**Context:** The `/logistics/submit-problem` endpoint and the artifact-serving routes are
currently unprotected. A misbehaving or malicious client can flood the architect with
requests.

**Implementation:** A `governor::DefaultKeyedRateLimiter<IpAddr>` (20 req/s sustained,
burst of 5) is created at server startup and shared via `Arc`. A Warp `and_then` filter
extracts the remote IP and calls `.check_key(&ip)`, returning HTTP 429 on `NotUntil`. The
limiter is applied only to `POST /logistics/submit-problem`; read-only and WebSocket routes
are unaffected.

**Acceptance criteria:** Requests that exceed the limit receive HTTP 429. The limit does
not affect legitimate demo traffic.

---

## 7. npm Publish for LoxiWorkerDevice SDK

**Status:** ✅ Implemented
**Context:** The SDK is currently consumed by the demo worker-web app via a local path import.
Publishing to npm would allow external projects to integrate Loxi workers without copying
source.

**Implementation:** `sdk/web/package.json` was renamed to `@loxi/worker-device` (matching
the `LoxiWorkerDevice` class), `"publishConfig": {"access":"public"}` added, and
`"files": ["dist"]` set so the tarball contains only built output. A new GitHub Actions
workflow (`.github/workflows/publish-sdk.yml`) triggers on `sdk-v*` tag pushes: it runs
`npm ci → npm run build → npm publish --access public` using an `NPM_TOKEN` repository
secret.

**Acceptance criteria:** `@loxi/worker-device` can be published to the npm registry. A CI
job handles releases on every tagged push.

---

## 8. Docker Compose for One-Command Dev Setup

**Status:** ✅ Implemented
**Context:** Starting the stack currently requires running four separate commands in the right
order (tile download, WASM build, Rust server, Vite dev server). New contributors and CI
pipelines need a simpler path.

**Implementation:** `compose.yml` at the repo root defines two services: `node` (built via
`Dockerfile.node`, exposes ports 3005 and 8080, reads keys from `env_file`, mounts a named
volume for sled persistence) and `worker-web` (Node 20 Alpine, mounts the source tree, runs
`npm ci && npm run dev -- --host`). The `node` service has a health check; `worker-web`
uses `depends_on: node: condition: service_healthy`. `Dockerfile.node` is a multi-stage
build: `rust:1.77` compiles the release binary; `debian:bookworm-slim` is the runtime layer.

**Acceptance criteria:** `docker compose up --build` starts the full stack. `docker compose up`
on subsequent runs reuses cached layers.

---

## 9. E2E Test Harness (Headless Worker Simulation)

**Status:** ✅ Implemented
**Context:** The only verification today is a manual click-through of the demo. A headless
test harness would run the full pipeline — submit problem → auction → worker solve → solution
relay — without a real browser tab.

**Implementation:** `tests/e2e/smoke.spec.ts` is a Playwright TypeScript test that opens two
headless Chromium tabs, connects both as workers, generates a 10-stop problem, dispatches it,
and polls the API until `status: "completed"`. Playwright is configured via
`playwright.config.ts` (300 s timeout, `--no-sandbox`, SharedArrayBuffer enabled). A GitHub
Actions workflow (`.github/workflows/e2e.yml`) runs the test on every pull request: it builds
the Rust binary, starts both server processes, waits for health checks, runs the test, and
uploads the Playwright HTML report as an artifact on failure.

**Acceptance criteria:** The test exercises the full pipeline end-to-end and is wired into CI
on every pull request.

---

## 10. VIP / Trusted Partner Matching

**Status:** ✅ Implemented
**Context:** The scheduler's Tier 1 affinity matching includes a VIP fast-path for partners
that have registered a known public key. The array was hardcoded empty, so the feature was
inactive.

**Implementation:** The hardcoded `const TRUSTED_PARTNERS: &[&str] = &[]` was replaced with
a `std::sync::OnceLock<Vec<String>>` initialised lazily from the `LOXI_TRUSTED_PARTNERS`
environment variable (comma-separated node IDs). Set `LOXI_TRUSTED_PARTNERS=node-abc,node-xyz`
in the orchestrator `.env` to activate Tier 1 scheduling for those partners.

**Acceptance criteria:** `TRUSTED_PARTNERS` is loaded from the environment. Workers owned
by a trusted partner are promoted to the front of the dispatch queue.

---

## 11. True Parallel Multi-Partition Dispatch

**Status:** ✅ Implemented
**Context:** When the architect decomposes a large problem into N sectors, it currently fires
one `RequestLease` at a time, waiting for each auction to settle before starting the next.
For a 5-partition problem with 3 idle workers, this leaves workers idle instead of working in
parallel.

**Implementation:** The dispatch loop in `architect/mod.rs` was changed from sequential
`write.send()` calls to a batch `write.feed()` per message followed by a single
`write.flush()`. All N `RequestLease` messages are now enqueued into the WebSocket send
buffer in one pass and flushed atomically, so workers receive and bid on them concurrently
rather than sequentially.

**Acceptance criteria:** All N `RequestLease` messages are dispatched in a single flush.
Workers bid in parallel rather than sequentially.
