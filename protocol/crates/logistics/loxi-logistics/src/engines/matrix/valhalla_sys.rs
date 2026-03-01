use wasm_bindgen::prelude::*;

#[wasm_bindgen(inline_js = "
    function getManager() {
        if (typeof window !== 'undefined' && window.ValhallaResourceManager) return window.ValhallaResourceManager;
        if (typeof self !== 'undefined' && self.ValhallaResourceManager) return self.ValhallaResourceManager;
        return null;
    }

    export function js_valhalla_init(config_path) {
        const manager = getManager();
        console.log('🔍 [Bridge] Checking Valhalla Manager:', manager);
        if (manager) {
            console.log('🔍 [Bridge] Manager keys:', Object.keys(manager));
            console.log('🔍 [Bridge] Manager module:', manager.module);
        } else {
             console.log('🔍 [Bridge] Manager is NULL. self keys:', Object.keys(self));
        }

        // If manager exists and has a module, we consider it initialized.
        if (manager && manager.module) return 0;
        console.error('❌ Valhalla Bridge: ValhallaResourceManager not ready or module not loaded.');
        return 1;
    }

    export function js_valhalla_matrix(request_json) {
        const manager = getManager();
        if (!manager || !manager.module) throw new Error('Valhalla Engine not initialized (Manager missing)');
        
        console.log(`⚡️ [Bridge] Calling C++ valhalla_matrix (Optimized). Request length: ${request_json.length}`);
        const start = performance.now();

        // 1. Get raw pointer
        const ptr = manager.module.ccall(
            'valhalla_matrix',
            'number',
            ['string'],
            [request_json]
        );
        
        if (ptr === 0) throw new Error('Valhalla returned NULL pointer');

        // 2. Get length directly from C++ (No while loop!)
        const len = manager.module._get_last_matrix_len();

        const duration = (performance.now() - start).toFixed(2);
        const unsignedPtr = ptr >>> 0;
        
        // Debug: Look at the first 50 chars to see if it's JSON or garbage
        const preview = manager.module.UTF8ToString(ptr, 50);
        console.log(`✅ [Bridge] C++ finished in ${duration}ms. Ptr: ${unsignedPtr} (${ptr}), Len: ${len}. Status: OK`);
        console.log(`📝 [Bridge] Preview: ${preview}`);
        
        return {
            ptr: unsignedPtr,
            len: len,
            buffer: manager.module.HEAPU8.buffer
        };
    }

    export function js_valhalla_route(request_json) {
        const manager = getManager();
        if (!manager || !manager.module) throw new Error('Valhalla Engine not initialized (Manager missing)');
        
        console.log(`⚡️ [Bridge] Calling C++ valhalla_route. Request length: ${request_json.length}`);
        const start = performance.now();
        const res = manager.module.ccall(
            'valhalla_route',
            'string',
            ['string'],
            [request_json]
        );
        const duration = (performance.now() - start).toFixed(2);
        console.log(`✅ [Bridge] C++ valhalla_route finished in ${duration}ms. Result length: ${res?.length || 0}`);
        return res;
    }
")]
extern "C" {
    #[wasm_bindgen(js_name = "js_valhalla_init")]
    pub fn js_valhalla_init(config_path: &str) -> i32;

    #[wasm_bindgen(js_name = "js_valhalla_matrix")]
    pub fn js_valhalla_matrix(request_json: &str) -> JsValue;

    #[wasm_bindgen(js_name = "js_valhalla_route")]
    pub fn js_valhalla_route(request_json: &str) -> String;
}

pub struct ValhallaEngine;

impl ValhallaEngine {
    pub fn init(config_json_path: &str) -> Result<(), String> {
        let res = js_valhalla_init(config_json_path);
        if res == 0 {
            Ok(())
        } else {
            Err(format!("Valhalla initialization failed with code: {}", res))
        }
    }

    pub fn matrix(request_json: &str) -> Result<Vec<u8>, String> {
        let res_js = js_valhalla_matrix(request_json);

        if res_js.is_undefined() || res_js.is_null() {
            return Err("Valhalla matrix returned null/undefined".to_string());
        }

        // Extract Pointer Info from JS Object
        let ptr = js_sys::Reflect::get(&res_js, &"ptr".into())
            .map_err(|_| "Failed to get ptr")?
            .as_f64()
            .ok_or("ptr is not a number")? as u32;

        let len = js_sys::Reflect::get(&res_js, &"len".into())
            .map_err(|_| "Failed to get len")?
            .as_f64()
            .ok_or("len is not a number")? as u32;

        let buffer =
            js_sys::Reflect::get(&res_js, &"buffer".into()).map_err(|_| "Failed to get buffer")?;

        let buffer_obj = js_sys::Object::from(buffer);

        // Create a view of the C++ Heap buffer
        let cpp_view = js_sys::Uint8Array::new_with_byte_offset_and_length(&buffer_obj, ptr, len);

        // Pre-allocate Rust Memory (Single Allocation)
        let mut rust_vec = vec![0u8; len as usize];

        // Perform the copy (Memory-to-Memory within WASM environment)
        cpp_view.copy_to(&mut rust_vec);

        if rust_vec.is_empty() {
            return Err("Valhalla matrix returned empty result (0 bytes)".to_string());
        }

        Ok(rust_vec)
    }

    pub fn route(request_json: &str) -> Result<Vec<u8>, String> {
        let res = js_valhalla_route(request_json);
        if res.is_empty() {
            return Err("Valhalla route returned empty result".to_string());
        }
        Ok(res.into_bytes())
    }
}
