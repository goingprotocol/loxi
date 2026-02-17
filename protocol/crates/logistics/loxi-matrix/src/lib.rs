use loxi_logistics::MatrixArtifact;
use loxi_wasm_sdk::loxi_worker_wrapper;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub async fn run_matrix(problem_json: &str, _context: JsValue) -> Result<String, JsValue> {
    console_error_panic_hook::set_once();
    loxi_worker_wrapper::<MatrixArtifact>(problem_json).await
}

#[wasm_bindgen]
pub async fn run_routes(routes_json: &str, _context: JsValue) -> Result<String, JsValue> {
    console_error_panic_hook::set_once();
    let res_bytes = loxi_logistics::engines::matrix::MatrixEngine::calculate_route(routes_json)
        .map_err(|e| JsValue::from_str(&e))?;
    String::from_utf8(res_bytes).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn init_engine(config_json_path: &str) -> Result<(), JsValue> {
    loxi_logistics::engines::matrix::MatrixEngine::init(config_json_path)
        .map_err(|e| JsValue::from_str(&e))
}
