## Loxi

**Loxi** is a browser-first routing and logistics optimization engine that produces **high-quality, constraint-respecting routes** with **real-time adaptability**.

It is designed for **real-time replanning**: instead of spending seconds chasing theoretical optimality, it produces high-quality routes in milliseconds so you can re-run it continuously as the world changes (traffic, cancellations, new stops, delays).

Loxi targets two execution environments:
- **In the browser** via **Rust → WASM + WebGPU (WGSL)** for low-latency, scalable, client-side optimization
- **On the server** (native Rust) for baselines, regression testing, replay, and verification

The core philosophy: **bounded-time optimization for real operations**—optimize for **route quality**, **constraint correctness**, **stability**, and **time-to-decision** because the world changes faster than any one-time “perfect” plan.

---

## What we’re building (scope)

### In-scope (v0 → v1)
- **A portable solver core** that can run in both WASM and native targets.
- **Single-vehicle routing** with realistic constraints:
  - time windows
  - capacity
  - priorities / penalties
- **Small problem size first**: ≤ 25 stops (optimize for interactive replanning and frequent reruns)
- **Heuristic-first** (GPU-friendly): local search, neighborhood exploration, batch scoring, stochastic improvement (seeded)
- **Progressive enhancement**:
  - WebGPU acceleration when available
  - CPU fallback when not
- **Reproducibility hooks**: deterministic **when seeded** + versioned solver behavior for benchmarking and regression tests

### What Loxi is *for* (use cases)
- **Driver-side replanning**: update the route locally when a stop is added/removed or an ETA shifts.
- **Dispatcher tools**: interactively test “what-if” changes without waiting on server-side batch optimization.
- **Cost reduction**: offload a meaningful chunk of optimization compute from centralized servers to clients.

### Out of scope (initially)
- “OR-Tools optimal” exact optimization as the primary goal.
- Large multi-vehicle VRP at production scale (comes after v1).
- Proof systems / blockchains / settlement layers (not part of Loxi’s core scope).

---

## Recommended implementation shape (once code starts)

### Rust crates (planned)
- **`loxi-types`**: shared domain types and serialization contracts
- **`loxi-cost`**: objective/cost functions and penalty model
- **`loxi-heuristics`**: CPU heuristics baseline (deterministic, seeded)
- **`loxi-gpu-kernels`**: WGSL kernels + buffer layouts + kernel versioning
- **`loxi-webgpu`**: WebGPU dispatch/runtime glue
- **`loxi-wasm`**: `wasm-bindgen` exports for TypeScript/browser
- **`loxi-bench`**: benchmark harness + datasets

### Browser API (planned)
- `solve_route(problem) -> solution`
- `improve_route(solution, delta) -> solution`
- `score(solution, problem) -> score_breakdown`

---

## Benchmarks (how we will measure success)

We benchmark against **good-enough + fast** baselines, not “provably optimal”.

---

## Modeling assumptions (current)

- **Single vehicle**: one route per problem.
- **Distances & travel times**:
  - If `distance_matrix`/`time_matrix` are provided, they are used (must be NxN).
  - Otherwise distances use haversine (meters) and times are derived from `vehicle.speed_mps`.
- **Time windows**: arriving **early is allowed**; the vehicle **waits until the window start**. Only **late arrival** creates a violation/penalty.
- **Soft constraints**: capacity + time windows are evaluated as **penalties** (solutions can be infeasible; penalties reflect “how bad”).
- **Determinism**: solving is reproducible **when you pass a seed** (CLI `--seed`, WASM `solve_route_seeded`).

### Metrics
- **Latency**: p50/p95 solve + incremental replan time
- **Quality**: cost vs strong CPU baseline (target small % gap)
- **Stability**: avoid oscillation between replans
- **Device coverage**: acceptable behavior with/without WebGPU

### Test scenarios
- Add a stop
- Cancel a stop
- Change a time window
- Delay (ETA shift)

---

## Rivals / adjacent tools (for context)

Routing/VRP baseline competitors:
- OR-Tools
- OptaPlanner
- VROOM
- jsprit

Adjacent routing engines (not VRP solvers):
- OSRM
- Valhalla
- GraphHopper

The differentiator for Loxi is **browser-first GPU acceleration** + **tight replanning loop** + **auditability hooks**.

---

---

## 🚀 Current Status (Updated: Jan 20, 2026)

**Phase 0 & Phase 1: COMPLETE ✅**

### What's Working Now

- ✅ **Full-featured CPU solver** with construction + improvement heuristics
- ✅ **CLI tool** for solving problems from JSON files
- ✅ **28 passing unit tests** (`cargo test --workspace`)
- ✅ **Benchmark harness** (Criterion)
- ✅ **Deterministic solving** with seeded RNG
- ✅ **Measured solve latency** (Criterion `loxi-bench`, release, this machine):
  - 5 stops: ~0.32 ms
  - 10 stops: ~1.76 ms
  - 15 stops: ~4.55 ms
  - 20 stops: ~8.96 ms
  - 25 stops: ~17.12 ms
  - Reproduce: `cargo bench -p loxi-bench --bench routing_bench -- --noplot`
- ✅ **GitHub Actions CI** (fmt, clippy `-D warnings`, tests)

### Quick Start

```bash
# Build the project
make build

# Run tests
make test

# Solve an example problem
make run-example

# See all available commands
make help
```

See [QUICKSTART.md](QUICKSTART.md) for detailed instructions.

### Deploy demo (Cloudflare Pages)

To deploy the static browser demo to Cloudflare Pages (build command, output directory, and local preview), see [CLOUDFLARE_PAGES.md](CLOUDFLARE_PAGES.md).

---

## Next steps (practical roadmap)

### Milestone A — Keystone demo (feasibility)
- Define the canonical problem schema (stops, constraints, objective).
- Implement a deterministic CPU heuristic baseline.
- Ship a browser demo that solves ≤ 25 stops and visualizes route + latency.

### Milestone B — GPU acceleration (advantage)
- Implement GPU-accelerated primitives (batch scoring / neighborhood eval).
- Run cross-device benchmarks (desktop + integrated + mobile).

### Milestone C — Productization hooks (integration)
- Freeze stable input/output schemas for the browser API.
- Add strict regression tests and benchmark datasets.
- Add solver/kernel versioning so benchmark results stay comparable over time.


