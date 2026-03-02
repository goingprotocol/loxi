---
description: Verify parity between Native and WASM
---

Run this workflow whenever networking logic (Phase D) or download logic (Phase C) is modified:

1. **Backend Switch**: Verify that the same `ShardManager` calls work using `fetch` (WASM) and `reqwest` (Native).
2. **Sandboxing Check**: Confirm that network headers (e.g. Range Requests) do not violate the browser's CORS policies.
3. **Memory Dynamics (Wasm64)**: When using `wasm64`, the 4 GB limit disappears. Verify that memory allocation is dynamic and that the node can scale according to available system RAM, enabling massive contexts.
4. **Feature Parity**: If a feature is added in Native (e.g. multi-threading), find its equivalent or fallback in WASM (Web Workers).
5. **Log**: Document any incompatibilities found in `feasibility_report.md`.

Loxi must be agnostic of the execution environment.
