use lru::LruCache;
use std::num::NonZeroUsize;
use std::sync::Mutex;
use wasm_bindgen::prelude::*;

// --- BLOCK CACHE CONFIG ---
const BLOCK_SIZE: usize = 128 * 1024; // 128KB matching JS prototype
const MAX_CACHE_SIZE: usize = 256; // Number of blocks to keep (~32MB)

#[wasm_bindgen]
extern "C" {
    // This JS function must perform a SYNC fetch using SharedArrayBuffer/Atomics
    // or be implemented in a way that blocks the WASM thread.
    #[wasm_bindgen(js_name = "fetchTileBlockSync")]
    fn fetch_tile_block_sync(path: &str, block_id: u32) -> JsValue;
}

struct Block {
    data: Vec<u8>,
}

lazy_static::lazy_static! {
    static ref CACHE: Mutex<LruCache<String, Block>> = Mutex::new(
        LruCache::new(NonZeroUsize::new(MAX_CACHE_SIZE).unwrap())
    );
}

pub struct LazyFs;

impl LazyFs {
    pub fn read_at(path: &str, offset: u64, length: usize) -> Result<Vec<u8>, String> {
        let block_id = (offset / BLOCK_SIZE as u64) as u32;
        let block_offset = (offset % BLOCK_SIZE as u64) as usize;

        let cache_key = format!("{}:{}", path, block_id);

        // 1. Check Cache with LRU update (Get or Fetch)
        let mut cache = CACHE.lock().map_err(|e| e.to_string())?;

        if !cache.contains(&cache_key) {
            // Cache Miss: Drop lock before JS call to avoid deadlocks (though JS is sync here)
            drop(cache);

            let js_val = fetch_tile_block_sync(path, block_id);
            if js_val.is_null() || js_val.is_undefined() {
                return Err(format!("Failed to fetch block {} for {}", block_id, path));
            }

            let data: Vec<u8> = serde_wasm_bindgen::from_value(js_val)
                .map_err(|e| format!("Invalid data from JS bridge: {}", e))?;

            // Re-acquire lock to insert
            let mut cache_re = CACHE.lock().map_err(|e| e.to_string())?;
            cache_re.put(cache_key.clone(), Block { data });
            cache = cache_re;
        }

        // 2. Read from Cache (LRU marked by .get)
        if let Some(block) = cache.get(&cache_key) {
            let end = (block_offset + length).min(block.data.len());
            if block_offset >= block.data.len() {
                return Ok(vec![]);
            }
            Ok(block.data[block_offset..end].to_vec())
        } else {
            Err("Block disappeared from cache unexpectedly".to_string())
        }
    }
}

// --- FFI EXPORTS FOR C++ ---

#[no_mangle]
pub extern "C" fn rust_lazy_fs_read(
    path_ptr: *const std::os::raw::c_char,
    offset: u64,
    length: usize,
    out_ptr: *mut u8,
) -> i32 {
    let path_cstr = unsafe { std::ffi::CStr::from_ptr(path_ptr) };
    let path = path_cstr.to_string_lossy();

    match LazyFs::read_at(&path, offset, length) {
        Ok(data) => {
            unsafe {
                std::ptr::copy_nonoverlapping(data.as_ptr(), out_ptr, data.len());
            }
            data.len() as i32
        }
        Err(_) => -1,
    }
}
