# Notification and Traceability Flow

This document explains how Loxi routes telemetry, intermediate states, and final solutions back to the client that submitted the original task — regardless of how many workers and sub-tasks were involved in solving it.

---

## The core idea

Every task in the network carries an ownership stamp: the `client_owner_id`. When the Architect submits a problem it registers itself with the orchestrator as an **Authority** and tags all the subtasks it generates with its domain ID. The orchestrator uses this ID to find the right WebSocket connection when it needs to relay a result or a progress event.

Workers never need to know who the client is or where it's listening. They just submit their results to the orchestrator; the orchestrator handles the relay.

---

## Step by step

### 1. Authority registration

When the Architect connects to the orchestrator it sends a `RegisterAuthority` message:

```rust
LoxiMessage::RegisterAuthority { domain_id, authority_address }
```

The orchestrator stores the mapping from `domain_id` to the active WebSocket connection. Any future message addressed to that `domain_id` will be forwarded over that connection.

### 2. Ownership propagation

When the Architect requests a lease for a task, the orchestrator captures its `domain_id` as the `poster_id` in the auction metadata. This ID is then stamped onto every sub-task the Architect generates — Matrix, Partitioner, and VRP tasks all carry the same `client_owner_id` as the top-level mission.

The ID is immutable once set. It can't be overridden by a worker or a downstream sub-task.

### 3. Relay mechanisms

Two message types carry information back to the owner.

**`NotifyOwner`** is for progress events and mission completion signals. The Architect sends this to the orchestrator when it wants to push a status update to the client:

```rust
LoxiMessage::NotifyOwner {
    owner_id: String,         // the client's domain_id
    notify_type: String,      // e.g. "MISSION_COMPLETED"
    payload: String,          // JSON — route data, stats, etc.
    metadata: Option<Value>,
}
```

On the wire it looks like this:

```json
{
  "NotifyOwner": {
    "owner_id": "my_org_01",
    "notify_type": "MISSION_COMPLETED",
    "payload": "{\"mission_id\": \"...\", \"solution\": [...]}",
    "metadata": null
  }
}
```

**`SubmitSolution`** is sent directly by workers when they finish a computation. The orchestrator looks up the `client_owner_id` in its authority map and forwards the message to the right connection immediately. It also checks whether a solution for this auction has already been delivered — if so, the duplicate is dropped silently.

---

## Why this design

**Privacy.** Workers learn the owner's string ID but never see its network address or connection details. They can't probe or contact the client directly.

**Multi-tenancy.** A single orchestrator instance can serve many organisations simultaneously. Traffic is separated by `domain_id`; organisations never see each other's data.

**Traceability.** Because every sub-task carries the original `client_owner_id`, it's possible to reconstruct the full execution tree of any mission — which workers ran which subtasks, in which order, with what results — purely from the orchestrator's logs.

**Fault tolerance.** If the client reconnects (e.g. after a network hiccup), the orchestrator's authority map is updated on the next `RegisterAuthority` message. Subsequent relays go to the new connection automatically.

---

*Reflects the current implementation in `loxi-orchestrator/src/lib.rs` and `loxi-logistics/src/architect/mod.rs`.*
