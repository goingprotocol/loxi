---
description: Realizar una auditoría de fidelidad numérica y determinismo
---

Este flujo es obligatorio cuando se modifican Kernels (WGPU/Metal/CUDA) o se añaden capas al modelo:

1. **Prueba de Identidad**: Ejecutar el mismo forward pass con el mismo seed y prompt en CPU vs. GPU (WGPU). Los tensores deben ser idénticos hasta el 6º decimal.
2. **Chequeo de Acumulación**: Verificar que el error cuadrático medio (MSE) no crezca linealmente a lo largo de las capas.
3. **Finitud de Precisión**: Si se usa FP16 o BF16, auditar casos de Underflow o Overflow en la normalización (LayerNorm).
4. **Validación Cross-Hardware**: (Opcional) Solicitar al usuario probar el commit en otra arquitectura (ej. Intel vs. Apple Silicon) si hay cambios en el Loxi-Kernel.
5. **Registro**: Documentar cualquier desviación detectada en `feasibility_report.md`.

El determinismo es lo que permite que el Nodo A y el Nodo B sean intercambiables.
