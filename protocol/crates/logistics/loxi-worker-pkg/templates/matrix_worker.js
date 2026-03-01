import init, { run_matrix, run_routes } from "./loxi_matrix.js";
import { ValhallaResourceManager } from "../../shared/ValhallaResourceManager.js";

// Global instance for the Rust bridge to find
self.ValhallaResourceManager = null;

// Immediate evaluation log
self.postMessage({ status: 2, message: '👷 Matrix Worker script evaluating...' });

self.onmessage = async (e) => {
    const { type, operation, payload, ctx } = e.data;

    if (type !== 'CALCULATE_MATRIX' && type !== 'CALCULATE_ROUTES' && type !== 'Compute') return;

    let input;
    try {
        // 1. Initialize Valhalla Manager FIRST (if not ready)
        if (!self.ValhallaResourceManager) {
            self.postMessage({ status: 2, message: 'Initializing Valhalla Engine Manager...' });
            const baseUrl = (ctx && ctx.architectBase)
                ? ctx.architectBase
                : (self.location.origin.startsWith('blob') ? "http://localhost:3005" : self.location.origin);

            const manager = new ValhallaResourceManager({
                baseUrl: baseUrl,
                wasmPath: 'valhalla_engine.wasm',
                configPath: 'valhalla.json',
            });

            await manager.initialize();
            self.ValhallaResourceManager = manager;
            self.postMessage({ status: 2, message: 'Valhalla Engine Ready.' });
        }

        // 2. Initialize Matrix WASM (if not loaded)
        await init();

        // 3. Process Payload
        input = typeof payload === 'string' ? JSON.parse(payload) : payload;

        const fromE6 = (val) => (Math.abs(val) > 180 ? val / 1000000 : val);

        // Normalize Locations
        const rawLocations = input.stops || input.locations || input.sources || [];
        const warmupCoords = rawLocations.map(l => {
            const rawLat = l.lat !== undefined ? l.lat : (l.location ? l.location.lat : 0);
            const rawLon = l.lon !== undefined ? l.lon : (l.location ? l.location.lon : 0);
            return { lat: fromE6(rawLat), lon: fromE6(rawLon) };
        });

        if (input.vehicle) {
            if (input.vehicle.start_location) {
                const sl = input.vehicle.start_location;
                warmupCoords.push({ lat: fromE6(sl.lat), lon: fromE6(sl.lon) });
            }
            if (input.vehicle.end_location) {
                const el = input.vehicle.end_location;
                warmupCoords.push({ lat: fromE6(el.lat), lon: fromE6(el.lon) });
            }
        }

        const validCoords = warmupCoords.filter(c => c && (c.lat !== 0 || c.lon !== 0));

        // 4. Regional Warmup (From IndexedDB to RAM)
        self.postMessage({ status: 2, message: `Warming up regional cache for ${validCoords.length} locations...` });
        await self.ValhallaResourceManager.warmupRegionalCache(validCoords);

        // 5. Execute
        const start = performance.now();
        let result;

        if (type === 'CALCULATE_MATRIX' || type === 'Compute') {
            self.postMessage({ status: 2, message: 'Calculating distance/time matrix...' });
            result = await run_matrix(JSON.stringify(input), ctx);
        } else if (type === 'CALCULATE_ROUTES') {
            self.postMessage({ status: 2, message: 'Generating routes with polylines...' });
            result = await run_routes(JSON.stringify(input), ctx);
        }

        const duration = ((performance.now() - start) / 1000).toFixed(2);

        if (type === 'CALCULATE_MATRIX') {
            self.postMessage({ status: 2, message: `Matrix calculated in ${duration}s.` });
        } else {
            self.postMessage({ status: 2, message: `Routes generated in ${duration}s.` });
        }

        self.postMessage({ status: 0, result });

    } catch (err) {
        console.error("❌ Worker Error:", err);
        self.postMessage({ status: 1, error: err.toString() });
    }
};
