use loxi_logistics::VrpArtifact;
use loxi_wasm_sdk::loxi_worker_wrapper;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub async fn run(problem_json: &str, _context: JsValue) -> Result<String, JsValue> {
    console_error_panic_hook::set_once();
    loxi_worker_wrapper::<VrpArtifact>(problem_json).await
}

#[wasm_bindgen]
pub async fn run_binary(problem_bytes: &[u8], _context: JsValue) -> Result<Vec<u8>, JsValue> {
    console_error_panic_hook::set_once();
    loxi_wasm_sdk::loxi_worker_wrapper_binary::<VrpArtifact>(problem_bytes).await
}
