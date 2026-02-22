use serde::{Deserialize, Serialize};
use std::fmt::Debug;
use thiserror::Error;

/// Defines the types of payloads that can travel through the P2P Loxi-Net.
/// Bincode will efficiently pack these enums into absolute minimal binary sizes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NetPayload {
    /// 🚀 Used for AI Heterogeneous Routing (MoE).
    /// Sends a tensor slice to a remote expert.
    Tensor { expert_id: u32, data: Vec<f32> },
    /// 📦 Used for Logistics Solvers (VRP / Matrix).
    /// Bypasses JSON entirely, sending the raw encoded struct.
    LogisticsProblem { solver_type: String, binary_data: Vec<u8> },
    /// 🤝 Used for Engine Orchestration (Handshakes, Ping).
    Ping { timestamp: u64 },
}

#[derive(Error, Debug)]
pub enum NetError {
    #[error("Serialization failed: {0}")]
    Serialization(String),
    #[error("Transport failed: {0}")]
    Transport(String),
    #[error("Timeout waiting for response")]
    Timeout,
}

/// The Universal Transport Trait.
/// - In Native (`loxi-node`), this is implemented over `UdpSocket` or `quinn::Connection`.
/// - In Browser (`loxi.ai`), this is implemented over `web_sys::RtcDataChannel`.
#[async_trait::async_trait(?Send)]
pub trait LoxiTransport {
    /// Connect to a remote endpoint (IP/Port for UDP, or PeerID for WebRTC).
    async fn connect(&mut self, endpoint: &str) -> Result<(), NetError>;

    /// Send a payload and wait for the binary response.
    async fn send_and_receive(&self, payload: NetPayload) -> Result<NetPayload, NetError>;

    /// Fire and forget a payload.
    async fn send(&self, payload: NetPayload) -> Result<(), NetError>;
}
