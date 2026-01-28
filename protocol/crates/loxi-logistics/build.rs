use std::env;
use std::path::PathBuf;

fn main() {
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let _target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    if target_arch == "wasm32" || target_arch == "wasm64" {
        let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
        let libs_dir = manifest_dir.join("libs").join(&target_arch);

        println!("cargo:rustc-link-search=native={}", libs_dir.display());

        // Link order is critical for static libraries
        println!("cargo:rustc-link-lib=static=valhalla_binding");
        println!("cargo:rustc-link-lib=static=valhalla");
        println!("cargo:rustc-link-lib=static=protobuf");
        println!("cargo:rustc-link-lib=static=geos_c");
        println!("cargo:rustc-link-lib=static=geos");
        println!("cargo:rustc-link-lib=static=lz4");
        println!("cargo:rustc-link-lib=static=sqlite3");
        println!("cargo:rustc-link-lib=static=z");

        // Note: C++ runtime support (libc++, etc) is usually provided by the WASM linker
        // or through external imports when using wasm-bindgen.
    }
}
