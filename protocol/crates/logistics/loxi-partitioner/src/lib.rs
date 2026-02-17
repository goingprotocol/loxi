use loxi_logistics::{PartitionResponse, PartitionerArtifact};
use loxi_wasm_sdk::loxi_worker_wrapper;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub async fn run(problem_json: &str, _context: JsValue) -> Result<String, JsValue> {
    console_error_panic_hook::set_once();
    loxi_worker_wrapper::<PartitionerArtifact>(problem_json).await
}
