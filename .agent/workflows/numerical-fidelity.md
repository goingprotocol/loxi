---
description: Run a numerical fidelity and determinism audit
---

This workflow is mandatory whenever Kernels (WGPU/Metal/CUDA) are modified or layers are added to the model:

1. **Identity Test**: Run the same forward pass with the same seed and prompt on CPU vs. GPU (WGPU). Tensors must be identical to the 6th decimal place.
2. **Accumulation Check**: Verify that the mean squared error (MSE) does not grow linearly across layers.
3. **Precision Finiteness**: If FP16 or BF16 is used, audit for Underflow or Overflow in normalisation (LayerNorm).
4. **Cross-Hardware Validation**: (Optional) Ask the user to test the commit on a different architecture (e.g. Intel vs. Apple Silicon) if there are changes to the Loxi-Kernel.
5. **Log**: Document any deviation found in `feasibility_report.md`.

Determinism is what allows Node A and Node B to be interchangeable.
