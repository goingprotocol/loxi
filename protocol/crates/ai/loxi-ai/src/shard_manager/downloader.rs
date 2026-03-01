use crate::shard_manager::ShardInfo;
use async_trait::async_trait;
use sha2::{Digest, Sha256};

#[derive(Debug)]
pub enum DownloaderError {
    Network(String),
    HashMismatch { expected: String, actual: String },
    Io(String),
}

/// Trait para descargar shards de forma asíncrona.
/// Implementado por diferentes backends (fetch en WASM, reqwest en Native).
#[async_trait]
pub trait ModelDownloader {
    /// Descarga un shard completo.
    async fn download_shard(&self, shard: &ShardInfo) -> Result<Vec<u8>, DownloaderError>;

    /// Descarga solo un rango de bytes (Range Request).
    async fn download_range(
        &self,
        url: &str,
        start: u64,
        end: u64,
    ) -> Result<Vec<u8>, DownloaderError>;
}

pub struct NativeDownloader {
    client: reqwest::Client,
}

impl Default for NativeDownloader {
    fn default() -> Self {
        Self { client: reqwest::Client::new() }
    }
}

#[async_trait]
impl ModelDownloader for NativeDownloader {
    async fn download_shard(&self, shard: &ShardInfo) -> Result<Vec<u8>, DownloaderError> {
        // 1. Intentar leer de la caché
        if let Some(cached_data) = ShardCache::get_cached(&shard.id) {
            // Validar hash de la caché por seguridad
            let mut hasher = Sha256::new();
            hasher.update(&cached_data);
            let actual_hash = hex::encode(hasher.finalize());

            if actual_hash == shard.hash {
                return Ok(cached_data);
            }
        }

        // 2. Si no está en caché o falló el hash, descargar
        let response = self
            .client
            .get(&shard.url)
            .send()
            .await
            .map_err(|e| DownloaderError::Network(e.to_string()))?;

        let bytes =
            response.bytes().await.map_err(|e| DownloaderError::Network(e.to_string()))?.to_vec();

        // 3. Validar Hash de la descarga
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let actual_hash = hex::encode(hasher.finalize());

        if actual_hash != shard.hash {
            return Err(DownloaderError::HashMismatch {
                expected: shard.hash.clone(),
                actual: actual_hash,
            });
        }

        // 4. Guardar en caché para la próxima vez
        let _ = ShardCache::save(&shard.id, &bytes);

        Ok(bytes)
    }

    async fn download_range(
        &self,
        url: &str,
        start: u64,
        end: u64,
    ) -> Result<Vec<u8>, DownloaderError> {
        let range_header = format!("bytes={}-{}", start, end);
        let response = self
            .client
            .get(url)
            .header(reqwest::header::RANGE, range_header)
            .send()
            .await
            .map_err(|e| DownloaderError::Network(e.to_string()))?;

        if !response.status().is_success() {
            return Err(DownloaderError::Network(format!(
                "Failed to download range: HTTP {}",
                response.status()
            )));
        }

        let bytes =
            response.bytes().await.map_err(|e| DownloaderError::Network(e.to_string()))?.to_vec();

        Ok(bytes)
    }
}

pub struct ShardCache;

impl ShardCache {
    fn get_cache_dir() -> std::path::PathBuf {
        std::env::temp_dir().join("loxi-shard-cache")
    }

    pub fn get_cached(shard_id: &str) -> Option<Vec<u8>> {
        let path = Self::get_cache_dir().join(format!("{}.bin", shard_id));
        if path.exists() {
            std::fs::read(path).ok()
        } else {
            None
        }
    }

    pub fn save(shard_id: &str, data: &[u8]) -> Result<(), std::io::Error> {
        let dir = Self::get_cache_dir();
        if !dir.exists() {
            std::fs::create_dir_all(&dir)?;
        }
        let path = dir.join(format!("{}.bin", shard_id));
        std::fs::write(path, data)
    }
}
