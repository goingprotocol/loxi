use crate::{AiDevice, AiEngine, HiddenStateTensor, PipelineStage};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    // Definimos las bindings base para WebNN ML context
    // Nota: Esto es experimental y requiere flags en el navegador
    #[wasm_bindgen(js_namespace = navigator, js_name = ml)]
    static ML: JsValue;
}

pub struct WebNnEngine {
    device: AiDevice,
    // Aquí guardaremos el MLContext y el Graph una vez compilado
}

impl AiEngine for WebNnEngine {
    fn new(device: AiDevice) -> Self {
        Self { device }
    }

    fn prepare(&mut self, _stage: &PipelineStage) -> Result<(), String> {
        // 1. Verificar si navigator.ml está disponible
        // 2. Crear un MLContext (GPU o NPU)
        // 3. Preparar el grafo (MLGraphBuilder)
        Ok(())
    }

    fn load_shards(&mut self, _shards: Vec<Vec<u8>>) -> Result<(), String> {
        // Carga los pesos en constantes de WebNN
        Ok(())
    }

    fn forward(
        &mut self,
        _input: HiddenStateTensor,
        _kv_cache: Option<Vec<u8>>,
    ) -> Result<(HiddenStateTensor, Option<Vec<u8>>), String> {
        // Ejecuta el grafo compilado (Compute)
        Err("WebNnEngine::forward no implementado aún".to_string())
    }

    fn device(&self) -> AiDevice {
        self.device
    }
}
