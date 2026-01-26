// @ts-check

const CACHE_BUSTER = "?v=" + Date.now();
let wasmModulePromise = null;

export function getWasmModuleCandidates() {
  return [
    new URL("../pkg/loxi_wasm.js" + CACHE_BUSTER, import.meta.url),
    new URL("../crates/loxi-wasm/pkg/loxi_wasm.js" + CACHE_BUSTER, import.meta.url),
    new URL("../wasm/loxi_wasm.js" + CACHE_BUSTER, import.meta.url),
  ];
}

export function getWasmBinaryCandidates() {
  return [
    new URL("../pkg/loxi_wasm_bg.wasm" + CACHE_BUSTER, import.meta.url),
    new URL("../crates/loxi-wasm/pkg/loxi_wasm_bg.wasm" + CACHE_BUSTER, import.meta.url),
    new URL("../wasm/loxi_wasm_bg.wasm" + CACHE_BUSTER, import.meta.url),
  ];
}

export async function loadWasmModule() {
  if (wasmModulePromise) {
    return wasmModulePromise;
  }

  wasmModulePromise = (async () => {
    let lastError = null;
    for (const candidateUrl of getWasmModuleCandidates()) {
      try {
        const mod = await import(candidateUrl.href);
        await mod.default();
        if (typeof mod.init_panic_hook === "function") {
          mod.init_panic_hook();
        }
        return mod;
      } catch (err) {
        lastError = err;
      }
    }

    throw new Error(
      `Failed to load Loxi WASM module. Tried: ${getWasmModuleCandidates()
        .map((u) => u.pathname)
        .join(", ")}. Last error: ${String(lastError)}`
    );
  })();

  return wasmModulePromise;
}


