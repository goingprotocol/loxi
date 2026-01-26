const WebSocket = require('ws');

// Configuration
const ORCHESTRATOR_URL = 'ws://localhost:3005';

// Mock Nodes
const TITAN_NODE = {
    id: "titan_gpu_01",
    ram_mb: 32000,
    vram_mb: 24000,
    thread_count: 32,
    is_webgpu_enabled: true
};

const SCOUT_NODE = {
    id: "scout_mobile_01",
    ram_mb: 4000,
    vram_mb: 0,
    thread_count: 4,
    is_webgpu_enabled: false
};

const ARCHITECT_AUTH = {
    domain_id: "logistics_global",
    authority_address: "ws://architect.local"
};

async function main() {
    console.log("🌊 Starting Tiered Waterfall Simulation...");

    // 1. Connect Titan
    const wsTitan = new WebSocket(ORCHESTRATOR_URL);
    await waitForOpen(wsTitan);
    wsTitan.send(JSON.stringify({ RegisterNode: TITAN_NODE }));
    console.log("✅ Titan Connected & Registered");

    // 2. Connect Scout
    const wsScout = new WebSocket(ORCHESTRATOR_URL);
    await waitForOpen(wsScout);
    wsScout.send(JSON.stringify({ RegisterNode: SCOUT_NODE }));
    console.log("✅ Scout Connected & Registered");

    // 3. Connect Architect
    const wsArchitect = new WebSocket(ORCHESTRATOR_URL);
    await waitForOpen(wsArchitect);
    wsArchitect.send(JSON.stringify({ RegisterAuthority: ARCHITECT_AUTH }));
    console.log("✅ Architect Connected");

    // 4. Listen for Assignments
    wsTitan.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.LeaseAssignment) {
            console.log("\n🏆 TITAN RECEIVED ASSIGNMENT!");
            console.log(msg.LeaseAssignment);
            process.exit(0); // Success
        }
    });

    wsScout.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.LeaseAssignment) {
            console.log("\n❌ SCOUT RECEIVED ASSIGNMENT (TEST FAILED - TIERING BROKEN)");
            console.log(msg.LeaseAssignment);
            process.exit(1);
        }
    });

    // 5. Request a Heavy Task (Should go to Titan)
    console.log("\n📡 Architect Requesting LEASE for Heavy Task (Titan Tier)...");
    const request = {
        RequestLease: {
            domain_id: QUEEN_BEE_AUTH.domain_id,
            requirement: {
                task_id: "tiered_test_001",
                task_type: "Solve", // Complex
                min_ram_mb: 8000,   // More than Scout has
                use_gpu: true       // Titan only
            },
            count: 1
        }
    };
    wsArchitect.send(JSON.stringify(request));

    // Timeout
    setTimeout(() => {
        console.log("\n⏰ Timeout waiting for assignment.");
        process.exit(1);
    }, 5000);
}

function waitForOpen(ws) {
    return new Promise((resolve) => {
        if (ws.readyState === WebSocket.OPEN) {
            resolve();
        } else {
            ws.on('open', resolve);
        }
    });
}

main();
