const fs = require('fs');
const path = require('path');

// Path to the generated files
const pkgDir = path.resolve(__dirname, '../protocol/target/wasm32-unknown-emscripten/debug/pkg');
const jsPath = path.join(pkgDir, 'loxi_logistics.js');
const wasmPath = path.join(pkgDir, 'loxi_logistics.wasm');

console.log('--- Loxi Unified Engine Verification (WASM32) ---');

// Mock XMLHttpRequest for synchronous tile fetching (needed by Valhalla)
// In a real browser/worker environment, we use http_fs.js. 
// For Node.js testing, we can either use a local path or mock XHR.
global.XMLHttpRequest = function () {
    this.open = function (method, url, async) {
        this.url = url;
    };
    this.send = function () {
        try {
            // Convert URL to local path if needed, for now just try to read
            const filePath = path.join(__dirname, '../protocol/crates/loxi-logistics/tiles', this.url.replace(/^\//, ''));
            if (fs.existsSync(filePath)) {
                const data = fs.readFileSync(filePath);
                this.status = 200;
                this.response = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
                this.responseText = data.toString();
            } else {
                this.status = 404;
            }
        } catch (e) {
            this.status = 500;
        }
    };
};

// Load the Emscripten module
const Module = require(jsPath);

Module.onRuntimeInitialized = () => {
    console.log('✅ Emscripten Runtime Initialized');

    try {
        // 1. Initialize Valhalla (C++ side)
        // We need a config JSON. For testing, a minimal one.
        const config = JSON.stringify({
            mjolnir: {
                tile_dir: "/tiles", // This would be mounted in FS
                hierarchy_limit: 1
            }
        });

        /*
        console.log('Testing init_valhalla...');
        const configStr = config;
        const configLen = Module.lengthBytesUTF8(configStr) + 1;
        const configPtr = Module._malloc(configLen);
        Module.stringToUTF8(configStr, configPtr, configLen);

        // Call the export directly
        const initRes = Module._init_valhalla(configPtr);
        console.log('init_valhalla result:', initRes);
        Module._free(configPtr);
        */

        // 2. Initialize Loxi Engine (Rust side)
        console.log('Testing loxi_init_engine...');
        const loxiInitFn = Module.cwrap('loxi_init_engine', 'number', ['number', 'number']);

        const pathStr = "config.json";
        const pathBuf = Buffer.from(pathStr);
        const pathPtr = Module._malloc(pathBuf.length);
        Module.HEAPU8.set(pathBuf, pathPtr);

        const loxiInitRes = loxiInitFn(pathPtr, pathBuf.length);
        console.log('loxi_init_engine result:', loxiInitRes);
        Module._free(pathPtr);

        // 3. Test VRP Solve (loxi_solve)
        console.log('Testing loxi_solve with minimal problem...');
        const problem = JSON.stringify({
            stops: [
                { id: "A", location: { lat: 40.0, lon: -74.0 }, time_window: { start: 0, end: 86400 }, service_time: 300, demand: 1.0, priority: 1 }
            ],
            vehicle: { id: "V1", capacity: 10.0, start_location: { lat: 40.0, lon: -74.0 }, shift_window: { start: 0, end: 86400 }, speed_mps: 10.0 }
        });

        const problemBuf = Buffer.from(problem);
        const problemPtr = Module._malloc(problemBuf.length);
        Module.HEAPU8.set(problemBuf, problemPtr);

        const solveFn = Module.cwrap('loxi_solve', 'number', ['number', 'number']);
        const resultPtr = solveFn(problemPtr, problemBuf.length);

        if (resultPtr === 0) {
            console.error('❌ loxi_solve failed (returned null)');
        } else {
            const resultJson = Module.UTF8ToString(resultPtr);
            console.log('✅ loxi_solve success!');
            console.log('Result:', resultJson.substring(0, 100) + '...');
            Module._free(resultPtr);
        }

        Module._free(problemPtr);

        console.log('--- Verification Complete ---');
        process.exit(0);

    } catch (e) {
        console.error('❌ Verification Error:', e);
        process.exit(1);
    }
};
