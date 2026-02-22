---
description: Verificar la paridad entre Native y WASM
---

Este flujo se ejecuta al modificar la lógica de red (Fase D) o de descarga (Fase C):

1. **Backend Switch**: Probar que las mismas llamadas al `ShardManager` funcionan usando `fetch` (WASM) y `reqwest` (Native).
2. **Sandboxing Check**: Confirmar que los headers de red (como Range Requests) no violen las políticas de CORS del navegador.
3. **Memory Dynamics (Wasm64)**: Al usar `wasm64`, el límite de 4GB desaparece. Verificar que la asignación de memoria sea dinámica y que el nodo pueda escalar según la RAM disponible del sistema, permitiendo contextos masivos.
4. **Feature Parity**: Si se añade una función en Native (ej. multi-threading), buscar su equivalente o fallback en WASM (Web Workers).
5. **Registro**: Documentar incompatibilidades detectadas en `feasibility_report.md`.

Loxi debe ser agnóstico del entorno de ejecución.
