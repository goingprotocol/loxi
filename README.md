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

Workers are ordinary browser tabs running the [worker UI](apps/worker-web). Each tab registers with the orchestrator, bids on tasks matching its hardware, executes a WASM artifact, and submits the result. Zero installation. No token. No daemon.

---

## How it works

A problem submitted to the Architect is automatically stratified by size:

| Stops | Strategy |
|-------|----------|
| ≤ 12  | Single VRP worker, direct solve |
| ≤ 100 | Partitioner worker → N VRP workers in parallel |
| 100+  | Matrix worker → Partitioner → N VRP workers |

Workers are matched by affinity (cached WASM artifact) first, then by hardware score (RAM + threads + GPU). If a worker goes silent for more than 120 seconds the task is automatically re-queued.

---

## Quickstart

### Prerequisites

```bash
rustup toolchain install nightly
rustup target add wasm32-unknown-unknown
cargo install wasm-pack      # if not already installed
node --version               # 18+
```

### 1. Get routing tiles

Pre-built Buenos Aires tiles (recommended):
```bash
bash scripts/download_tiles.sh
```

Or generate from OSM data (requires Docker, ~10 min):
```bash
bash protocol/crates/logistics/loxi-logistics/scripts/generate_tiles.sh
```

### 2. Build WASM artifacts

Compiles VRP solver, Matrix engine, and Partitioner to WASM and packages them for serving:
```bash
bash scripts/build_artifacts.sh
```

### 3. Start the node

Starts the Grid Orchestrator on port 3005 and the Logistics node (API + artifact server) on port 8080:
```bash
bash scripts/run_node.sh
```

### 4. Open worker tabs

```bash
cd apps/worker-web
npm install
npm run dev
```

Open `http://localhost:5173` in **2 or 3 browser tabs**. In each tab:
- Pick a hardware preset (TITAN / DESKTOP / MOBILE)
- Click **Connect**

### 5. Dispatch a problem

In any tab, click **Generate** (30–60 stops, Buenos Aires), then **Dispatch**.

Watch the logs: `TASK_BROADCAST → TASK_ASSIGNED → TASK_COMPLETED`.
Routes render on the map when all workers report back.

---

## Project layout

```
protocol/
├── crates/
│   ├── loxi-core/              # Shared message types (Protocol v3)
│   ├── loxi-orchestrator/      # Grid scheduler + auction engine
│   ├── loxi-cli/               # `loxi node` entrypoint
│   ├── logistics/
│   │   ├── loxi-logistics/     # Architect, API server, engines
│   │   ├── loxi-vrp/           # VRP solver (vrp-pragmatic)
│   │   ├── loxi-matrix/        # Valhalla WASM bridge
│   │   ├── loxi-partitioner/   # H3 geographic partitioner
│   │   └── loxi-worker-pkg/    # Worker entry-point templates
│   └── net/
│       ├── loxi-net-core/      # Binary transport (bincode/WebSocket)
│       ├── loxi-net-wasm/      # WebRTC transport (browser)
│       └── loxi-asset-manager/ # OPFS tile cache (browser)
sdk/
├── web/                        # TypeScript SDK (LoxiWorkerDevice)
└── node/                       # Node.js worker client
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
```

---

## Configuration

Copy and fill in the orchestrator environment file:
```bash
cp protocol/crates/loxi-orchestrator/.env.example \
   protocol/crates/loxi-orchestrator/.env
```

Generate a dev keypair:
```bash
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem
# paste single-line versions into .env (see .env.example for instructions)
```

---

## Architecture notes

- **Binary transport**: problem payloads use `bincode` over WebSocket `ArrayBuffer` frames — no JSON on the data plane.
- **Zero-copy workers**: problem bytes are transferred to Web Workers via `postMessage` with `Transferable`, not copied.
- **OPFS tile cache**: Valhalla road tiles are cached in the browser's Origin Private File System after first load.
- **Fault tolerance**: worker disconnect triggers immediate task re-queue; the timeout watchdog handles silent failures.
