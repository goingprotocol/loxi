# Protocolo de Notificaciones y Trazabilidad (Client Owner Flow)

## Propósito
Este documento especifica cómo Loxi garantiza que la telemetría, los estados intermedios y las soluciones finales lleguen al usuario u organización que originó la tarea, independientemente de cuántos sub-nodos o "cartridges" participen en la ejecución.

## Arquitectura de Trazabilidad

### 1. Registro y Autoridad
Cuando un cliente (Architect) se conecta al **Orchestrator**, se registra como una **Authority**.
- **Mensaje**: `RegisterAuthority { domain_id, ... }`
- **Orchestrator**: Mapea el `domain_id` a la conexión WebSocket activa.

### 2. Propagación del `client_owner_id`
Toda tarea iniciada en la red lleva un sello de propiedad:
- Al solicitar una ejecución (`RequestLease`), el `domain_id` se convierte en el `client_owner_id`.
- Este ID se hereda de forma inmutable por cada sub-tarea generada por el `LogisticsManager` (Matrix, Partitioner, o Solver).

### 3. El Sistema de Relevo (Relay)

Loxi utiliza una arquitectura de relevo para notificar al dueño sin que los workers necesiten conocer la dirección IP del cliente:

#### A. Notificación de Estados (`NotifyOwner`)
Utilizado para logs de progreso (ej: "Calculando matriz de 500 paradas...") o eventos de finalización de misión.
- **Flujo**: `Manager` → `Orchestrator` → `Authority (Owner)`.
- **Estructura**:
```rust
LoxiMessage::NotifyOwner {
    owner_id: String,
    notify_type: String, // ej: "MISSION_COMPLETED"
    payload: String,     // JSON con resultados detallados
    metadata: Option<Value>,
}
```

#### B. Entrega de Soluciones (`SubmitSolution`)
Utilizado cuando un Worker termina un cálculo específico.
- **Orchestrator**: Al recibir un `SubmitSolution`, busca el `client_owner_id` en su mapa de autoridades y reenvía el mensaje instantáneamente.

## Diseño de Mensajería (JSON)

Para que la comunidad pueda integrar sus propios WebSockets, el formato estándar de notificación es:

```json
{
  "NotifyOwner": {
    "owner_id": "mi_organizacion_01",
    "notify_type": "MISSION_COMPLETED",
    "payload": "{ \"mission_id\": \"...\", \"status\": \"completed\", \"solution\": [...] }",
    "metadata": null
  }
}
```

## Beneficios del Modelo
1.  **Privacidad**: Los Workers solo ven un ID de dueño, no su información de conexión.
2.  **Multitenancy**: Un solo Orchestrator puede servir a múltiples organizaciones separando el tráfico por ID.
3.  **Trazabilidad**: Permite reconstruir el árbol de ejecución de una misión compleja analizando quién fue el dueño original de cada sub-tarea.

---
*Este documento refleja la implementación actual en `loxi-orchestrator` y `loxi-logistics`.*
