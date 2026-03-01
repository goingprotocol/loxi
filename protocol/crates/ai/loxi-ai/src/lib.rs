use serde::{Deserialize, Serialize};

pub mod engine;
pub mod shard_manager;

/// Representa una etapa específica del pipeline de inferencia.
/// Un nodo puede ser responsable de un rango de capas.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PipelineStage {
    pub start_layer: usize,
    pub end_layer: usize,
    pub model_id: String,
}

impl PipelineStage {
    /// Parsea una configuración desde un string (Formato: model_id:start-end)
    /// Ejemplo: "llama3:0-10"
    pub fn from_str(s: &str) -> Result<Self, String> {
        let parts: Vec<&str> = s.split(':').collect();
        if parts.len() != 2 {
            return Err("Formato inválido. Usar 'model_id:start-end'".into());
        }

        let model_id = parts[0].to_string();
        let range: Vec<&str> = parts[1].split('-').collect();
        if range.len() != 2 {
            return Err("Rango de capas inválido. Usar 'start-end'".into());
        }

        let start_layer = range[0].parse::<usize>().map_err(|_| "start_layer no es un número")?;
        let end_layer = range[1].parse::<usize>().map_err(|_| "end_layer no es un número")?;

        Ok(Self { start_layer, end_layer, model_id })
    }
}

/// El "Pensamiento" que viaja entre nodos.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HiddenStateTensor {
    pub data: Vec<u8>, // Datos binarios del tensor cuantizado
    pub shape: Vec<usize>,
    pub step_id: usize, // Para sincronización de Decoding
}

impl HiddenStateTensor {
    /// Serialización binaria ultra-rápida para transporte WSS
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut buffer = Vec::new();
        // Step ID
        buffer.extend_from_slice(&(self.step_id as u64).to_le_bytes());
        // Shape
        buffer.extend_from_slice(&(self.shape.len() as u32).to_le_bytes());
        for dim in &self.shape {
            buffer.extend_from_slice(&(*dim as u64).to_le_bytes());
        }
        // Data
        buffer.extend_from_slice(&(self.data.len() as u32).to_le_bytes());
        buffer.extend_from_slice(&self.data);

        buffer
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        let mut offset = 0;

        if bytes.len() < 8 + 4 {
            return Err("Buffer demasiado pequeño para HiddenStateTensor".into());
        }

        // Step ID
        let step_id = u64::from_le_bytes(
            bytes[offset..offset + 8].try_into().map_err(|_| "Error leyendo step_id")?,
        ) as usize;
        offset += 8;

        // Shape
        let shape_len = u32::from_le_bytes(
            bytes[offset..offset + 4].try_into().map_err(|_| "Error leyendo shape_len")?,
        ) as usize;
        offset += 4;

        let mut shape = Vec::with_capacity(shape_len);
        for _ in 0..shape_len {
            if bytes.len() < offset + 8 {
                return Err("Buffer incompleto para shape".into());
            }
            shape.push(u64::from_le_bytes(
                bytes[offset..offset + 8].try_into().map_err(|_| "Error leyendo dim")?,
            ) as usize);
            offset += 8;
        }

        // Data
        if bytes.len() < offset + 4 {
            return Err("Buffer incompleto para data_len".into());
        }
        let data_len = u32::from_le_bytes(
            bytes[offset..offset + 4].try_into().map_err(|_| "Error leyendo data_len")?,
        ) as usize;
        offset += 4;

        if bytes.len() < offset + data_len {
            return Err("Buffer incompleto para data".into());
        }
        let data = bytes[offset..offset + data_len].to_vec();

        Ok(Self { data, shape, step_id })
    }
}

/// Dispositivos soportados para la ejecución
#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
pub enum AiDevice {
    Cpu,
    Wgpu,  // WebGPU Backend
    WebNn, // Web Neural Network API (NPU/GPU optimized)
}

impl AiDevice {
    /// Detecta el mejor hardware disponible en el sistema
    pub fn detect() -> Self {
        #[cfg(target_arch = "wasm32")]
        {
            // PRIORIDAD 1: WebNN (NPU/GPU nativo)
            // Es el futuro para dispositivos de consumo con chips de IA.
            // TODO: Agregar chequeo en tiempo de ejecución para navigator.ml
            Self::WebNn
        }

        #[cfg(not(target_arch = "wasm32"))]
        {
            // En Escritorio nativo, por ahora caemos a CPU (Candle prefiere CUDA/Metal/CPU).
            // La prioridad sigue siendo NPU > GPU > CPU a través de los backends.
            Self::Cpu
        }
    }

    /// Retorna un puntaje de prioridad para el ruteador (0 = No usar, 10 = Máximo)
    pub fn priority_score(&self) -> u8 {
        match self {
            Self::WebNn => 10, // NPU
            Self::Wgpu => 7,   // GPU
            Self::Cpu => 1,    // CPU (Evitar excepto para validaciones ligeras)
        }
    }
}

/// Interfaz para motores de IA (Agnóstica)
pub trait AiEngine {
    fn new(device: AiDevice) -> Self
    where
        Self: Sized;

    /// Prepara el motor (compilación de kernels, reservación de memoria)
    /// mientras se recibe el broadcast de tokens para reducir latencia.
    fn prepare(&mut self, stage: &PipelineStage) -> Result<(), String>;

    fn load_shards(&mut self, shards: Vec<Vec<u8>>) -> Result<(), String>;

    fn forward(
        &mut self,
        input: HiddenStateTensor,
        kv_cache: Option<Vec<u8>>,
    ) -> Result<(HiddenStateTensor, Option<Vec<u8>>), String>;

    fn device(&self) -> AiDevice;
}

// TODO: Implementar motores específicos (CandleEngine / BurnEngine)
