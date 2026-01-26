const WebSocket = require('ws');

// Node Specs: High RAM (32GB), High Threads (16), No GPU
const SPECS = {
    id: 'matrix_node_pc_01',
    ram_mb: 32000,
    vram_mb: 0,
    thread_count: 16,
    is_webgpu_enabled: false
};

const ws = new WebSocket('ws://localhost:3005');

ws.on('open', () => {
    console.log('[MatrixNode] Connected to Orchestrator');
    ws.send(JSON.stringify(SPECS));
});

ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    console.log('[MatrixNode] Received:', msg);

    if (msg.wasm_module) {
        console.log(`[MatrixNode] ASSIGNMENT: ${msg.wasm_module}`);
        console.log(`[MatrixNode] Task Type: ${msg.task_type}`);

        if (msg.wasm_module.includes('valhalla')) {
            console.log('✅ SUCCESS: Orchestrator assigned Valhalla Router to High-RAM Node');
        } else {
            console.log('❌ FAILURE: Wrong module assigned');
        }
        process.exit(0);
    } else if (msg.error) {
        console.error('[MatrixNode] Error:', msg.error);
    }
});
