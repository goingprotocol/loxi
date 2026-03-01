const WebSocket = require('ws');

const ORCHESTRATOR_URL = 'ws://localhost:3005';
const ARCHITECT_ADDR = 'ws://logistics-conductor.loxi.io:4000';

function runSimulation() {
    console.log('--- STARTING WORKER RENTING FLOW SIMULATION ---');

    // 1. DISCOVERER / WORKER (The Compute Node)
    const worker = new WebSocket(ORCHESTRATOR_URL);
    worker.on('open', () => {
        console.log('🐝 [Worker] Connected to Orchestrator');
        worker.send(JSON.stringify({
            RegisterNode: {
                id: 'gaming_pc_01',
                ram_mb: 16000,
                vram_mb: 8000,
                thread_count: 16,
                is_webgpu_enabled: true
            }
        }));
    });

    worker.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.LeaseAssignment) {
            console.log('✅ [Worker] RECEIVED LEASE ASSIGNMENT!');
            console.log(`🔗 [Worker] Connecting to Architect at: ${msg.LeaseAssignment.architect_address}`);
            console.log(`📦 [Worker] Task Type: ${msg.LeaseAssignment.task_type}`);
            console.log('--- SIMULATION SUCCESS ---');
            process.exit(0);
        }
    });

    // 2. ARCHITECT (The Authority)
    const architect = new WebSocket(ORCHESTRATOR_URL);
    architect.on('open', () => {
        console.log('🏛️ [Architect] Connected to Orchestrator');

        // Step A: Register as Authority
        architect.send(JSON.stringify({
            RegisterAuthority: {
                domain_id: 'logistics',
                authority_address: ARCHITECT_ADDR
            }
        }));

        // Step B: Ask for workers after a short delay
        setTimeout(() => {
            console.log('🏛️ [Architect] Requesting 3 workers for logistics matrix calculate...');
            architect.send(JSON.stringify({
                RequestLease: {
                    domain_id: 'logistics',
                    requirement: {
                        task_type: 'Matrix',
                        min_ram_mb: 4000,
                        use_gpu: false
                    },
                    count: 3
                }
            }));
        }, 1000);
    });
}

runSimulation();
