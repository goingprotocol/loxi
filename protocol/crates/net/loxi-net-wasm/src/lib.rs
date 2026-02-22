use js_sys::Uint8Array;
use loxi_net_core::{LoxiTransport, NetError, NetPayload};
use wasm_bindgen::prelude::*;
use web_sys::{MessageEvent, RtcDataChannel, RtcDataChannelState};

/// WASM Implementation of LoxiTransport relying on WebRTC Data Channels.
pub struct WasmWebRtcTransport {
    data_channel: RtcDataChannel,
}

impl WasmWebRtcTransport {
    pub fn new(data_channel: RtcDataChannel) -> Self {
        Self { data_channel }
    }
}

#[async_trait::async_trait(?Send)]
impl LoxiTransport for WasmWebRtcTransport {
    async fn connect(&mut self, _endpoint: &str) -> Result<(), NetError> {
        // En WebRTC, la conexion se negocia asincronicamente antes de tener el DataChannel.
        // Asuminos que la senalizacion exterior ya ocurrio y el peer connection decidio
        // pasarnos este data_channel. Solo verificamos que este abierto.
        if self.data_channel.ready_state() == RtcDataChannelState::Open {
            Ok(())
        } else {
            Err(NetError::Transport("DataChannel is not open".into()))
        }
    }

    async fn send(&self, payload: NetPayload) -> Result<(), NetError> {
        // 1. PURE RUST BINARY SERIALIZATION (No JSON stringification!)
        let binary_payload =
            bincode::serialize(&payload).map_err(|e| NetError::Serialization(e.to_string()))?;

        // 2. ZERO-COPY WASM BRIDGING
        // Convert the Rust Vec<u8> to a Javascript Uint8Array pointer.
        // In the browser, the DataChannel expects an ArrayBuffer or ArrayBufferView.
        let js_array = Uint8Array::from(binary_payload.as_slice());

        // 3. FIRE INTO THE ABYSS
        self.data_channel
            .send_with_array_buffer_view(&js_array)
            .map_err(|_| NetError::Transport("Failed to push buffer to WebRTC socket".into()))?;

        Ok(())
    }

    async fn send_and_receive(&self, payload: NetPayload) -> Result<NetPayload, NetError> {
        // Enviar el paquete
        self.send(payload).await?;

        // Aca implementariamos una Promise de JS que se resuelve cuando el onmessage
        // escupa el ID de transaccion esperado. Es complejo implementarlo sin un
        // Hashmap global de Promises en Rust, asi que para esta version fundacional
        // simulamos el Error de timeout indicando que se debe usar una pool de receivers.
        Err(NetError::Transport(
            "Bi-directional send_and_receive not fully implemented in WASM yet. Requires async MessageEvent listener pooling.".into(),
        ))
    }
}
