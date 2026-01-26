const WebSocket = require('ws');

const ORCHESTRATOR_URL = 'ws://localhost:3005';
const ARCHITECT_ADDR = 'ws://logistics-conductor.loxi.io:4000';

// 1. SIMULATE ARCHITECT REGISTRATION
function simulateArchitect() {
    const ws = new WebSocket(ORCHESTRATOR_URL);
    ws.on('open', () => {
        console.log('🏛️ [Architect] Connected to Orchestrator');
        const regMsg = {
            RegisterAuthority: {
                domain_id: 'logistics',
                authority_address: ARCHITECT_ADDR
            }
        };
        ws.send(JSON.stringify(regMsg));
        console.log('🏛️ [Architect] Registered as Authority for "logistics"');

        // Keep alive for a bit
        setTimeout(() => ws.close(), 2000);
    });
}

// 2. SIMULATE WORKER DISCOVERY
function simulateWorker() {
    const ws = new WebSocket(ORCHESTRATOR_URL);
    ws.on('open', () => {
        console.log('🐝 [Worker] Connected to Orchestrator');
        const discMsg = {
            DiscoverAuthority: {
                domain_id: 'logistics'
            }
        };
        ws.send(JSON.stringify(discMsg));
    });

    ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        console.log('🐝 [Worker] Received from Orchestrator:', JSON.stringify(msg, null, 2));

        if (msg.AuthorityFound) {
            console.log(`✅ SUCCESS: Worker discovered Architect at ${msg.AuthorityFound.authority_address}`);
            process.exit(0);
        } else if (msg.Error) {
            console.log(`❌ ERROR: ${msg.Error}`);
        }
    });
}

// RUN FLOW
console.log('--- STARTING ARCHITECT FLOW SIMULATION ---');
simulateArchitect();

// Wait for registration to propagate before worker asks
setTimeout(simulateWorker, 1000);
