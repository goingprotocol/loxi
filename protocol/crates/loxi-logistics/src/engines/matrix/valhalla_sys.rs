use std::ffi::{CStr, CString};
use std::os::raw::c_char;

extern "C" {
    // These functions match engines/valhalla/src/binding.cpp
    pub fn init_valhalla(config_path: *const c_char) -> i32;
    pub fn valhalla_matrix(request_json: *const c_char) -> *mut c_char;

    // Standard malloc/free if needed, or we can use the ones from the WASM environment
    pub fn free(ptr: *mut std::ffi::c_void);
}

pub struct ValhallaEngine;

impl ValhallaEngine {
    pub fn init(config_json_path: &str) -> Result<(), String> {
        let path = CString::new(config_json_path).map_err(|e| e.to_string())?;
        let res = unsafe { init_valhalla(path.as_ptr()) };
        if res == 0 {
            Ok(())
        } else {
            Err(format!("Valhalla initialization failed with code: {}", res))
        }
    }

    pub fn matrix(request_json: &str) -> Result<String, String> {
        let req = CString::new(request_json).map_err(|e| e.to_string())?;
        let res_ptr = unsafe { valhalla_matrix(req.as_ptr()) };

        if res_ptr.is_null() {
            return Err("Valhalla matrix returned null pointer".to_string());
        }

        let res_cstr = unsafe { CStr::from_ptr(res_ptr) };
        let res_str = res_cstr.to_string_lossy().into_owned();

        // Critically important: Free the memory allocated by C++ malloc
        unsafe { free(res_ptr as *mut std::ffi::c_void) };

        Ok(res_str)
    }
}
