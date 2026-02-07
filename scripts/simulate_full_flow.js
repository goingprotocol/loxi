const WebSocket = require('ws');

const ORCHESTRATOR = "ws://localhost:3005";

// 1. ARCHITECT DATA
const MOCK_VRP_PROBLEM = {
    id: "global_auction_demo_" + Math.floor(Math.random() * 1000),
    stops: [
        { id: "A", lat: -34.6037, lon: -58.3816 }, // Obelisco
        { id: "B", lat: -34.5833, lon: -58.3972 }, // Recoleta
        { id: "C", lat: -34.6177, lon: -58.3678 }, // Puerto Madero
        { id: "D", lat: -34.5936, lon: -58.4069 }  // Facultad
    ]
};

async function runDemo() {
    console.log("🚀 Loxi Swarm: Starting Full Pipeline Demo...");
    const ws = new WebSocket(ORCHESTRATOR);

    ws.on('open', () => {
        console.log("📡 Connected to Orchestrator as Architect.");

        // --- STAGE 1: MATRIX PRE-COMPUTATION (VALHALLA) ---
        console.log("\n🏛️  STAGE 1: Requesting High-Fidelity Matrix (Valhalla)...");
        const matrixTask = {
            PostTask: {
                auction_id: "matrix_auction_valhalla_01",
                requirement: {
                    id: "matrix_auction_valhalla_01",
                    artifact_hash: "loxi_valhalla_v1",
                    context_hashes: ["H3_BUE_7"],
                    min_ram_mb: 8000,
                    use_gpu: false,
                    task_type: "Matrix"
                },
                payload: JSON.stringify(MOCK_VRP_PROBLEM)
            }
        };
        ws.send(JSON.stringify(matrixTask));

        // Simulate 2 seconds of bidding time before closing Stage 1
        setTimeout(() => {
            console.log("\n🔨 Closing Matrix Auction...");
            ws.send(JSON.stringify({
                AuctionClosed: { auction_id: "matrix_auction_valhalla_01" }
            }));
        }, 3000);
    });

    ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());

        if (msg.SubmitSolution && msg.auction_id === "matrix_auction_valhalla_01") {
            console.log("✅ STAGE 1 COMPLETE: Matrix Received from Titan Node.");
            console.log("📊 Matrix Metadata:", msg.solution.status);

            // --- STAGE 2: VRP OPTIMIZATION (SCOUT SOLVER) ---
            console.log("\n🧬 STAGE 2: Requesting VRP Optimization (Solver)...");
            const solveTask = {
                PostTask: {
                    auction_id: "solve_auction_vrp_01",
                    requirement: {
                        id: "solve_auction_vrp_01",
                        artifact_hash: "loxi_vrp_artifact_v1",
                        context_hashes: ["loxi_logistics_v1"],
                        min_ram_mb: 256, // Edge nodes can handle this
                        use_gpu: false,
                        task_type: "Solve"
                    },
                    payload: JSON.stringify(MOCK_VRP_PROBLEM)
                }
            };
            ws.send(JSON.stringify(solveTask));

            // Simulate 2 seconds of bidding time before closing Stage 2
            setTimeout(() => {
                console.log("\n🔨 Closing Solve Auction...");
                ws.send(JSON.stringify({
                    AuctionClosed: { auction_id: "solve_auction_vrp_01" }
                }));
            }, 3000);
        }

        if (msg.SubmitSolution && msg.auction_id === "solve_auction_vrp_01") {
            console.log("\n🏆 STAGE 2 COMPLETE: Solution Found by Scout Node!");
            console.log("💰 Final Cost:", msg.solution.cost.toFixed(2));
            console.log("✨ SUCCESS: Full Sovereign Pipeline Verified.");
            process.exit(0);
        }
    });
}

runDemo().catch(console.error);
