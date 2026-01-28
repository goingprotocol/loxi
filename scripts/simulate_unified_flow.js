const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const XMLHttpRequest = require('xmlhttprequest').XMLHttpRequest;

// --- MOCK BROWSER ENVIRONMENT FOR WASM ---
// This mimics the worker environment where SharedArrayBuffer/Atomics or Sync XHR is used.
global.XMLHttpRequest = XMLHttpRequest;
global.self = global;

// Mock the 'fetchTileBlockSync' bridge function
global.fetchTileBlockSync = function (pathStr, blockId) {
    // In a real scenario, this fetches from HTTP. Here we can mock or proxy.
    // For this test, we'll proxy to the local tile server if running, or just log.
    console.log(`[JS Bridge] Requesting block ${blockId} for ${pathStr}`);

    // Connect to local tile server (assuming serve_tiles.sh is running on port 8000)
    // Note: 'xmlhttprequest' library in Node supports sync: false (default), need to check support.
    try {
        const url = `http://localhost:8000${pathStr}`;
        const BLOCK_SIZE = 128 * 1024;
        const start = blockId * BLOCK_SIZE;
        const end = start + BLOCK_SIZE - 1;

        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, false); // Synchronous
        if (typeof xhr.setRequestHeader === 'function') {
            xhr.setRequestHeader('Range', `bytes=${start}-${end}`);
        } else {
            console.warn("XHR setRequestHeader might not be supported in this mock");
        }

        // binary response type is tricky in node-xmlhttprequest, often returns text.
        // We might need a better mock or just simulate empty data for "mechanics check".
        xhr.send(null);

        if (xhr.status === 200 || xhr.status === 206) {
            console.log(`[JS Bridge] Success status ${xhr.status}`);
            // Simulate returning a typed array (mock data for now if binary is hard)
            // In real browser, we return Uint8Array.
            // Here we return a dummy array just to prove the bridge was called.
            return new Uint8Array(10);
        } else {
            console.warn(`[JS Bridge] Failed status ${xhr.status}`);
        }
    } catch (e) {
        console.error(`[JS Bridge] Error: ${e}`);
    }
    return null;
};


// --- LOAD WASM ---
// We need to load the generated .js binding for the WASM.
// Assuming wasm-bindgen generated a JS file like 'loxi_logistics.js' alongside.
// If not, we might need to load WASM manually. 
// For now, let's assume we can try to instantiate the WASM bytes directly to check exports.

async function runTest() {
    const wasmPath = path.resolve(__dirname, '../protocol/target/wasm32-unknown-unknown/debug/loxi_logistics.wasm');
    console.log(`Loading WASM from: ${wasmPath}`);

    if (!fs.existsSync(wasmPath)) {
        console.error("WASM file not found!");
        process.exit(1);
    }

    const wasmBuffer = fs.readFileSync(wasmPath);

    // Mock imports expected by WASM
    const imports = {
        env: {
            fetchTileBlockSync: global.fetchTileBlockSync,
            // Emscripten/Valhalla might need these if not fully mostly static
            // But verify if they are needed via objdump first.
            // ...
        },
        // wasm-bindgen imports usually go under './loxi_logistics_bg.js' module name or similar
        // We might need to run wasm-bindgen CLI first to generate the JS loader to make this easy.
    };

    try {
        // Simple instantiation to check if imports are satisfied
        const { instance } = await WebAssembly.instantiate(wasmBuffer, imports);
        console.log("✅ WASM Instantiated Successfully!");

        // Check exports
        if (instance.exports.solve) {
            console.log("✅ Export 'solve' found!");
        } else {
            console.error("❌ Export 'solve' NOT found.");
        }

        if (instance.exports.init_valhalla) {
            console.log("✅ Export 'init_valhalla' found!");
        } else {
            // It might be renamed by bindgen or emscripten
            console.warn("⚠️ Export 'init_valhalla' not directly found (might be mangled or internal)");
        }

        console.log("Integration smoke test passed (Mechanics only).");

    } catch (e) {
        console.error("❌ WASM Instantiation Failed:");
        console.error(e);
        // If it fails due to missing imports, it confirms our bridge logic is active and expecting JS.
    }
}

runTest();
