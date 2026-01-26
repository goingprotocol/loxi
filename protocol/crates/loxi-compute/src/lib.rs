use rayon::prelude::*;
use wasm_bindgen::prelude::*;

// Expose the thread pool initialization from wasm-bindgen-rayon
pub use wasm_bindgen_rayon::init_thread_pool;

#[wasm_bindgen]
pub fn setup_panic_hook() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn heavy_compute(matrix_size: usize, iterations: usize) -> u64 {
    // 1. Create a large vector to simulate data
    // 2. Process it in parallel using Rayon
    (0..matrix_size)
        .into_par_iter()
        .map(|i| {
            let mut val = i as u64;
            // CPU Burner Loop
            for _ in 0..iterations {
                val = val.wrapping_mul(1664525).wrapping_add(1013904223); // Linear Congruential Generator
            }
            val
        })
        .sum()
}
