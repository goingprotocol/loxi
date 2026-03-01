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
        const missionId = raw.mission_id || (raw.solution && raw.solution.mission_id) || "unknown";

        console.log(`👷 [Visualizer] Normalizing payload for mission: ${missionId}`, {
            hasSolution: !!raw.solution,
            hasStops: !!raw.stops,
            hasProblem: !!raw.problem,
            keys: Object.keys(raw)
        });

        // Robust stop mapping: Look everywhere for stops array
        const stopsToMap = raw.stops || (raw.problem && raw.problem.stops) || (raw.solution && raw.solution.stops) || [];
        const stopMap = new Map();
        stopsToMap.forEach(s => {
            if (s && s.id !== undefined) {
                stopMap.set(String(s.id), s);
            }
        });

        console.log(`👷 [Visualizer] stopMap built with ${stopMap.size} entries.`);

        // Helper to hydrate a route (array of IDs or stop objects)
        const hydrateRoute = (routeData, mId) => {
            if (!routeData) return null;

            // Support 'all_stops' (New), 'route' (Legacy), or 'stops' (Consolidated Mission) or direct array
            let routeArray = [];
            if (Array.isArray(routeData)) {
                routeArray = routeData;
            } else {
                routeArray = routeData.tours || routeData.routes || routeData.all_stops || routeData.route || routeData.stops || [];
            }

            // If it's a nested structure (like tours), we might need to flatten or handle differently
            // but usually this is called per tour.
            if (Array.isArray(routeArray[0]) && routeArray.length > 0) {
                console.warn("👷 [Visualizer] hydrateRoute received nested arrays, picking first one or flattening?");
                // If we get nested arrays here, it's because we passed the whole solution instead of a single tour
            }

            const routeStops = routeArray.map(id => {
                const stopId = typeof id === 'object' ? String(id.id || id.stop_id) : String(id);

                // 1. Try from stops map
                let stop = stopMap.get(stopId);

                // 2. Try special "start" location
                if (!stop && stopId === "start") {
                    const startLoc = raw.problem?.vehicle?.start_location || raw.vehicle?.start_location || raw.start_location;
                    if (startLoc) stop = { location: startLoc };
                }

                if (!stop) {
                    console.warn(`👷 [Visualizer] Missing coordinates for stop ID: ${stopId}`);
                    return null;
                }
                return { id: stopId, location: stop.location };
            }).filter(Boolean);

            return {
                id: routeData.id || mId || "route_1",
                stops: routeStops
            };
        };

        // Normalize to: { routes: [ {id, stops: [{id, location}]} ] }
        if (raw.tours && Array.isArray(raw.tours)) {
            input = { routes: raw.tours.map((t, i) => hydrateRoute(t, `${missionId}_${i}`)) };
        } else if (raw.solution) {
            const sol = raw.solution;
            if (sol.tours && Array.isArray(sol.tours)) {
                input = { routes: sol.tours.map((t, i) => hydrateRoute(t, `${missionId}_${i}`)) };
            } else if (sol.all_stops && Array.isArray(sol.all_stops)) {
                input = { routes: [hydrateRoute(sol.all_stops, missionId)] };
            } else {
                // Compatibility Fallbacks
                const legacyRoutes = sol.routes || sol.route;
                if (legacyRoutes) {
                    if (Array.isArray(legacyRoutes[0])) {
                        input = { routes: legacyRoutes.map((t, i) => hydrateRoute(t, `${missionId}_${i}`)) };
                    } else {
                        input = { routes: [hydrateRoute(legacyRoutes, missionId)] };
                    }
                } else {
                    input = { routes: [] };
                }
            }
        } else if (raw.all_stops && Array.isArray(raw.all_stops)) {
            input = { routes: [hydrateRoute(raw.all_stops, missionId)] };
        } else if (raw.routes && Array.isArray(raw.routes)) {
            input = { routes: raw.routes.map((t, i) => hydrateRoute(t, `${missionId}_${i}`)) };
        } else {
            console.error("👷 [Visualizer] Unrecognized payload structure", raw);
            input = { routes: [] };
        }

        if (!input.routes || input.routes.length === 0 || input.routes.every(r => r.stops.length === 0)) {
            console.error("Payload normalization failed. Data inspection:", {
                inputRoutesLen: input.routes?.length,
                firstRouteStopsLen: input.routes?.[0]?.stops?.length,
                rawKeys: Object.keys(raw)
            });
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
