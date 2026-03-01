# Loxi: Distributed Compute Orchestration Protocol

*A sovereign compute layer for routing, optimisation, and beyond.*

---

## 1. The problem with centralised compute

Modern logistics and optimisation software has converged on a single architectural pattern: send your data to a cloud provider, pay per API call, and hope the provider's algorithm is good enough for your problem. Every route calculation, every geographic partition, every optimisation run flows through infrastructure you don't control and can't inspect.

We call this the **compute tax** — a linear cost imposed on every byte of data processed by a third party. It compounds with scale. A fleet operator routing 10,000 deliveries a day doesn't just pay for the compute; they also accept data sovereignty risk, algorithm opacity, and vendor lock-in as part of the deal.

Loxi is a response to this. It's an open compute protocol designed to orchestrate heavy tasks across a network of sovereign, heterogeneous nodes — including, critically, ordinary browser tabs.

---

## 2. What Loxi is

Loxi sits between the application layer and the network. It doesn't move data blindly; it evaluates the hardware available at each potential execution site (RAM, CPU threads, GPU availability) and routes work to wherever it can be solved most efficiently.

Three properties define it:

**Resource governance.** Before dispatching a task, the orchestrator auctions it. Workers bid with their hardware profile. The scheduler matches the task's minimum requirements against bids and assigns it to the highest-scoring available worker. No worker gets more than it can handle; no task sits waiting when capable workers are idle.

**Local-first compute.** In the logistics domain, road tiles and geographic data are cached on each worker node (browser OPFS or local filesystem). The algorithm travels to the data rather than the data travelling to the algorithm. This reduces network round-trips and keeps raw location data on the worker, not a central server.

**Cryptographic verification.** Every task assignment is signed with a short-lived RS256 JWT ticket. Workers must present this ticket to the data plane before receiving any payload. This prevents rogue connections from claiming tasks they weren't assigned.

---

## 3. The three roles

### Architect

The Architect owns the problem. It knows what needs to be solved, breaks it into subtasks appropriate for the current worker pool, dispatches those tasks to the orchestrator, and assembles the results when workers report back. For the logistics domain the Architect is implemented in `loxi-logistics`; other domains would implement their own.

The Architect doesn't execute algorithms. It designs the execution plan, monitors progress via the `NotifyOwner` relay, and handles failure cases (re-queuing stalled tasks, merging partial results).

### Cartridge (WASM artifact)

A cartridge is a self-contained unit of logic compiled to WebAssembly. It runs identically in a browser tab, a Node.js process, or a native binary. The three cartridges in the logistics stack are:

- **Matrix** — computes road-distance matrices using Valhalla tile data cached on the worker
- **Partitioner** — divides a stop set into geographic clusters using the H3 hexagonal grid (Uber's open standard)
- **VRP Solver** — solves the Vehicle Routing Problem on a cluster using `vrp-pragmatic`

Cartridges are fetched once and cached. On subsequent tasks a worker that already has the artifact is preferred in the auction, saving a network round-trip.

### Worker

Workers are nodes that offer spare CPU cycles to the network. In the browser, a tab running the worker UI is a fully functional worker — it connects to the orchestrator via WebSocket, receives lease assignments, fetches cartridges if needed, executes them in a Web Worker thread, and submits the result. There is no installation step, no account, and no persistent daemon.

Native workers (Node.js or compiled binary) operate the same way and are better suited for CPU-intensive tasks that benefit from multi-threading beyond what a browser tab can offer.

---

## 4. The logistics stack in practice

When a client submits a routing problem, the Architect sizes it and builds a task pipeline:

| Problem size | Pipeline |
|---|---|
| ≤ 12 stops | Single VRP task — one worker, direct solve |
| 13–100 stops | Partitioner task → N parallel VRP tasks |
| 100+ stops | Matrix task → Partitioner task → N parallel VRP tasks |

Workers solve their assigned subtask and submit results back to the orchestrator, which relays them to the Architect. The Architect merges partial routes and fires a `MISSION_COMPLETED` notification to the client that submitted the original problem.

If a worker goes silent mid-task, the orchestrator's watchdog detects it within 120 seconds and re-queues the task. The client eventually gets a complete solution regardless of individual worker failures.

---

## 5. What comes next

The Loxi protocol is domain-agnostic. The logistics stack is the first vertical, but the same orchestration layer supports any workload that can be expressed as a WASM cartridge:

- **Scientific simulation** — distribute physics or financial simulations across heterogeneous hardware without a dedicated cluster. Each node receives only the slice of the state space it needs to compute, and results are merged by the Architect at the end.
- **Video and media processing** — assign frame or segment ranges to worker nodes and aggregate the encoded output. Browser workers with hardware-accelerated WebCodecs become first-class render nodes.
- **Financial computation** — risk models and Monte Carlo simulations are embarrassingly parallel. The auction scheduler naturally distributes independent simulation runs across available workers.

The goal in each case is the same: eliminate the centralised intermediary, let the algorithm travel to the data, and give organisations sovereignty over their own compute.

---

*Loxi Protocol — The Sovereign Compute Manifesto*
*Copyright © 2026 Juan Patricio Marchetto and Sergio Ariel Solis. MIT License.*
