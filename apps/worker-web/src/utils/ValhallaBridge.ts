

/**
 * Calls the Valhalla WASM bridge to generate a matrix or other response.
 * @param jsonInput The JSON string input for Valhalla (e.g. { sources: [...], targets: [...] })
 * @returns The JSON string response from Valhalla, or an error JSON string.
 */
// Synchronous version for WASM Foreign Function Interface
// Returns an OBJECT (not string) to avoid WASM memory exhaustion on large strings.
export const callValhallaBridgeSync = (jsonInput: string): any => {
    try {
        let module = (window as any).valhallaModule;
        if (!module) throw new Error("Valhalla module NOT loaded (Sync Call)");

        const parsed = JSON.parse(jsonInput);

        // 🧱 SANITIZATION
        if (parsed.locations && !parsed.sources) {
            if (!Array.isArray(parsed.locations) || parsed.locations.length === 0) {
                console.error("❌ Validated Input: Locations array is empty/missing!", parsed);
                throw new Error("Insufficiently specified required parameter 'locations' (Array is empty)");
            }
            parsed.sources = parsed.locations;
            parsed.targets = parsed.locations;
            delete parsed.locations;
        } else if (!parsed.sources && !parsed.targets) {
            console.error("❌ Validated Input: No sources/targets/locations!", parsed);
            throw new Error("Insufficiently specified required parameter 'locations' or 'sources & targets'");
        }
        if (!parsed.costing) parsed.costing = "auto";

        const userOptions = parsed.costing_options || {};
        parsed.costing_options = userOptions;
        console.log("📏 [BRIDGE-DEBUG] Final JSON to Valhalla:", JSON.stringify(parsed));

        const finalInput = JSON.stringify(parsed);
        console.log("📏 [BRIDGE-DEBUG] Final JSON to Valhalla:", finalInput);

        console.log("⏳ [ENGINE] Starting C++ valhalla_matrix calculation...");
        const start = performance.now();

        // @ts-ignore
        const res = module.ccall("valhalla_matrix", "string", ["string"], [finalInput]);

        const end = performance.now();
        console.log(`✅ [ENGINE] Finished calculation in ${((end - start) / 1000).toFixed(2)}s`);

        if (!res) throw new Error("Empty response from WASM engine");
        if (typeof res === 'string' && (res.includes("Valhalla not initialized") || res.includes("error"))) {
            // If the C++ returned an error string directly but it's not JSON
            if (!res.startsWith("{")) throw new Error(res);
        }

        // PARSE HERE to return Object to Rust
        return JSON.parse(res);

    } catch (e: any) {
        console.error("❌ Valhalla Bridge Sync Crash:", e);
        return { error: String(e) };
    }
};

export const callValhallaBridge = async (jsonInput: string): Promise<string> => {
    const resultObj = callValhallaBridgeSync(jsonInput);
    // Devolvemos string para mantener compatibilidad con tu App actual
    return JSON.stringify(resultObj);
};

/**
 * Runs the Valhalla Matrix calculation in a disposable Web Worker.
 * This ensures that after the calculation, the worker is terminated and ALL memory is freed.
 * This is the silver bullet for "std::bad_alloc" and "exceeded max iterations".
 */
export const runValhallaWorker = (jsonInput: string, type: 'CALCULATE_MATRIX' | 'CALCULATE_ROUTE' = 'CALCULATE_MATRIX'): Promise<any> => {
    return new Promise((resolve, reject) => {
        const worker = new Worker('/valhalla_worker_v2.js');

        // SANITIZATION (Duplicate from Sync for safety)
        let parsed: any = {};
        try {
            parsed = JSON.parse(jsonInput);

            // Only sanitize for MATRIX if it doesn't have locations (Route usually has locations)
            if (type === 'CALCULATE_MATRIX') {
                if (parsed.locations && !parsed.sources) {
                    parsed.sources = parsed.locations;
                    parsed.targets = parsed.locations;
                    delete parsed.locations;
                }
            }

            if (!parsed.costing) parsed.costing = "auto";

            // ✅ CORRECCIÓN CRÍTICA: NO SOBREESCRIBIR LÍMITES
            const userOptions = parsed.costing_options || {};
            parsed.costing_options = userOptions;
        } catch (e) { reject(e); return; }

        const finalInput = JSON.stringify(parsed);

        worker.onmessage = (e) => {
            const { type: resType, result, error } = e.data;
            if (resType === 'SUCCESS') {
                worker.terminate(); // KILL IT WITH FIRE (clean memory)
                try {
                    resolve(JSON.parse(result));
                } catch (parseErr) {
                    resolve(result); // Return raw if not JSON
                }
            } else if (resType === 'ERROR') {
                console.error(`👷 [WORKER] ${type} Error:`, error);
                worker.terminate();
                reject(error);
            }
        };

        worker.onerror = (err) => {
            console.error(`👷 [WORKER] Fatal Error (${type}):`, err);
            worker.terminate();
            reject(err);
        };

        worker.postMessage({
            type: type,
            payload: finalInput
        });
    });
};
