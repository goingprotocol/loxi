# Loxi Protocol

**Open-source distributed Vehicle Routing Protocol.**
Browser tabs become compute workers that bid on, solve, and return routing problems — no installation required on the worker side.

```
Client submits problem
        │
        ▼
 Logistics Architect        ← partitions problem by size
        │  RequestLease
        ▼
 Grid Orchestrator          ← dispatch: matches tasks to workers by affinity + hardware score
        │  LeaseAssignment
        ▼
 Browser Workers            ← WASM solvers (VRP, Matrix, Partitioner)
        │  SubmitSolution
        ▼
 Architect aggregates       ← merges partial solutions
        │  NotifyOwner
        ▼
 Client gets routes
```

Workers are ordinary browser tabs running the [worker UI](apps/worker-web). Each tab registers with the orchestrator, bids on tasks matching its hardware, runs a WASM artifact, and submits the result back. Zero installation. No token. No daemon.

---

## How it works

A problem submitted to the Architect is automatically stratified by size:

| Stops | Strategy |
|-------|----------|
| ≤ 12  | Single VRP worker, direct solve |
| ≤ 100 | Partitioner worker → N VRP workers in parallel |
| 100+  | Matrix worker → Partitioner → N VRP workers |

Workers are matched by affinity (cached WASM artifact) first, then by hardware score (RAM + threads + GPU). Partition tasks are dispatched as a batch — all `RequestLease` messages are flushed to the orchestrator in a single write, so workers bid in parallel rather than sequentially. If a worker goes silent for more than 120 seconds the task is automatically re-queued. Duplicate solution submissions are silently deduplicated.

---

## Quickstart

### Option A — Docker (recommended for new contributors)

```bash
# 1. Copy the env template and fill in your RSA keys (see step 1 below if you need to generate them)
cp protocol/crates/loxi-orchestrator/.env.example protocol/crates/loxi-orchestrator/.env

# 2. Download routing tiles (Buenos Aires by default)
bash scripts/download_tiles.sh

# 3. Start everything
docker compose up --build
```

Open `http://localhost:5173` in two or more browser tabs, connect, and dispatch.

