# Plan de Implementación Maestro: Loxi AI Inference (Distribuido)

## Estado: Fase de Discusión y Diseño (v1.1)
**Objetivo**: Crear un sistema de inferencia capaz de fragmentar modelos masivos (ej. 120B) en un enjambre de nodos heterogéneos, priorizando la soberanía del dato y la eficiencia de memoria.

---

## Módulo 1: El Protocolo de Tareas (Orquestación)
*   **Subasta de IA**: El Architect no solo busca "proximidad", sino "Afinidad de Capas" (¿Quién ya tiene el Shard X?).
*   **Sticky Pipelines**: El Architect intenta mantener el mismo grupo de nodos para una sesión para minimizar la latencia de red.
*   **Validación de Cómputo (Asíncrona)**: 
    *   **Background Check**: El Architect valida hashes de los nodos en segundo plano sin interrumpir el stream.
    *   **Kill-Switch**: Si se detecta fraude matemático, el Architect invalida la ruta de información y notifica al usuario.

## Módulo 2: Gestión de Pesos y Sharding (Storage)
*   **Fragmentación de Safetensors**: Pesos divididos en fragmentos (shards) de ~512MB-1GB descargables vía HTTP Range Requests.
*   **Persistent Artifacts**: Uso de Cache API / IndexedDB en el browser para persistir capas.
*   **Optimización de Tensores (Hidden States)**: 
    *   **Prefill Phase**: Tensor pesado para procesar el prompt inicial (Batch).
    *   **Decoding Phase**: Tensor ligero (~KBs/MBs) para la generación palabra por palabra. El tamaño del tensor es fijo según el modelo, no crece con el número de saltos.

## Módulo 3: Comunicación en Tiempo Real (WSS Relay)
*   **Salas WSS Directas**: Los nodos de un pipeline se comunican a través de un canal optimizado en el Orchestrator para reducir saltos de latencia.
*   **Quantized Tensors**: Compresión de los Hidden States antes del envío por red (16-bit -> 4/8-bit) para maximizar la velocidad en conexiones domésticas.

## Módulo 4: Gestión de Contexto (KV Cache)
*   **Blind Storage Relay (Zero-Knowledge)**: El Architect almacena y distribuye el KV Cache en bloques cifrados. El Architect NO posee las llaves de descifrado, actuando únicamente como acelerador de ancho de banda.
*   **Client-Owned Keys**: Las llaves maestras de cifrado residen exclusivamente en el dispositivo del usuario. El Worker recibe una llave de sesión temporal para descifrar el fragmento en RAM.
*   **Layer-Specific Context**: Cada nodo solo recibe el fragmento de cache cifrado correspondiente a sus capas asignadas, minimizando el radio de impacto ante un nodo comprometido.
*   **Stateless RAM Processing**: El descifrado y procesamiento ocurre exclusivamente en la memoria volátil del Worker. Prohibición de persistencia en disco local del nodo.
*   **Atomic Snapshotting (Híbrido)**: Tras la respuesta, el Worker genera un nuevo snapshot cifrado y lo envía al Architect para su persistencia ciega.

## Módulo 5: Ejecución (AI Engine - Candle/Burn)
*   **WebGPU First**: Prioridad absoluta al uso de **WebGPU (WGPU)** para el producto de matrices. El sistema detecta automáticamente la disponibilidad de la GPU.
*   **WASM SIMD Fallback**: Si WebGPU no está disponible, el motor cae a una ejecución optimizada por CPU usando instrucciones SIMD.
*   **Agnosticismo de Motores**: La interfaz `AiEngine` permite intercambiar entre **Candle** (por su ligereza) y **Burn** (por su potencia en GPU) según las necesidades del modelo.
*   **Watchdog de Memoria & VRAM**: Sistema de control para evitar que la carga de un fragmento de modelo colapse el host o la memoria de video.

---

## Hoja de Ruta (Roadmap)
1.  **Fase A (Diseño)**: [ACTUAL] Definición de protocolos de intercambio de tensores y arquitectura de cache.
2.  **Fase B (Storage Layer)**: Implementar el servidor de Shards y el sistema de descarga por bytes en el worker.
3.  **Fase C (Single Node PoC)**: Ejecución de un modelo pequeño (ej. MobileNet o Tiny-Llama) en un solo nodo Loxi.
4.  **Fase D (Distributed Chain)**: Inferencia distribuida uniendo 2 nodos (Pipeline secuencial) con intercambio de Tensores.
5.  **Fase E (Scale)**: Implementación del "Memory Over Network" para modelos gigantes (120B).
