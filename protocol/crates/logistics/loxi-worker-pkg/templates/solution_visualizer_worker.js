import init, { run_routes } from "../matrix/loxi_matrix.js";
import { ValhallaResourceManager } from "../../shared/ValhallaResourceManager.js";

// Global instance for the Rust bridge to find
self.ValhallaResourceManager = null;

self.onmessage = async (e) => {
    const { type, payload, ctx } = e.data;

    if (type !== 'VISUALIZE_ROUTES') return;

    let input;
    try {
        // 1. Initialize Valhalla Manager FIRST (if not ready)
        if (!self.ValhallaResourceManager) {
            self.postMessage({ status: 2, message: 'Initializing Valhalla Engine Manager for route visualization...' });
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
            self.postMessage({ status: 2, message: 'Valhalla Engine Ready for visualization.' });
        }

        // 2. Initialize Routes WASM (if not loaded)
        await init();

        // 3. Process Payload & HYDRATE (If needed)
        const raw = typeof payload === 'string' ? JSON.parse(payload) : payload;
        self.postMessage({ status: 2, message: `Normalizing payload for mission: ${raw.mission_id || "unknown"}` });

        const stopsToMap = raw.stops || (raw.problem && raw.problem.stops) || [];
        const stopMap = new Map();
        stopsToMap.forEach(s => stopMap.set(s.id, s));

        // Helper to hydrate a route (array of IDs or stop objects)
        const hydrateRoute = (routeData, missionId) => {
            // Support 'route' (Legacy/Direct) or 'stops' (Consolidated Mission)
            const routeArray = Array.isArray(routeData) ? routeData : (routeData.route || routeData.stops || []);

            const routeStops = routeArray.map(id => {
                const stopId = typeof id === 'string' ? id : (id.id || id.stop_id);

                // 1. Try from stops map
                let stop = stopMap.get(stopId);

                // 2. Try special "start" location from problem or root
                if (!stop && stopId === "start") {
                    const startLoc = raw.problem?.vehicle?.start_location || raw.vehicle?.start_location || raw.start_location;
                    if (startLoc) stop = { location: startLoc };
                }

                // 3. If it's already an object with location (hydrated), use it.
                if (!stop && typeof id === 'object' && id.location) return { id: stopId, location: id.location };

                if (!stop) return null;
                return { id: stopId, location: stop.location };
            }).filter(Boolean);

            return {
                id: routeData.id || missionId || "route_1",
                stops: routeStops
            };
        };

        // Data format normalization: We MUST end up with a { routes: [ {id, stops: [{id, location}]} ] }
        if (raw.routes && Array.isArray(raw.routes)) {
            self.postMessage({ status: 2, message: 'Processing multi-route payload...' });
            input = { routes: raw.routes.map(r => hydrateRoute(r, raw.mission_id)) };
        } else if (raw.solution) {
            self.postMessage({ status: 2, message: 'Processing single-solution payload...' });
            // solution can have .routes or .route
            if (raw.solution.routes && Array.isArray(raw.solution.routes)) {
                input = { routes: raw.solution.routes.map(r => hydrateRoute(r, raw.mission_id)) };
            } else {
                input = { routes: [hydrateRoute(raw.solution, raw.mission_id)] };
            }
        } else if (raw.route && Array.isArray(raw.route)) {
            self.postMessage({ status: 2, message: 'Processing legacy route payload...' });
            input = { routes: [hydrateRoute(raw.route, raw.mission_id)] };
        } else {
            // Last ditch effort: if it's an array, treat it as a single route
            if (Array.isArray(raw)) {
                input = { routes: [hydrateRoute(raw, "mission_1")] };
            } else {
                input = { routes: [] };
            }
        }

        if (!input.routes || input.routes.length === 0 || input.routes[0].stops.length === 0) {
            console.error("Payload normalization failed. Raw keys:", Object.keys(raw));
            throw new Error(`Normalization failed: No valid routes found. Data keys: ${Object.keys(raw).join(', ')}`);
        }

        const fromE6 = (val) => (Math.abs(val) > 180 ? val / 1000000 : val);

        // Extract all locations from routes for regional warmup
        const allLocations = [];
        if (input.routes && Array.isArray(input.routes)) {
            input.routes.forEach(route => {
                if (route.stops && Array.isArray(route.stops)) {
                    route.stops.forEach(stop => {
                        const rawLat = stop.location?.lat || stop.lat || 0;
                        const rawLon = stop.location?.lon || stop.lon || 0;
                        allLocations.push({ lat: fromE6(rawLat), lon: fromE6(rawLon) });
                    });
                }
            });
        }

        const validCoords = allLocations.filter(c => c && (c.lat !== 0 || c.lon !== 0));

        // 4. Regional Warmup (From IndexedDB to RAM)
        if (validCoords.length > 0) {
            self.postMessage({ status: 2, message: `Warming up regional cache for ${validCoords.length} locations...` });
            await self.ValhallaResourceManager.warmupRegionalCache(validCoords);
        }

        // 5. Execute Route Calculation
        const start = performance.now();
        self.postMessage({ status: 2, message: 'Generating routes with street-level polylines...' });

        const resultString = await run_routes(JSON.stringify(input), ctx);
        console.log(`✅ [Visualizer] run_routes complete. Result length: ${resultString.length}`);

        const duration = ((performance.now() - start) / 1000).toFixed(2);
        self.postMessage({ status: 2, message: `Routes generated with polylines in ${duration}s.` });

        const parsedResult = JSON.parse(resultString);

        if (parsedResult.routes && parsedResult.routes.length > 0) {
            const firstShape = parsedResult.routes[0].shape || "";
            self.postMessage({
                status: 2,
                message: `✅ Generation complete! Routes: ${parsedResult.routes.length}, Shape0 sample: ${firstShape.substring(0, 30)}... (Length: ${firstShape.length})`
            });
        } else {
            self.postMessage({ status: 2, level: 'warn', message: '⚠️ No routes or shapes found in calculation result.' });
        }

        self.postMessage({ status: 0, result: parsedResult });

    } catch (err) {
        console.error("❌ Visualization Worker Error:", err);
        self.postMessage({ status: 1, error: err.toString() });
    }
};
