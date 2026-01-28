# Loxi Protocol Quickstart

Loxi is a **Decentralized Logistics Orchestrator** designed to distribute complex optimization tasks (VRP, TSP) across a network of edge devices (Mobile Phones, Browsers).

## 🧠 Architecture: "Brain & Body"

Loxi follows a strict separation of concerns to ensure determinism and portability:

*   **The Brain (`loxi-core`)**: Pure resource allocation logic. Zero dependencies. Deterministic. Runs in WASM.
    *   *Role*: Decisions, Scoring, Task Assignment.
    *   *Location*: `protocol/crates/loxi-core`

*   **The Body (`loxi-orchestrator`)**: The physical interface. Handles networking (WebSockets), I/O, and runtime management.
    *   *Role*: Connecting Clients (Architects) with Workers (Edge Nodes).
    *   *Location*: `protocol/crates/loxi-orchestrator`

*   **The SDK (`loxi-wasm-sdk`)**: Tools for building "Architects" (Routing Engines) that run on the network.
    *   *Location*: `protocol/crates/loxi-wasm-sdk`

---

## 🚀 Getting Started

### Prerequisites

- **Rust** (stable): [Install via rustup.rs](https://rustup.rs)
- **wasm-pack**: `cargo install wasm-pack`

### Build the Protocol

The core logic and server reside in the `protocol` directory.

```bash
# 1. Enter the protocol workspace
cd protocol

# 2. Build everything (Core, Server, SDK)
cargo build --workspace

# 3. Run Tests
cargo test --workspace
```

### Run the Orchestrator (Server)

To start the central node that manages the network:

```bash
# From /protocol directory
cargo run -p loxi-orchestrator
```

### Build the WASM SDK

If you are developing a new Architect (Routing Algorithm):

```bash
cd crates/loxi-wasm-sdk
wasm-pack build --target web
```

---

## 📂 Directory Structure

```text
/loxi
  ├── /engines           # Reference Implementations (Valhalla, OSRM)
  ├── /protocol
  │     ├── /crates
  │     │     ├── /loxi-core         # The Brain (no_std)
  │     │     ├── /loxi-orchestrator # The Body (Server)
  │     │     ├── /loxi-logistics    # Logistics domain logic (VRP adapters)
  │     │     ├── /loxi-wasm-sdk     # SDK for WASM modules
  │     │     └── /loxi-bench        # Performance Benchmarks
```

## ⚡ Benchmarking

Loxi includes tools to measure device capability (RAM/CPU) for fair task assignment.

```bash
# Run generic benchmarks
cargo bench -p loxi-bench
```

## Next Steps

- Check `README.md` for the full vision.
- Explore `crates/loxi-core` to understand the allocation logic.
