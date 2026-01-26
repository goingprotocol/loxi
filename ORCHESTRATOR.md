# Loxi Orchestrator Architecture: "Brain & Body"

This document defines the architectural strategy for the Loxi Orchestrator, ensuring seamless transition from MVP (Centralized) to L2 Protocol (Decentralized) without code rewrites.

## The Philosophy
*   **The Brain (loxi-core):** Pure logic. Zero dependencies on OS, Network, or Time. `no_std`. Deterministic.
*   **The Body (loxi-server / loxi-node):** The wrapper that provides Inputs (Sockets/RPC) and executes Outputs (Responses).

## Directory Structure

```text
/loxi
  ├── /crates
  │     ├── /loxi-core       <-- THE BRAIN (no_std)
  │     │     └── Logic: Work distribution strategies, H3 clustering, Node ranking.
  │     │
  │     ├── /loxi-server     <-- THE BODY (MVP / Testing)
  │     │     └── Tech: Tokio, Warp/Axum (WebSockets).
  │     │     └── Role: Connects web clients to loxi-core logic.
  │     │
  │     └── /loxi-l2-node    <-- THE BODY (Future / Solana)
  │           └── Tech: Solana Validator Plugin.
  │           └── Role: Connects network gossip to loxi-core logic.
```

## 1. loxi-core: The Brain
*   **Role:** Blind, deaf, and dumb to the outside world. It just calculates.
*   **Config:** `Cargo.toml` -> `[package] no_std = true`
*   **Key Functions:**
    *   `assign_task(nodes: &[Node], task: Task) -> NodeId`
    *   `validate_proof_of_work(result: Result) -> bool`
    *   `cluster_stops(stops: &[Stop]) -> Vec<Cluster>` (Using `h3o`)

## 2. loxi-server: The MVP Body (What we build now)
*   **Role:** The centralized orchestrator for the Demo/MVP.
*   **Tech:** Rust `std`, `tokio`, `tungstenite` (WebSockets).
*   **Flow:**
    1.  **Listen:** WebSocket receives `{"msg": "REGISTER_NODE", "ram": 16GB}`.
    2.  **Parse:** Deserialize JSON.
    3.  **Think:** Call `loxi_core::register_node(...)`.
    4.  **Reply:** Send JSON back.

## 3. Transition Strategy (L2)
When migrating to the decentralized protocol:
1.  We maintain `loxi-core` untouched.
2.  We replace `loxi-server` with `loxi-l2-node`.
3.  The logic remains identical.

---
**Next Steps:**
1. Initialize `crates/loxi-core` (Library).
2. Initialize `crates/loxi-server` (Binary).
