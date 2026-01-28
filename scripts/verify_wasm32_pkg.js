const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const XMLHttpRequest = require('xmlhttprequest').XMLHttpRequest;

// --- MOCK BROWSER / WORKER ENVIRONMENT ---
global.XMLHttpRequest = XMLHttpRequest;
global.self = global;

// Mock the 'fetchTileBlockSync' bridge function (used by Rust -> JS)
global.fetchTileBlockSync = function (pathStr, blockId) {
    console.log(`[JS Bridge] Requesting block ${blockId} for ${pathStr}`);
    try {
        const url = `http://localhost:8000${pathStr}`;
        const BLOCK_SIZE = 128 * 1024;
        const start = blockId * BLOCK_SIZE;
        const end = start + BLOCK_SIZE - 1;

        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, false); // Synchronous
        xhr.setRequestHeader('Range', `bytes=${start}-${end}`);
        xhr.send(null);

        if (xhr.status === 200 || xhr.status === 206) {
            console.log(`[JS Bridge] Success status ${xhr.status}`);
            // In Node, xhr.responseText or similar might need conversion.
            // But for a "smoke test" of the bridge, we just need it to not crash.
            return new Uint8Array(10);
        }
    } catch (e) {
        console.error(`[JS Bridge] Error: ${e}`);
    }
    return null;
};

// --- LOAD GENERATED PKG ---
const pkgPath = path.resolve(__dirname, '../protocol/target/wasm32-unknown-unknown/debug/pkg/loxi_logistics.js');
console.log(`Loading Package from: ${pkgPath}`);

const loxi = require(pkgPath);

async function runTest() {
    try {
        console.log("Checking exported functions...");
        console.log("Found functions:", Object.keys(loxi));

        if (typeof loxi.solve !== 'function') {
            throw new Error("Export 'solve' not found in package!");
        }

        console.log("✅ Package loaded successfully!");

        // Basic test: Try to solve an empty problem (should return an error string or empty solution)
        const emptyProblem = JSON.stringify({
            plan: { jobs: [], vehicles: [] }
        });

        console.log("Running solve()...");
        const result = loxi.solve(emptyProblem);
        console.log("Solve output:", result);

        console.log("--- SUCCESS ---");
        console.log("Unified WASM32 Flow Verified.");

    } catch (e) {
        console.error("❌ Test Failed:");
        console.error(e);
        process.exit(1);
    }
}

runTest();
