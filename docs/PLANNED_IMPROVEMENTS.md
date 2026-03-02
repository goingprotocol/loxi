# Planned Improvements

This document lists non-critical enhancements identified after the pilot-ready hardening
sprint. None of these block the current demo; they represent the next development phase.

---

## 1. Matrix Caching Across Sessions (OPFS)

**Status:** Not implemented
**Context:** The matrix engine recomputes travel-time matrices from scratch on every problem
submission. Because matrix calculation is the most compute-heavy step, persisting the output
to the browser's Origin Private File System (OPFS) between sessions would eliminate the
redundant work for problems that share stop locations.

**Acceptance criteria:** A worker that reconnects after a browser restart and receives a
problem whose matrix hash matches a cached entry skips the matrix computation phase entirely.

---

## 2. Job Persistence / Resume After Server Restart

**Status:** Not implemented
**Context:** If the orchestrator or architect process is restarted mid-problem, all in-flight
auctions are lost. Workers that reconnect have no way to re-join an existing problem.

**Acceptance criteria:** Active auctions and their payloads are written to a local SQLite file
(or equivalent durable store). On restart, the orchestrator replays pending auctions and
workers can reclaim tasks they were assigned.

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

**Status:** Single region only (tiles generated for one bounding box)
**Context:** The Valhalla routing engine is pre-seeded with tiles for a single geographic
region. Problems that span multiple cities require tile sets for each region to be available
at routing time.

**Acceptance criteria:** The tile download script accepts a list of bounding boxes.
The architect selects the correct tile set based on the problem's geographic centroid.

---

## 5. OPFS Quota Eviction Policy

**Status:** No eviction — cache grows unbounded
**Context:** Workers store WASM artifacts and matrix caches in OPFS. Browsers enforce per-origin
storage quotas; without eviction, a long-running worker will eventually hit the limit and fail
silently.

**Acceptance criteria:** A least-recently-used eviction policy keeps total OPFS usage below a
configurable threshold (default: 200 MB). Eviction runs automatically when the worker connects
and when a new artifact is cached.

---

## 6. Rate Limiting on REST Endpoints

**Status:** No rate limiting
**Context:** The `/logistics/submit-problem` endpoint and the artifact-serving routes are
currently unprotected. A misbehaving or malicious client can flood the architect with
requests.

**Acceptance criteria:** The Warp server applies a per-IP token-bucket rate limiter
(configurable via environment variables). Requests that exceed the limit receive HTTP 429.
The limit is generous enough to never affect legitimate demo traffic.

---

## 7. npm Publish for LoxiWorkerDevice SDK

**Status:** Local package only (`sdk/web/`)
**Context:** The SDK is currently consumed by the demo worker-web app via a local path import.
Publishing to npm would allow external projects to integrate Loxi workers without copying
source.

**Acceptance criteria:** `@loxi/worker-device` is published to the npm registry under a
scoped package. The demo app's `package.json` switches to the published version. A CI job
publishes a new version on every tagged release.

---

## 8. Docker Compose for One-Command Dev Setup

**Status:** Manual multi-step boot process
**Context:** Starting the stack currently requires running four separate commands in the right
order (tile download, WASM build, Rust server, Vite dev server). New contributors and CI
pipelines need a simpler path.

**Acceptance criteria:** `docker compose up` starts the orchestrator, architect, and
worker-web dev server with hot-reload. A `compose.yml` at the repo root documents all
required environment variables and mounts the local source tree for live editing.

---

## 9. E2E Test Harness (Headless Worker Simulation)

**Status:** No automated end-to-end tests
**Context:** The only verification today is a manual click-through of the demo. A headless
test harness would run the full pipeline — submit problem → auction → worker solve → solution
relay — without a real browser tab.

**Acceptance criteria:** A Node.js test script spins up a mock LoxiWorkerDevice (no UI),
connects to the orchestrator, claims a test task, runs the WASM solver in Node's Worker
thread, and asserts the solution is relayed back to the architect within 90 seconds.
The test is wired into CI and runs on every pull request.

---

## 10. VIP / Trusted Partner Matching

**Status:** `TRUSTED_PARTNERS` array is hardcoded empty
**Context:** The scheduler's Tier 1 affinity matching includes a VIP fast-path for partners
that have registered a known public key. The array is never populated, so the feature is
inactive.

**Acceptance criteria:** `TRUSTED_PARTNERS` is loaded from an environment variable (JSON
array of public-key fingerprints). Workers that present a JWT signed by a trusted key are
promoted to the front of the dispatch queue regardless of affinity score.

---

## 11. True Parallel Multi-Partition Dispatch

**Status:** Sequential auction loop
**Context:** When the architect decomposes a large problem into N sectors, it currently fires
one `RequestLease` at a time, waiting for each auction to settle before starting the next.
For a 5-partition problem with 3 idle workers, this leaves workers idle instead of working in
parallel.

**Acceptance criteria:** The architect fires all N `RequestLease` messages concurrently using
`tokio::join!` (or equivalent). Workers bid on whichever auctions they are eligible for.
Total wall-clock time for a multi-partition problem scales with `ceil(N / worker_count)`
rather than `N`.
