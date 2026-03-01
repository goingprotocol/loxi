use crate::shard_manager::{ShardInfo, ShardType};
use serde::{Deserialize, Serialize};

/// Manifiesto privado de una sesión de usuario.
/// Mapea el estado del KV Cache serializado para retomar una conversación.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionManifest {
    pub session_id: String,
    pub user_id: String,
    pub model_id: String,
    /// Shards que contienen el KV Cache serializado por capas.
    pub session_shards: Vec<SessionShard>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionShard {
    pub id: String,
    pub start_layer: usize,
    pub end_layer: usize,
    /// URL donde está guardado el KV Cache cifrado (puede ser local o un relay).
    pub url: String,
    pub hash: String,
}

impl SessionShard {
    /// Convierte un shard de sesión en un ShardInfo genérico para el downloader.
    pub fn to_shard_info(&self) -> ShardInfo {
        ShardInfo {
            id: self.id.clone(),
            shard_type: ShardType::Shared, // Tratamos el KV Cache como data compartida para el downloader
            url: self.url.clone(),
            hash: self.hash.clone(),
            tensors: vec!["kv_cache_slice".to_string()],
        }
    }
}

pub struct SessionManager {
    pub manifest: SessionManifest,
}

impl SessionManager {
    pub fn new(manifest: SessionManifest) -> Self {
        Self { manifest }
    }

    /// Obtiene los shards de sesión necesarios para un rango de capas.
    pub fn get_shards_for_layers(&self, start: usize, end: usize) -> Vec<SessionShard> {
        self.manifest
            .session_shards
            .iter()
            .filter(|s| s.start_layer <= end && s.end_layer >= start)
            .cloned()
            .collect()
    }
}
