use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    console, FileSystemDirectoryHandle, FileSystemFileHandle, FileSystemWritableFileStream,
};

/// Internal helper to get the OPFS Root Directory
async fn get_opfs_root() -> Result<FileSystemDirectoryHandle, JsValue> {
    let window = web_sys::window().unwrap();
    let navigator = window.navigator();
    let storage = navigator.storage();

    let promise = storage.get_directory();
    let root_dir = JsFuture::from(promise).await?.dyn_into::<FileSystemDirectoryHandle>()?;

    Ok(root_dir)
}

/// Helper to recursively traverse/create nested directories in OPFS
async fn ensure_dir_path(
    root: &FileSystemDirectoryHandle,
    path: &str,
) -> Result<FileSystemDirectoryHandle, JsValue> {
    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let mut current_dir = root.clone();

    for part in parts {
        let options = web_sys::FileSystemGetDirectoryOptions::new();
        options.set_create(true);
        let promise = current_dir.get_directory_handle_with_options(part, &options);
        current_dir = JsFuture::from(promise).await?.dyn_into::<FileSystemDirectoryHandle>()?;
    }

    Ok(current_dir)
}

#[wasm_bindgen]
pub struct LoxiOpfsManager;

#[wasm_bindgen]
impl LoxiOpfsManager {
    /// Writes a binary tile slice directly to the browser's Origin Private File System.
    /// Bypasses IndexedDB constraints entirely.
    #[wasm_bindgen]
    pub async fn write_tile(file_path: &str, data: &[u8]) -> Result<(), JsValue> {
        let root = get_opfs_root().await?;

        // Extract directory path and filename
        let mut path_parts: Vec<&str> = file_path.split('/').collect();
        let file_name = path_parts.pop().ok_or_else(|| JsValue::from_str("Invalid tile path"))?;
        let dir_path = path_parts.join("/");

        // Ensure directories exist (e.g., "valhalla_tiles/2/000/014")
        let target_dir =
            if dir_path.is_empty() { root } else { ensure_dir_path(&root, &dir_path).await? };

        // Get File Handle (Create if not exists)
        let file_options = web_sys::FileSystemGetFileOptions::new();
        file_options.set_create(true);
        let file_promise = target_dir.get_file_handle_with_options(file_name, &file_options);
        let file_handle = JsFuture::from(file_promise).await?.dyn_into::<FileSystemFileHandle>()?;

        // Create Writable Stream
        let writable_promise = file_handle.create_writable();
        let writable: FileSystemWritableFileStream =
            JsFuture::from(writable_promise).await?.dyn_into()?;

        // Write binary data
        let uint8_arr = js_sys::Uint8Array::from(data);
        let write_promise = writable.write_with_buffer_source(&uint8_arr)?;
        JsFuture::from(write_promise).await?;

        // Close Stream
        let close_promise = writable.close();
        JsFuture::from(close_promise).await?;

        console::log_1(&format!("💾 [OPFS] Tile saved successfully: {}", file_path).into());
        Ok(())
    }

    /// Checks if a tile exists in OPFS
    #[wasm_bindgen]
    pub async fn tile_exists(file_path: &str) -> Result<bool, JsValue> {
        let root = get_opfs_root().await?;

        let mut path_parts: Vec<&str> = file_path.split('/').collect();
        let file_name = path_parts.pop().ok_or_else(|| JsValue::from_str("Invalid tile path"))?;
        let dir_path = path_parts.join("/");

        let target_dir = match ensure_dir_path(&root, &dir_path).await {
            Ok(dir) => dir,
            Err(_) => return Ok(false),
        };

        let file_options = web_sys::FileSystemGetFileOptions::new();
        file_options.set_create(false);

        match JsFuture::from(target_dir.get_file_handle_with_options(file_name, &file_options))
            .await
        {
            Ok(_) => Ok(true),
            Err(_) => Ok(false),
        }
    }

    /// Reads a tile completely from OPFS into memory.
    /// Used by ValhallaResourceManager.js for regional warmup into MEMFS.
    #[wasm_bindgen]
    pub async fn read_tile(file_path: &str) -> Result<js_sys::Uint8Array, JsValue> {
        let root = get_opfs_root().await?;

        let mut path_parts: Vec<&str> = file_path.split('/').collect();
        let file_name = path_parts.pop().ok_or_else(|| JsValue::from_str("Invalid tile path"))?;
        let dir_path = path_parts.join("/");

        let target_dir = ensure_dir_path(&root, &dir_path).await?;

        let file_options = web_sys::FileSystemGetFileOptions::new();
        file_options.set_create(false);
        let file_promise = target_dir.get_file_handle_with_options(file_name, &file_options);
        let file_handle = JsFuture::from(file_promise).await?.dyn_into::<FileSystemFileHandle>()?;

        let get_file_promise = file_handle.get_file();
        let file: web_sys::File = JsFuture::from(get_file_promise).await?.dyn_into()?;

        let buffer_promise = file.array_buffer();
        let array_buffer = JsFuture::from(buffer_promise).await?;

        Ok(js_sys::Uint8Array::new(&array_buffer))
    }
}
