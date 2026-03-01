// Partitioner Worker - Specialized for H3 Partitioning
// ------------------------------------------------
// Receives Problem JSON -> Returns Partitioned Sectors

const ctx = self;
let wasmModule = null;

// 1. Listen for Task
ctx.onmessage = async (e) => {
    const { type, payload } = e.data;

    if (type !== 'PARTITION_PROBLEM' && type !== 'Compute') return;

    try {
        console.log(`👷 [PARTITIONER] Starting Task...`);
        const start = performance.now();
        ctx.postMessage({ status: 2, message: 'Starting Partitioning process...' });

        // 2. Load WASM
        if (!wasmModule) {
            ctx.postMessage({ status: 2, message: 'Loading Partitioner WASM...' });
            const mod = await import('./loxi_partitioner.js');
            await mod.default();
            wasmModule = mod;
            ctx.postMessage({ status: 2, message: 'Partitioner WASM Loaded.' });
        }

        // 3. Execute
        ctx.postMessage({ status: 2, message: 'Calculating partition sectors...' });
        const result = await wasmModule.run(payload, ctx);

        const duration = ((performance.now() - start) / 1000).toFixed(2);
        ctx.postMessage({ status: 2, message: `Partitioning complete in ${duration}s.` });

        ctx.postMessage({ status: 0, result: result });

    } catch (e) {
        console.error("👷 [PARTITIONER] Error:", e);
        ctx.postMessage({ status: 1, error: e.toString() });
    }
};
