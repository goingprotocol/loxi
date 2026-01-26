const WebSocket = require('ws');

// Configuration
const ORCHESTRATOR_URL = 'ws://localhost:3005';

// Mock Nodes
const TITAN_NODE = {
    id: "titan_verify_01",
    ram_mb: 32000,
    vram_mb: 24000,
    thread_count: 32,
    is_webgpu_enabled: true
};

const SCOUT_NODE = {
    id: "scout_verify_01",
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
    console.log("🌊 Starting Full Auction Flow Simulation...");

    // 1. Connect Titan
    const wsTitan = new WebSocket(ORCHESTRATOR_URL);
    await waitForOpen(wsTitan);
    wsTitan.send(JSON.stringify({ RegisterNode: TITAN_NODE }));
    console.log("✅ Titan Connected");

    // 2. Connect Scout
    const wsScout = new WebSocket(ORCHESTRATOR_URL);
    await waitForOpen(wsScout);
    wsScout.send(JSON.stringify({ RegisterNode: SCOUT_NODE }));
    console.log("✅ Scout Connected");

    // 3. Connect Architect
    const wsArchitect = new WebSocket(ORCHESTRATOR_URL);
    await waitForOpen(wsArchitect);
    wsArchitect.send(JSON.stringify({ RegisterAuthority: ARCHITECT_AUTH }));
    console.log("✅ Architect Connected");

    // 4. Listeners
    wsTitan.on('message', (data) => handleWorkerMessage(wsTitan, TITAN_NODE, data, "Titan"));
    wsScout.on('message', (data) => handleWorkerMessage(wsScout, SCOUT_NODE, data, "Scout"));

    // 5. Architect Posts Task (Auction)
    const AUCTION_ID = "auction_test_001";
    console.log(`\n📢 Architect Posting Task: ${AUCTION_ID}`);
    const postTaskMsg = {
        PostTask: {
            auction_id: AUCTION_ID,
            requirement: {
                task_id: AUCTION_ID,
                task_type: "Solve",
                min_ram_mb: 8000, // Titan Only
                use_gpu: true
            }
        }
    };
    wsArchitect.send(JSON.stringify(postTaskMsg));

    // 6. Wait for Bids to Settle then Close
    setTimeout(() => {
        console.log(`\n🔨 Architect Closing Auction: ${AUCTION_ID}`);
        // Orchestrator handler expects winner_id field in struct but ignores it for logic calculation
        const closeMsg = {
            AuctionClosed: {
                auction_id: AUCTION_ID,
                winner_id: "" // Ignored by Orchestrator logic
            }
        };
        wsArchitect.send(JSON.stringify(closeMsg));
    }, 2000);
}

function handleWorkerMessage(ws, node, data, name) {
    const msg = JSON.parse(data);

    // CASE A: New Task Available (RequestLease broadcasted by Orchestrator on PostTask)
    // The Orchestrator broadcasts the "RequestLease" as the "Opportunity"
    if (msg.RequestLease) {
        console.log(`\n🔔 ${name} saw Opportunity! Creating Bid...`);
        const bidMsg = {
            SubmitBid: {
                auction_id: "auction_test_001", // Hardcoded for test simplicity
                worker_id: node.id,
                specs: node,
                price: 0
            }
        };
        ws.send(JSON.stringify(bidMsg));
        console.log(`   -> ${name} Bid Sent`);
    }

    // CASE B: Winning Assignment
    if (msg.LeaseAssignment) {
        if (name === "Titan") {
            console.log("\n🏆 TITAN WON THE AUCTION! (SUCCESS)");
            console.log(msg.LeaseAssignment);
            process.exit(0);
        } else {
            console.log("\n❌ SCOUT WON? (FAILURE - Tiering Broken)");
            process.exit(1);
        }
    }
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
