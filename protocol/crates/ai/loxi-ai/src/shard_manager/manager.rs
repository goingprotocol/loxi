use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Representa el manifiesto completo de un modelo de IA distribuido.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelManifest {
    pub model_info: ModelInfo,
    pub shards: Vec<ShardInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelInfo {
    pub id: String,
    pub architecture: String,
    pub hidden_size: usize,
    pub num_layers: usize,
    #[serde(default)]
    pub num_experts: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ShardInfo {
    pub id: String,
    pub shard_type: ShardType,
    pub url: String,
    pub hash: String,
    pub tensors: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ShardType {
    Shared,
    LayerAttention { layer: usize },
    LayerExpert { layer: usize, expert: usize },
    FinalNorm,
}

/// Gestor de shards que permite mapear tensores a sus archivos correspondientes.
pub struct ShardManager {
    manifest: ModelManifest,
    tensor_map: HashMap<String, String>, // tensor_name -> shard_id
    session_manager: Option<super::session::SessionManager>,
}

impl ShardManager {
    pub fn new(manifest: ModelManifest) -> Self {
        let mut tensor_map = HashMap::new();
        for shard in &manifest.shards {
            for tensor in &shard.tensors {
                tensor_map.insert(tensor.clone(), shard.id.clone());
            }
        }
        Self { manifest, tensor_map, session_manager: None }
    }

    pub fn with_session(mut self, session: super::session::SessionManager) -> Self {
        self.session_manager = Some(session);
        self
    }

    pub fn get_shard_info(&self, shard_id: &str) -> Option<&ShardInfo> {
        self.manifest.shards.iter().find(|s| s.id == shard_id)
    }

    /// Encuentra todos los shards necesarios para cubrir un rango de capas.
    /// Encuentra todos los shards necesarios (Pesos + Recuerdos de Sesión).
    pub fn get_shards_for_stage(&self, stage: &super::super::PipelineStage) -> Vec<ShardInfo> {
        let mut needed_shards = Vec::new();
        let mut seen_shards = std::collections::HashSet::new();

        // 1. Shards del Modelo (Pesos)
        for shard in &self.manifest.shards {
            let is_needed = match &shard.shard_type {
                ShardType::Shared => true,
                ShardType::LayerAttention { layer } => {
                    *layer >= stage.start_layer && *layer <= stage.end_layer
                }
                ShardType::LayerExpert { layer, .. } => {
                    *layer >= stage.start_layer && *layer <= stage.end_layer
                }
                ShardType::FinalNorm => true,
            };

            if is_needed && !seen_shards.contains(&shard.id) {
                seen_shards.insert(shard.id.clone());
                needed_shards.push(shard.clone());
            }
        }

        // 2. Shards de Sesión (Recuerdos / KV Cache)
        if let Some(sm) = &self.session_manager {
            let session_shards = sm.get_shards_for_layers(stage.start_layer, stage.end_layer);
            for ss in session_shards {
                let info = ss.to_shard_info();
                if !seen_shards.contains(&info.id) {
                    seen_shards.insert(info.id.clone());
                    needed_shards.push(info);
                }
            }
        }

        needed_shards
    }

    pub fn find_shard_for_tensor(&self, tensor_name: &str) -> Option<&ShardInfo> {
        let shard_id = self.tensor_map.get(tensor_name)?;
        self.get_shard_info(shard_id)
    }
}
