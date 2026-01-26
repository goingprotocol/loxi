const WebSocket = require('ws');

function runTest(nodeName, specs) {
    const ws = new WebSocket('ws://127.0.0.1:3005');

    ws.on('open', function open() {
        console.log(`[${nodeName}] Connected.`);
        console.log(`[${nodeName}] Sending specs:`, JSON.stringify(specs));
        ws.send(JSON.stringify(specs));
    });

    ws.on('message', function message(data) {
        console.log(`[${nodeName}] Received Logic Decision: %s`, data);
        ws.close();
    });

    ws.on('error', (err) => {
        console.error(`[${nodeName}] Error:`, err.message);
    });
}

// Case 1: Weak Phone (Should get Lite WASM)
runTest('WeakPhone', {
    id: "phone_001",
    ram_mb: 2000,
    vram_mb: 0,
    thread_count: 4,
    is_webgpu_enabled: false
});

// Case 2: Gaming PC (Should get Full GPU WASM)
setTimeout(() => {
    runTest('GamingPC', {
        id: "pc_master_race",
        ram_mb: 32000,
        vram_mb: 12000,
        thread_count: 24,
        is_webgpu_enabled: true
    });
}, 500);
