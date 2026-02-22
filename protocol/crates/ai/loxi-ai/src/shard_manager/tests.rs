#[cfg(test)]
mod tests {
    use crate::shard_manager::*;
    use crate::PipelineStage;

    fn mock_manifest() -> ModelManifest {
        ModelManifest {
            model_info: ModelInfo {
                id: "test-model".into(),
                architecture: "llama".into(),
                hidden_size: 4096,
                num_layers: 2,
                num_experts: None,
            },
            shards: vec![
                ShardInfo {
                    id: "shared-1".into(),
                    shard_type: ShardType::Shared,
                    url: "http://test/shared.bin".into(),
                    hash: "hash1".into(),
                    tensors: vec!["embed".into()],
                },
                ShardInfo {
                    id: "l0-attn".into(),
                    shard_type: ShardType::LayerAttention { layer: 0 },
                    url: "http://test/l0.bin".into(),
                    hash: "hash2".into(),
                    tensors: vec!["l0.attn".into()],
                },
                ShardInfo {
                    id: "l1-attn".into(),
                    shard_type: ShardType::LayerAttention { layer: 1 },
                    url: "http://test/l1.bin".into(),
                    hash: "hash3".into(),
                    tensors: vec!["l1.attn".into()],
                },
            ],
        }
    }

    #[test]
    fn test_shard_resolution() {
        let manifest = mock_manifest();
        let manager = ShardManager::new(manifest);

        let stage = PipelineStage { start_layer: 0, end_layer: 0, model_id: "test".into() };

        let shards = manager.get_shards_for_stage(&stage);

        // Debe tener el shared y la capa 0
        assert!(shards.iter().any(|s| s.id == "shared-1"));
        assert!(shards.iter().any(|s| s.id == "l0-attn"));
        assert!(!shards.iter().any(|s| s.id == "l1-attn"));
    }
}
