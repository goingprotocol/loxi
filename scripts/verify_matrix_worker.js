
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

// Configuration
const WORKER_PATH = path.resolve(__dirname, '../dist/workers/matrix/worker.js');
const ARTIFACTS_DIR = path.resolve(__dirname, '../dist/workers/matrix');

console.log("🔍 Verifying Matrix Worker...");
console.log(`📂 Worker Path: ${WORKER_PATH}`);

// Check if files exist
if (!fs.existsSync(WORKER_PATH)) {
    console.error("❌ Worker file not found!");
    process.exit(1);
}

// We need to mock the environment for the worker script if we run it directly, 
// OR we can try to run it as a Node Worker Thread if the code is compatible.
// Our worker uses `importScripts` and `self`. Node's Worker Threads have a different API.
// 
// However, since we patched ValhallaResourceManager to check for `importScripts`, 
// we might be able to run it if we provide a polyfill.
//
// BETTER APPROACH:
// Instead of running the actual `worker.js` (which expects browser-like `importScripts` or real Worker environment),
// let's create a wrapper that Sets up the environment and then requires the worker logic?
// No, `worker.js` is an ES module or script? It uses `import ...` syntax in our code:
// `import init, { run } from "./loxi_matrix.js";`
// This means it is an ES module. functionality in Node requires .mjs extension or type: module.

console.log("⚠️  Note: Full verification requires a browser-like environment (Service Worker / Web Worker).");
console.log("⚠️  Running a static check on artifacts presence...");

const artifacts = [
    'artifacts/ValhallaResourceManager.js',
    'artifacts/valhalla_engine.js',
    'artifacts/valhalla_engine.wasm',
    'artifacts/valhalla.json',
    'loxi_matrix.js',
    'loxi_matrix_bg.wasm'
];

let missing = false;
artifacts.forEach(f => {
    const p = path.join(ARTIFACTS_DIR, f);
    if (!fs.existsSync(p)) {
        console.error(`❌ Missing artifact: ${f}`);
        missing = true;
    } else {
        console.log(`✅ Found: ${f}`);
    }
});

if (missing) {
    console.error("❌ verification failed: missing artifacts.");
    process.exit(1);
}

console.log("\n✅ Static Artifact Verification Passed.");
console.log("   The worker structure looks correct.");
console.log("   Please test in the browser application (apps/worker-web) to verify runtime behavior.");
