---
description: Run a feasibility and risk audit for a specific task
---

Before moving to the EXECUTION phase on any roadmap task, run this workflow:

1. **Technical Context**: Identify which components (Crates, SDKs, APIs) will be affected.
2. **Capacity Analysis**:
   - Does it exceed the 4 GB RAM limit of Wasm32?
   - What network latency does it add to the response (TTFT)?
   - Does it require specialised hardware (WGPU/GPU)?
3. **Risk Detection**:
   - **Numerical Drift**: Will calculations be deterministic across all nodes?
   - **Fragility**: If a node disconnects, does the entire pipeline fail?
   - **Security**: Is any data exposed in clear text?
4. **Feasibility Score (1–10)**:
   - Evaluate complexity vs. benefit.
5. **Mitigation**: Define at least one measure for each critical risk found.
6. **Log**: Results must be prepended to `/brain/feasibility_report.md`.

Running this workflow ensures Loxi is robust and scalable.
