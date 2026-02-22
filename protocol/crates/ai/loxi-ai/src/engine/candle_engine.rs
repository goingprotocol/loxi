use crate::{AiDevice, AiEngine, HiddenStateTensor, PipelineStage};
use candle_core::Device;

pub struct CandleEngine {
    device: Device,
    ai_device: AiDevice,
}

impl AiEngine for CandleEngine {
    fn new(ai_device: AiDevice) -> Self {
        let device = match ai_device {
            AiDevice::Cpu | AiDevice::Wgpu | AiDevice::WebNn => {
                // Candle usa 'cuda' o 'metal' nativamente en desktop
                // Para WGPU o WebNN en WASM/Desktop, se usa una abstracción diferente
                // o se cae a CPU dentro de este motor si no es su responsabilidad.
                Device::Cpu
            }
        };

        Self { device, ai_device }
    }

    fn prepare(&mut self, _stage: &PipelineStage) -> Result<(), String> {
        // Reservado para compilación de kernels en WGPU
        Ok(())
    }

    fn load_shards(&mut self, _shards: Vec<Vec<u8>>) -> Result<(), String> {
        // TODO: Implementar carga de safetensors
        Ok(())
    }

    fn forward(
        &mut self,
        _input: HiddenStateTensor,
        _kv_cache: Option<Vec<u8>>,
    ) -> Result<(HiddenStateTensor, Option<Vec<u8>>), String> {
        // TODO: Implementar inferencia real con Candle
        Err("Inferencia no implementada aún".to_string())
    }

    fn device(&self) -> AiDevice {
        self.ai_device
    }
}