**Multi-city tiles:** set `LOXI_CITIES` to a comma-separated list of [Geofabrik](https://download.geofabrik.de/) region slugs before running the tile script:

```bash
LOXI_CITIES="south-america/argentina-latest,south-america/uruguay-latest" bash scripts/download_tiles.sh
```

---

### Option B — manual

#### Prerequisites

```bash
rustup toolchain install nightly
rustup target add wasm32-unknown-unknown
cargo install wasm-pack      # if not already installed
node --version               # 18+
```

#### 1. Set up the orchestrator keys

Generate a dev RSA keypair and drop it into the orchestrator's `.env`:

```bash
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem
cp protocol/crates/loxi-orchestrator/.env.example \
   protocol/crates/loxi-orchestrator/.env
# paste the single-line key values into .env as instructed in the example file
```

#### 2. Get routing tiles

Pre-built Buenos Aires tiles (recommended):
```bash
bash scripts/download_tiles.sh
```

For additional cities set `LOXI_CITIES` (comma-separated Geofabrik slugs) before running:
```bash
LOXI_CITIES="south-america/argentina-latest,europe/germany-latest" bash scripts/download_tiles.sh
```

Or generate from OSM data yourself (requires Docker, ~10 min):
```bash
bash protocol/crates/logistics/loxi-logistics/scripts/generate_tiles.sh
```

#### 3. Build WASM artifacts

Compiles VRP solver, Matrix engine, and Partitioner to WASM and packages them for serving:
```bash
bash scripts/build_artifacts.sh
```

#### 4. Start the node

Starts the Grid Orchestrator on port 3005 and the Logistics node (API + artifact server) on port 8080:
```bash
bash scripts/run_node.sh
```

#### 5. Open worker tabs

```bash
cd apps/worker-web
cp .env.example .env      # defaults to localhost:3005 / :8080
npm install
npm run dev
```

Open `http://localhost:5173` in **2 or 3 browser tabs**. In each tab, pick a hardware preset (TITAN / DESKTOP / MOBILE) and click **Connect**.

#### 6. Dispatch a problem

In any tab, click **Generate** (30–60 stops, Buenos Aires), then **Dispatch**. You can also upload your own stops as a CSV file (`lat`, `lon`, optional `id` columns) or paste a JSON array directly.

Watch the logs: `TASK_BROADCAST → TASK_ASSIGNED → TASK_COMPLETED`. Routes render on the map when all workers report back. Once a solution appears you can export it as CSV or GeoJSON from the header buttons.

---

## Configuration reference

Key environment variables for the orchestrator (set in `protocol/crates/loxi-orchestrator/.env`):

| Variable | Default | Purpose |
|---|---|---|
| `RSA_PRIVATE_KEY` | — | RS256 private key for JWT ticket signing (required) |
| `RSA_PUBLIC_KEY` | — | Matching public key (required) |
| `LOXI_TRUSTED_PARTNERS` | *(empty)* | Comma-separated node IDs that receive Tier 1 VIP scheduling |

Key environment variables for tile downloads:

| Variable | Default | Purpose |
|---|---|---|
| `LOXI_CITIES` | `south-america/argentina-latest` | Comma-separated Geofabrik region slugs to include in the tile build |

---

## Project layout

```
protocol/
├── crates/
│   ├── loxi-core/              # Shared message types and protocol definitions
│   ├── loxi-orchestrator/      # Grid scheduler, auction engine, JWT ticket signing, sled persistence
│   ├── loxi-cli/               # `loxi node` binary — wires orchestrator + logistics server
│   ├── loxi-architect-sdk/     # Shared Architect client primitives
│   ├── loxi-wasm-sdk/          # WASM utility helpers
│   ├── loxi-types/             # Serialization types shared across crates
│   └── logistics/
│       ├── loxi-logistics/     # Architect logic, REST/WebSocket API, rate limiting
│       ├── loxi-vrp/           # VRP solver (vrp-pragmatic)
│       ├── loxi-matrix/        # Valhalla WASM bridge for road-distance matrices
│       ├── loxi-partitioner/   # H3 geographic partitioner
│       └── loxi-worker-pkg/    # Worker entry-point templates
sdk/
└── web/                        # TypeScript SDK (@loxi/worker-device)
apps/
└── worker-web/                 # React worker UI (Vite)
tests/
└── e2e/                        # Playwright end-to-end smoke test
scripts/
├── build_artifacts.sh          # Build all WASM packages
├── download_tiles.sh           # Fetch / generate routing tiles (supports LOXI_CITIES)
└── run_node.sh                 # Start orchestrator + logistics node
compose.yml                     # Docker Compose — one-command dev stack
Dockerfile.node                 # Multi-stage image for the Rust node
```

---

## Simulation scripts (no browser needed)

Test the orchestrator flow without opening any browser:

```bash
node scripts/simulate_full_flow.js        # full matrix → VRP pipeline
node scripts/simulate_auction_flow.js     # auction lifecycle only
node scripts/simulate_tiered_scheduler.js # multi-tier worker matching
node scripts/simulate_unified_flow.js     # unified dispatch simulation
```

---

## Architecture notes

**Ticket-based auth.** The orchestrator signs a short-lived RS256 JWT when it assigns a lease to a worker. The worker must present this ticket when connecting to the data plane (`/logistics/data`). Connections that arrive without a valid ticket are rejected before any payload is sent.

**Scheduling.** Workers register hardware capabilities; the scheduler matches tasks to the best available worker using a three-tier priority match: VIP partners (node IDs listed in `LOXI_TRUSTED_PARTNERS`) get the top-scoring owned worker; then workers with the required WASM artifact already cached (affinity hit); then the highest hardware-score worker available. A binary heap ensures the best available worker is always dispatched first.

**Fault tolerance.** Worker disconnect triggers immediate task re-queue via the recovery procedure in `handle_connection`. A 30-second watchdog independently evicts any worker silent for more than 120 seconds and re-schedules its task. Completed auctions are evicted from memory after one hour.

**Auction persistence.** In-flight auctions are written to a local [sled](https://docs.rs/sled) database at `data/loxi_auctions.db` on every state transition. If the orchestrator process crashes or is restarted, it reloads all pending auctions on startup, clears stale worker assignments, and re-queues the tasks. Workers that reconnect claim them normally.

**Rate limiting.** `POST /logistics/submit-problem` is protected by a per-IP token-bucket limiter (20 requests/second sustained, burst of 5) via the [`governor`](https://docs.rs/governor) crate. Excess requests receive HTTP 429. Read-only and WebSocket routes are unaffected.

**OPFS matrix caching.** Browser workers cache distance-matrix results in the Origin Private File System using a SHA-256 key derived from the stop list and origin point. On a cache hit the Valhalla engine is skipped entirely. An eviction policy automatically clears the oldest cache files when storage usage exceeds 80% of the browser-assigned quota.

**Binary transport on the data plane.** Problem payloads are serialised to JSON and sent over the WebSocket data plane. The WASM solvers themselves operate on typed arrays and return results as structured JSON — no runtime reflection.

---

## TypeScript SDK

The [`@loxi/worker-device`](sdk/web) package provides `LoxiWorkerDevice`, a drop-in class for embedding a Loxi compute worker in any web application:

```ts
import { LoxiWorkerDevice } from '@loxi/worker-device';

const worker = new LoxiWorkerDevice('ws://your-orchestrator:3005');
worker.onEvent(event => console.log(event));
worker.connect();
```

Published to npm on `sdk-v*` tag pushes via `.github/workflows/publish-sdk.yml`. Requires `NPM_TOKEN` in repository secrets.

---

## CI

| Workflow | Trigger | What it checks |
|---|---|---|
| `ci.yml` | push to main, all PRs | `cargo fmt`, `clippy -D warnings`, `cargo test` |
| `e2e.yml` | all PRs | Playwright smoke test: two workers → 10-stop dispatch → solution verified |
| `publish-sdk.yml` | `sdk-v*` tag push | `npm build` + `npm publish --access public` |

---

## Roadmap

### Near-term (in progress)
- **Multi-vehicle fleet configuration** — define fleets with different capacities, speeds, and cost profiles in a single problem submission (`fleet` array alongside the existing `vehicle` shorthand)
- **Reproducible solves** — wire the `seed` parameter into the VRP solver's random number generator so the same problem always returns the same routes
- **Input validation** — reject malformed problems at submission time with structured error messages (coordinate range, time-window sanity, capacity sign)
- **`PushSolution` ticket enforcement** — verify the RS256 ticket on the data-plane reveal path (currently only `ClaimTask` is verified)

### Medium-term
- **Address input + geocoding** — accept street addresses alongside coordinates; batch-geocode via Nominatim (OSM) before solving, with confidence scores and ambiguity flags returned in the response
- **Webhook callbacks** — push `mission_completed` notifications to a caller-supplied URL instead of requiring polling; include per-partition progress events
- **OpenAPI specification** — machine-readable API contract for integration with TMS/WMS systems
- **Solution quality report** — per-vehicle utilisation %, time-window violation list, distance vs haversine lower bound, unassigned stop reasons
- **Traffic-aware routing** — Valhalla supports time-of-day traffic tiles; expose a `departure_time` field on problems to use real congestion data instead of static OSM speeds
- **Fleet planner dashboard** — a separate operator UI (distinct from the worker tab) for uploading stop lists, reviewing proposed routes, overriding individual assignments, and exporting to downstream systems

### Long-term
- **Distributed scale proof** — benchmark a 50k-stop problem across 50 workers on real hardware; publish the speedup curve and the point at which distribution becomes economically meaningful vs a single server
- **WebRTC P2P payload transfer** — route problem payloads directly between workers instead of relaying through the server; the signalling infrastructure (orchestrator `Signal` relay) is already in place
- **Real competitive auction** — collect worker bids with prices over a configurable window; assign to the lowest-cost bidder rather than the highest-hardware-score worker; foundation for a compute marketplace model
- **On-chain settlement** — `loxi-core` is already `#![no_std]` and structured for Solana deployment; workers earn tokens for completed compute, verified by the commit-reveal hash written on-chain

---

## License

MIT — see [LICENSE](LICENSE).
Copyright © 2026 Juan Patricio Marchetto and Sergio Ariel Solis.
