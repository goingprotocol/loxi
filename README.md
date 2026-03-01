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
 Grid Orchestrator          ← auction: matches tasks to workers
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

Workers are matched by affinity (cached WASM artifact) first, then by hardware score (RAM + threads + GPU). If a worker goes silent for more than 120 seconds the task is automatically re-queued. Duplicate solution submissions — which can happen when a slow worker reconnects — are silently deduplicated.

---

## Quickstart

### Prerequisites

```bash
rustup toolchain install nightly
rustup target add wasm32-unknown-unknown
cargo install wasm-pack      # if not already installed
node --version               # 18+
```

### 1. Set up the orchestrator keys

Generate a dev RSA keypair and drop it into the orchestrator's `.env`:

```bash
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem
cp protocol/crates/loxi-orchestrator/.env.example \
   protocol/crates/loxi-orchestrator/.env
# paste the single-line key values into .env as instructed in the example file
```

### 2. Get routing tiles

Pre-built Buenos Aires tiles (recommended):
```bash
bash scripts/download_tiles.sh
```

Or generate from OSM data (requires Docker, ~10 min):
```bash
bash protocol/crates/logistics/loxi-logistics/scripts/generate_tiles.sh
```

### 3. Build WASM artifacts

Compiles VRP solver, Matrix engine, and Partitioner to WASM and packages them for serving:
```bash
bash scripts/build_artifacts.sh
```

### 4. Start the node

Starts the Grid Orchestrator on port 3005 and the Logistics node (API + artifact server) on port 8080:
```bash
bash scripts/run_node.sh
```

### 5. Open worker tabs

```bash
cd apps/worker-web
cp .env.example .env      # defaults to localhost:3005 / :8080
npm install
npm run dev
```

Open `http://localhost:5173` in **2 or 3 browser tabs**. In each tab, pick a hardware preset (TITAN / DESKTOP / MOBILE) and click **Connect**.

### 6. Dispatch a problem

In any tab, click **Generate** (30–60 stops, Buenos Aires), then **Dispatch**. You can also upload your own stops as a CSV file (`lat`, `lon`, optional `id` columns) or paste a JSON array directly.

Watch the logs: `TASK_BROADCAST → TASK_ASSIGNED → TASK_COMPLETED`. Routes render on the map when all workers report back. Once a solution appears you can export it as CSV or GeoJSON from the header buttons.

---

## Project layout

```
protocol/
├── crates/
│   ├── loxi-core/              # Shared message types and protocol definitions
│   ├── loxi-orchestrator/      # Grid scheduler, auction engine, JWT ticket signing
│   ├── loxi-cli/               # `loxi node` binary — wires orchestrator + logistics server
│   ├── loxi-architect-sdk/     # Shared Architect client primitives
│   ├── loxi-wasm-sdk/          # WASM utility helpers
│   ├── loxi-types/             # Serialization types shared across crates
│   └── logistics/
│       ├── loxi-logistics/     # Architect logic, REST/WebSocket API server, engines
│       ├── loxi-vrp/           # VRP solver (vrp-pragmatic)
│       ├── loxi-matrix/        # Valhalla WASM bridge for road-distance matrices
│       ├── loxi-partitioner/   # H3 geographic partitioner
│       └── loxi-worker-pkg/    # Worker entry-point templates
sdk/
└── web/                        # TypeScript SDK (LoxiWorkerDevice)
apps/
└── worker-web/                 # React worker UI (Vite)
scripts/
├── build_artifacts.sh          # Build all WASM packages
├── download_tiles.sh           # Fetch pre-built routing tiles
└── run_node.sh                 # Start orchestrator + logistics node
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

**Auction and scheduling.** Workers bid on tasks by registering their hardware capabilities. The scheduler uses a three-tier affinity match: preferred workers (who already have the WASM artifact cached), capable workers (hardware score above the task threshold), and a fallback queue. A binary heap ensures the highest-scoring available worker is always dispatched first.

**Fault tolerance.** Worker disconnect triggers immediate task re-queue via the recovery procedure in `handle_connection`. A 30-second watchdog independently evicts any worker silent for more than 120 seconds and re-schedules its task. Auctions that complete are marked as such and evicted after one hour to prevent map growth.

**Binary transport on the data plane.** Problem payloads are serialised to JSON and sent over the WebSocket data plane. The WASM solvers themselves operate on typed arrays and return results as structured JSON — no runtime reflection.

**Zero-copy in browser workers.** Problem bytes are transferred to Web Workers via `postMessage` with `Transferable`, avoiding a copy through the JS heap.

---

## License

MIT — see [LICENSE](LICENSE).
Copyright © 2026 Juan Patricio Marchetto and Sergio Ariel Solis.
