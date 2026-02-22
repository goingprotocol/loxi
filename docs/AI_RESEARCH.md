# Investigación: Inferencia de IA Distribuida en Loxi

## 1. Visión Holística
El objetivo es transformar el "enjambre" de Loxi en una red de cómputo capaz de ejecutar modelos de Inteligencia Artificial de forma fragmentada, segura y eficiente, utilizando WebAssembly (WASM) y WebGPU.

## 2. Motores de Inferencia (IA Engines)

### A. Candle (Hugging Face)
- **Lenguaje**: Rust Puro.
- **Enfoque**: Inferencia minimalista.
- **Ventajas para Loxi**:
    - Binarios WASM muy pequeños.
    - Soporte excelente para modelos de Hugging Face.
    - Muy centrado en seguridad y tipado fuerte.
- **Uso**: Ideal para modelos de texto (NLP) y clasificación simple.

### B. Burn (Tracel AI)
- **Lenguaje**: Rust Puro.
- **Enfoque**: Máximo rendimiento mediante abstracción de hardware y optimización de kernels.
- **WebGPU Ready**: **ALTA**. Posee el backend `burn-wgpu` más sólido actualmente. Permite escribir kernels de GPU directamente en Rust (vía CubeCL).
- **Uso**: Ideal para nodos "Heavy" que quieren exprimir al máximo la GPU del dispositivo.
- **Desventaja**: El ecosistema de modelos pre-entrenados es menor que el de Hugging Face (aunque puede importar modelos de Candle/ONNX).

### Comparativa: ¿Cuándo usar cuál?

| Característica | Candle | Burn |
| :--- | :--- | :--- |
| **Peso WASM** | Muy Ligero (2-5 MB) | Ligero/Medio (5-10 MB) |
| **WebGPU** | En desarrollo activo (Experimental) | Estable y Maduro (Optimizado) |
| **Modelos** | Acceso nativo a Hugging Face | Menos modelos nativos (Requiere importación) |
| **Programación** | Centrado en LLMs/Transformers | Framework general de Deep Learning |

## 3. Estrategia de Cómputo en Loxi
Loxi será **Agnóstico al Motor**:
- Los nodos con solo CPU usarán **Candle** por su eficiencia extrema.
- Los nodos con GPU potente usarán **Burn** para procesar tareas masivas en segundos.

## 4. Seguridad y Sandboxing
Correr IA en Loxi es intrínsecamente más seguro que soluciones de escritorio:
- **WASM Memory Isolation**: El modelo no puede acceder a la memoria del host.
- **Deterministic Compute**: Podemos validar resultados mediante consenso.
- **Capability-based Security**: Loxi controla exactamente qué recursos (RAM, Threads) consume el modelo.

## 4. Prueba de Concepto (PoC) Propuesta
Implementar un **`LoxiAiWorker`** capaz de ejecutar **MobileNet V2**:
- **Tamaño**: ~14 MB.
- **Entrada**: Imagen (Array de bytes).
- **Salida**: Clase detectada (String) + Score de confianza.
- **Flujo**:
    1. El Architect divide un lote de 10 imágenes.
    2. 10 nodos de Loxi reciben 1 imagen c/u.
    3. Cada nodo procesa su imagen y devuelve el resultado.
    4. El Architect consolida la clasificación final.

## 5. Próximos Pasos Técnicos
1. Crear el crate `loxi-ai` dentro de `protocol/crates`.
2. Definir los traits para un `AiEngine` agnóstico.
3. Prototipar el cargador de modelos (Model Loader) que use el sistema de Artifacts de Loxi.
