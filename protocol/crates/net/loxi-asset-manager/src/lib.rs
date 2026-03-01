pub mod opfs;

use bincode;
use js_sys::Uint8Array;
use loxi_net_core::NetPayload;
use wasm_bindgen::prelude::*;
use web_sys::{console, BinaryType, CloseEvent, ErrorEvent, MessageEvent, WebSocket};

#[wasm_bindgen]
pub struct LoxiAssetManager {
    ws: WebSocket,
}

#[wasm_bindgen]
impl LoxiAssetManager {
    /// Initializes the Rust Bootstrap and connects immediately to the Orchestrator
    #[wasm_bindgen(constructor)]
    pub fn new(url: &str) -> Result<LoxiAssetManager, JsValue> {
        console::log_1(&"🚀 [LoxiAssetManager] Bootstrapping native binary socket...".into());

        let ws = WebSocket::new(url)?;
        // CRITICAL: We want raw ArrayBuffers, not Blobs, to bypass JS FileReader overhead
        ws.set_binary_type(BinaryType::Arraybuffer);

        // --- Setup Callbacks ---
        let onopen_callback = Closure::<dyn FnMut()>::new(move || {
            console::log_1(&"✅ [LoxiAssetManager] Binary WebSocket Connected.".into());
        });
        ws.set_onopen(Some(onopen_callback.as_ref().unchecked_ref()));
        onopen_callback.forget();

        let onerror_callback = Closure::<dyn FnMut(ErrorEvent)>::new(move |e: ErrorEvent| {
            console::error_2(&"❌ [LoxiAssetManager] Socket Error:".into(), &e.into());
        });
        ws.set_onerror(Some(onerror_callback.as_ref().unchecked_ref()));
        onerror_callback.forget();

        let onclose_callback = Closure::<dyn FnMut(CloseEvent)>::new(move |e: CloseEvent| {
            console::log_2(&"🛑 [LoxiAssetManager] Socket Closed:".into(), &e.reason().into());
        });
        ws.set_onclose(Some(onclose_callback.as_ref().unchecked_ref()));
        onclose_callback.forget();

        // --- MAIN INCOMING MESSAGE ROUTER ---
        let onmessage_callback = Closure::<dyn FnMut(MessageEvent)>::new(move |e: MessageEvent| {
            // If the Orchestrator sent text, it's a legacy or metadata message.
            if let Ok(txt) = e.data().dyn_into::<js_sys::JsString>() {
                console::log_2(&"📩 [LoxiAssetManager] Text Message:".into(), &txt);
            }
            // If the Orchestrator sent pure binary, process it natively
            else if let Ok(buf) = e.data().dyn_into::<js_sys::ArrayBuffer>() {
                console::log_1(
                    &"⚡️ [LoxiAssetManager] Received Binary Payload from Orchestrator!".into(),
                );

                let array = Uint8Array::new(&buf);
                let rust_vec = array.to_vec();

                match bincode::deserialize::<NetPayload>(&rust_vec) {
                    Ok(payload) => {
                        console::log_1(
                            &"✅ [LoxiAssetManager] Payload Decoded! Routing directly to Worker..."
                                .into(),
                        );

                        match payload {
                            NetPayload::LogisticsProblem { solver_type, binary_data } => {
                                if solver_type == "vrp" {
                                    // 1. Spawn the VRP WebWorker
                                    match web_sys::Worker::new("assets/pkg/vrp/worker.js") {
                                        Ok(worker) => {
                                            // 2. Wrap the extracted bytes in a JS ArrayBuffer
                                            let vrp_array =
                                                Uint8Array::from(binary_data.as_slice());
                                            let vrp_buffer = vrp_array.buffer();

                                            // 3. Create Transferable Objects Array
                                            let transfer_array = js_sys::Array::new();
                                            transfer_array.push(&vrp_buffer);

                                            // 4. Zero-Copy Transfer to the Worker
                                            if let Err(e) = worker.post_message_with_transfer(
                                                &vrp_buffer,
                                                &transfer_array,
                                            ) {
                                                console::error_2(&"❌ [LoxiAssetManager] Failed to transfer payload to VRP Worker".into(), &e);
                                            } else {
                                                console::log_1(&"🚀 [LoxiAssetManager] Binary payload transferred to VRP Worker (Zero-Copy)!".into());
                                            }
                                        }
                                        Err(e) => console::error_2(
                                            &"❌ [LoxiAssetManager] Failed to spawn VRP Worker"
                                                .into(),
                                            &e,
                                        ),
                                    }
                                } else {
                                    console::warn_1(
                                        &format!(
                                            "⚠️ [LoxiAssetManager] Unhandled solver type: {}",
                                            solver_type
                                        )
                                        .into(),
                                    );
                                }
                            }
                            // Matrix / AI / Handshake handling later...
                            _ => {
                                console::warn_1(
                                    &"⚠️ [LoxiAssetManager] Unhandled NetPayload format".into(),
                                );
                            }
                        }
                    }
                    Err(err) => {
                        console::error_1(
                            &format!(
                                "❌ [LoxiAssetManager] Bincode deserialization failed: {}",
                                err
                            )
                            .into(),
                        );
                    }
                }
            } else {
                console::warn_1(&"⚠️ [LoxiAssetManager] Received unknown message format.".into());
            }
        });
        ws.set_onmessage(Some(onmessage_callback.as_ref().unchecked_ref()));
        onmessage_callback.forget();

        Ok(LoxiAssetManager { ws })
    }

    /// Expose native binary sending to JS in case the React UI needs to send an instruction
    #[wasm_bindgen]
    pub fn send_payload(&self, _payload: JsValue) -> Result<(), JsValue> {
        // Here we can take a JS JSON object, convert it to Rust NetPayload, serialize to Bincode, and send.
        // For now, this is a placeholder.
        Ok(())
    }
}
