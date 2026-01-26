import { LoxiNode } from './src/LoxiNode';

async function main() {
    console.log("Starting LoxiNode Test Client...");

    // Connect to local orchestrator
    const node = new LoxiNode('ws://127.0.0.1:3005', 'sdk_test_node_01');

    await node.start();

    // Keep alive for a bit to receive messages
    setTimeout(() => {
        console.log("Test finished.");
        process.exit(0);
    }, 2000);
}

main().catch(console.error);
