// VRP Worker - Specialized for Loxi VRP Solver
// ------------------------------------------------
// Simple stateless worker: Receives Problem JSON -> Returns Solution JSON

const ctx = self;
let wasmModule = null;

// 1. Listen for Task
ctx.onmessage = async (e) => {
    const { type, payload } = e.data;

    if (type !== 'SOLVE_VRP' && type !== 'Compute') return;

    try {
        console.log(`👷 [VRP-WORKER] Starting Task..., `, `payload: ${JSON.stringify(payload)}`);
        const start = performance.now();
        ctx.postMessage({ status: 2, message: 'Starting VRP Solver...' });

        // 2. Load WASM (Lazy loading)
        if (!wasmModule) {
            ctx.postMessage({ status: 2, message: 'Loading VRP WASM...' });
            const mod = await import('./loxi_vrp.js');
            await mod.default();
            wasmModule = mod;
            ctx.postMessage({ status: 2, message: 'VRP WASM Loaded.' });
        }

        // 3. Execute
        let solution;
        if (payload instanceof ArrayBuffer || payload instanceof Uint8Array) {
            ctx.postMessage({ status: 2, message: 'Solving optimization routes (Zero-Copy Binary)...' });
            const uint8_payload = payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload;
            solution = await wasmModule.run_binary(uint8_payload, ctx);
        } else {
            ctx.postMessage({ status: 2, message: 'Solving optimization routes (JSON Legacy)...' });
            solution = await wasmModule.run(payload, ctx);
        }

        const duration = ((performance.now() - start) / 1000).toFixed(2);
        ctx.postMessage({ status: 2, message: `VRP solved in ${duration}s.` });

        // 4. Respond
        ctx.postMessage({ status: 0, result: solution });

    } catch (e) {
        console.error("👷 [VRP-WORKER] Error:", e);
        ctx.postMessage({ status: 1, error: e.toString() });
    }
};
