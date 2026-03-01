use std::env;

fn main() {
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();

    println!("cargo:warning=Detected TARGET_ARCH: {}", target_arch);

    // Static linking for Valhalla disabled in favor of Modular-Unified JS Bridge.
    // This avoids linker errors caused by Emscripten vs wasm32-unknown-unknown incompatibilities.
}
