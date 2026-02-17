#![cfg(target_arch = "wasm32")]

use std::alloc::{Layout, System};

// We use the System allocator (which on wasm32-unknown-unknown defaults to dl_malloc or similar provided by Rust)
#[global_allocator]
static A: System = System;

// Header size for tracking allocation size
const HEADER_SIZE: usize = 8; // u64 size

#[no_mangle]
pub unsafe extern "C" fn malloc(size: usize) -> *mut u8 {
    let layout = Layout::from_size_align(size + HEADER_SIZE, 8).unwrap();
    let ptr = std::alloc::alloc(layout);

    if ptr.is_null() {
        return std::ptr::null_mut();
    }

    // Store size in the header
    *(ptr as *mut usize) = size;

    // Return pointer after header
    ptr.add(HEADER_SIZE)
}

#[no_mangle]
pub unsafe extern "C" fn free(ptr: *mut u8) {
    if ptr.is_null() {
        return;
    }

    // Recover header
    let real_ptr = ptr.sub(HEADER_SIZE);
    let size = *(real_ptr as *const usize);

    let layout = Layout::from_size_align(size + HEADER_SIZE, 8).unwrap();
    std::alloc::dealloc(real_ptr, layout);
}

#[no_mangle]
pub unsafe extern "C" fn calloc(nmemb: usize, size: usize) -> *mut u8 {
    let total_size = nmemb * size;
    let ptr = malloc(total_size);
    if !ptr.is_null() {
        std::ptr::write_bytes(ptr, 0, total_size);
    }
    ptr
}

#[no_mangle]
pub unsafe extern "C" fn realloc(ptr: *mut u8, new_size: usize) -> *mut u8 {
    if ptr.is_null() {
        return malloc(new_size);
    }

    if new_size == 0 {
        free(ptr);
        return std::ptr::null_mut();
    }

    // Recover old size
    let real_ptr = ptr.sub(HEADER_SIZE);
    let old_size = *(real_ptr as *const usize);

    // If new size is same, do nothing
    if new_size <= old_size {
        return ptr;
    }

    // Create new allocation
    let new_ptr = malloc(new_size);
    if !new_ptr.is_null() {
        // Copy old data
        std::ptr::copy_nonoverlapping(ptr, new_ptr, old_size);
        free(ptr);
    }
    new_ptr
}
