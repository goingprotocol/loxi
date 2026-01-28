const fs = require('fs');
const path = require('path');

const wasmPath = path.resolve(__dirname, '../protocol/target/wasm64-unknown-unknown/debug/loxi_logistics.wasm');

try {
    const wasmBuffer = fs.readFileSync(wasmPath);
    const module = new WebAssembly.Module(wasmBuffer);
    const imports = WebAssembly.Module.imports(module);

    console.log("=== WASM IMPORTS ===");
    imports.forEach(i => {
        console.log(`Module: ${i.module}, Name: ${i.name}, Kind: ${i.kind}`);
    });

    const exports = WebAssembly.Module.exports(module);
    console.log("\n=== WASM EXPORTS ===");
    exports.forEach(e => {
        console.log(`Name: ${e.name}, Kind: ${e.kind}`);
    });

} catch (e) {
    console.error("Failed to inspect WASM:", e);
}
