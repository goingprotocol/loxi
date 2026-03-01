---
description: Realizar una auditoría de viabilidad y riesgos para una tarea específica
---

Antes de pasar a la fase de EXECUTION en cualquier tarea del roadmap, se debe ejecutar este flujo:

1. **Contexto Técnico**: Identificar qué componentes (Crates, SDKs, APIs) serán afectados.
2. **Análisis de Capacidad**: 
   - ¿Supera el límite de 4GB de RAM de Wasm32?
   - ¿Qué latencia de red añade a la respuesta (TTFT)?
   - ¿Requiere hardware especializado (WGPU/GPU)?
3. **Detección de Riesgos**:
   - **Drift Numérico**: ¿Los cálculos serán determinísticos en todos los nodos?
   - **Fragilidad**: ¿Si un nodo se desconecta, se cae todo el pipeline?
   - **Seguridad**: ¿Hay fuga de datos en claro (clear-text)?
4. **Puntuación de Viabilidad (1-10)**: 
   - Evaluar complejidad vs. beneficio.
5. **Mitigación**: Definir al menos una medida para cada riesgo crítico detectado.
6. **Registro**: Los resultados se deben añadir al inicio de `/brain/feasibility_report.md`.

Ejecutar este workflow garantiza que Loxi AI sea robusto y escalable.
