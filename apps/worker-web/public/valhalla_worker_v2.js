/* eslint-disable no-restricted-globals */
// Valhalla Web Worker (Safe Mode) - v2.1 Fixed
const ctx = self;

// IndexedDB Config
const DB_NAME = 'LoxiTileCache';
const STORE_NAME = 'tiles';
// ⚠️ IMPORTANTE: Subimos la versión para forzar una limpieza automática de caché
// Esto borrará los tiles viejos/incompatibles sin que tengas que hacerlo manual.
const DB_VERSION = 3;

// ----------------------
// MAIN WORKER LOGIC
// ----------------------
ctx.onmessage = async (e) => {
    const { type, payload } = e.data;

    if (type === 'CALCULATE_MATRIX') {
        try {
            console.log("👷 [WORKER] Starting Valhalla Task (Safe Mode)...");

            // 1. Setup Module environment (Global Scope)
            self.Module = {
                onRuntimeInitialized: () => { },
                locateFile: (path) => `../../artifacts/${path}`,
                print: (text) => console.log("[WORKER-VALHALLA]", text),
                printErr: (text) => console.warn("[WORKER-VALHALLA-ERR]", text),
            };

            // 2. Load the Valhalla script
            importScripts('/artifacts/loxi_valhalla.js');

            // 3. Wait for Runtime
            const mod = await new Promise(resolve => {
                self.Module.onRuntimeInitialized = () => resolve(self.Module);
            });

            // 4. Initialize Engine Configuration
            await initEngine(mod);

            // 5. PRE-FLIGHT: Download Tiles based on Locations
            const input = JSON.parse(payload);
            let locations = input.locations;
            if (!locations && input.sources) locations = input.sources;

            if (locations && locations.length > 0) {
                // console.log(`👷 [WORKER] Analyzing ${locations.length} locations for tiles...`);
                const bbox = getBBox(locations);
                // Descargamos niveles 0, 1 y 2
                await downloadTiles(mod, bbox, locations, SERVER);
            }

            // 6. Execute Matrix
            console.log("👷 [WORKER] Executing Matrix for " + locations.length + " locations...");
            const start = performance.now();
            const res = mod.ccall("valhalla_matrix", "string", ["string"], [payload]);
            const duration = ((performance.now() - start) / 1000).toFixed(2);

            if (!res || (typeof res === 'string' && (res.includes("std::bad_alloc") || res.includes("Valhalla not initialized")))) {
                console.error("👷 [WORKER] Matrix Execution Failed:", res);
                ctx.postMessage({ type: 'ERROR', error: res || "Unknown Error" });
                return;
            }

            console.log("✅ [WORKER] Matrix Calculated in " + duration + "s. Size: " + (res.length / 1024).toFixed(1) + " KB");

            // 7. Send Result
            ctx.postMessage({ type: 'SUCCESS', result: res });

        } catch (e) {
            console.error("👷 [WORKER] Critical Error:", e);
            ctx.postMessage({ type: 'ERROR', error: e.toString() });
        }
    }
};

const SERVER = 'http://localhost:8080';

// ----------------------
// INIT ENGINE LOGIC
// ----------------------
async function initEngine(mod) {
    const fs = mod.FS;

    // 1. Ensure FS Structure
    try {
        ['/valhalla_tiles', '/valhalla_tiles/0', '/valhalla_tiles/1', '/valhalla_tiles/2'].forEach(p => {
            if (!fs.analyzePath(p).exists) fs.mkdir(p);
        });
        fs.writeFile('/valhalla_tiles/admins.sqlite', new Uint8Array(0));
        fs.writeFile('/valhalla_tiles/timezones.sqlite', new Uint8Array(0));
    } catch (e) { }

    // 2. Golden Config
    const config = getGoldenTemplate();
    const configStr = JSON.stringify(config);

    // 3. Write Config (Binary Safe)
    try {
        const encoder = new TextEncoder();
        const data = encoder.encode(configStr);
        fs.writeFile('/valhalla.json', data);

        // Verify
        const check = fs.readFile('/valhalla.json', { encoding: 'utf8' });
        console.log(`👷 [WORKER] Config written (${check.length} bytes).`);
    } catch (e) {
        console.error("👷 [WORKER] Config write failed:", e);
        throw e;
    }

    // 4. Initialize
    console.log("👷 [WORKER] Calling init_valhalla...");
    const result = mod.ccall("init_valhalla", "number", ["string"], ["/valhalla.json"]);

    if (result === 0) {
        console.log("👷 [WORKER] Init Success (Code 0).");
    } else {
        console.warn(`👷 [WORKER] Init returned Code ${result}. Probing...`);
        // Probe
        const dummy = JSON.stringify({ locations: [{ lat: -34.6, lon: -58.3 }, { lat: -34.7, lon: -58.4 }], costing: "auto" });
        const probe = mod.ccall("valhalla_matrix", "string", ["string"], [dummy]);
        if (probe && !probe.includes("Valhalla not initialized")) {
            console.log("👷 [WORKER] Probe Success! Engine is working.");
        } else {
            console.error("👷 [WORKER] Probe Failed:", probe);
            throw new Error(`Valhalla Init Failed (Code ${result}). Check console for missing config details.`);
        }
    }
}

function getGoldenTemplate() {
    // 1. CONFIGURACIÓN EFICIENTE (Modo "Velocidad Normal")
    // Limitamos la expansión para que Valhalla suba rápido a la jerarquía de autopistas.
    const efficientExpand = {
        // En calles locales (2), busca max 5km antes de rendirse o subir.
        // En arterias (1), busca max 50km.
        "0": 0.0,
        "1": 50000.0,
        "2": 5000.0,
        "3": 0.0, "4": 0.0, "5": 0.0, "6": 0.0, "7": 0.0
    };

    // Limitamos las transiciones hacia arriba. 
    // Si en 500 pasos no subiste de calle local a avenida, algo anda mal.
    const efficientTransitions = {
        "0": 0,
        "1": 500, // Arterial to Highway
        "2": 250, // Local to Arterial
        "3": 0, "4": 0, "5": 0, "6": 0, "7": 0
    };

    return {
        "additional_data": {},
        "httpd": {
            "service": {
                "drain_seconds": 28, "interrupt": "ipc:///tmp/interrupt", "listen": "tcp://*:8002", "loopback": "ipc:///tmp/loopback", "shutdown_seconds": 1, "timeout_seconds": -1
            }
        },
        "loki": {
            "actions": ["locate", "route", "status", "tile"],
            "logging": { "color": true, "file_name": "path_to_some_file.log", "long_request": 100.0, "type": "std_out" },
            "service": { "proxy": "ipc:///tmp/loki" },
            "service_defaults": {
                "heading_tolerance": 60,
                "minimum_reachability": 50,
                "mvt_cache_min_zoom": 11,
                "mvt_min_zoom_road_class": [7, 7, 8, 11, 11, 12, 13, 14],
                "node_snap_tolerance": 10,
                // RADIUS: Restauramos a 200m (valor seguro de ValhallaTileLoader).
                "radius": 200,
                "search_cutoff": 35000,
                "street_side_max_distance": 1000,
                "street_side_tolerance": 5
            },
            // 🚨 CLAVE: Apagamos la validación de conectividad.
            // Esto evita el error "Locations are in unconnected regions" en mapas parciales.
            "use_connectivity": false
        },
        "meili": {
            "auto": { "search_radius": 50, "turn_penalty_factor": 200 },
            "bicycle": { "turn_penalty_factor": 140 },
            "customizable": ["mode", "search_radius", "turn_penalty_factor", "gps_accuracy", "interpolation_distance", "sigma_z", "beta", "max_route_distance_factor", "max_route_time_factor"],
            "default": { "beta": 3, "breakage_distance": 2000, "geometry": false, "gps_accuracy": 5.0, "interpolation_distance": 10, "max_route_distance_factor": 5, "max_route_time_factor": 5, "max_search_radius": 100, "route": true, "search_radius": 50, "sigma_z": 4.07, "turn_penalty_factor": 0 },
            "grid": { "cache_size": 1024, "size": 500 },
            "logging": { "color": true, "file_name": "path_to_some_file.log", "type": "std_out" },
            "mode": "auto", "multimodal": { "turn_penalty_factor": 70 }, "pedestrian": { "search_radius": 50, "turn_penalty_factor": 100 },
            "service": { "proxy": "ipc:///tmp/meili" }, "verbose": false
        },
        "mjolnir": {
            "data_processing": { "allow_alt_name": false, "apply_country_overrides": true, "grid_divisions_within_tile": 32, "infer_internal_intersections": true, "infer_turn_channels": true, "scan_tar": false, "use_admin_db": false, "use_direction_on_ways": false, "use_rest_area": false, "use_urban_tag": false },
            "global_synchronized_cache": false,
            "hierarchy": true,
            "id_table_size": 1500000,
            "logging": { "color": true, "file_name": "path_to_some_file.log", "type": "std_out" },
            "lru_mem_cache_hard_control": false,
            "max_cache_size": 128000000,
            "max_concurrent_reader_users": 1,
            "reclassify_links": true,
            "shortcuts": true,
            "tile_dir": "/valhalla_tiles",
            "transit_dir": "/data/valhalla/transit",
            "transit_feeds_dir": "/data/valhalla/transit_feeds",
            "transit_pbf_limit": 20000,
            "use_lru_mem_cache": true,
            "use_simple_mem_cache": false
        },
        "odin": {
            "logging": { "color": true, "file_name": "path_to_some_file.log", "type": "std_out" },
            "markup_formatter": { "markup_enabled": false, "phoneme_format": "<TEXTUAL_STRING> (<span class=<QUOTES>phoneme<QUOTES>>/<VERBAL_STRING>/</span>)" },
            "service": { "proxy": "ipc:///tmp/odin" }
        },
        "service_limits": {
            "allow_hard_exclusions": false,
            "auto": { "max_distance": 20000000.0, "max_locations": 10000, "max_matrix_distance": 20000000.0, "max_matrix_location_pairs": 100000000 },
            "bicycle": { "max_distance": 500000.0, "max_locations": 1000, "max_matrix_distance": 200000.0, "max_matrix_location_pairs": 250000 },
            "bikeshare": { "max_distance": 500000.0, "max_locations": 1000, "max_matrix_distance": 200000.0, "max_matrix_location_pairs": 250000 },
            "bus": { "max_distance": 5000000.0, "max_locations": 1000, "max_matrix_distance": 400000.0, "max_matrix_location_pairs": 250000 },
            "centroid": { "max_distance": 200000.0, "max_locations": 5 },
            "hierarchy_limits": {
                "allow_modification": false,
                "bidirectional_astar": {
                },
                "costmatrix": {
                },
                "unidirectional_astar": {
                },
                "matrix": {
                    "max_distance": 20000000.0,
                    "max_locations": 10000,
                    "max_matrix_distance": 20000000.0,
                    "max_matrix_location_pairs": 100000000
                }
            },
            "isochrone": { "max_contours": 4, "max_distance": 25000.0, "max_distance_contour": 200, "max_locations": 1, "max_time_contour": 120 },
            "max_alternates": 2,
            // PODA: Revertimos a 0 para permitir que Valhalla use jerarquías (autopistas) y sea rápido.
            "max_distance_disable_hierarchy_culling": 0,
            "max_exclude_locations": 50,
            "max_exclude_polygons_length": 10000,
            "max_linear_cost_edges": 50000,
            "max_radius": 5000,
            "max_reachability": 100,
            "max_timedep_distance": 500000,
            "max_timedep_distance_matrix": 0,
            "min_linear_cost_factor": 1,
            "motor_scooter": { "max_distance": 500000.0, "max_locations": 50, "max_matrix_distance": 200000.0, "max_matrix_location_pairs": 2500 },
            "motorcycle": { "max_distance": 5000000.0, "max_locations": 10000, "max_matrix_distance": 20000000.0, "max_matrix_location_pairs": 100000000 },
            "multimodal": { "max_distance": 500000.0, "max_locations": 50, "max_matrix_distance": 0.0, "max_matrix_location_pairs": 0 },
            "pedestrian": { "max_distance": 250000.0, "max_locations": 50, "max_matrix_distance": 200000.0, "max_matrix_location_pairs": 2500, "max_transit_walking_distance": 10000, "min_transit_walking_distance": 1 },
            "skadi": { "max_shape": 750000, "min_resample": 10.0 },
            "status": { "allow_verbose": false },
            "taxi": { "max_distance": 20000000.0, "max_locations": 10000, "max_matrix_distance": 20000000.0, "max_matrix_location_pairs": 100000000 },
            "trace": { "max_alternates": 3, "max_alternates_shape": 100, "max_distance": 200000.0, "max_gps_accuracy": 100.0, "max_search_radius": 100.0, "max_shape": 16000 },
            "transit": { "max_distance": 500000.0, "max_locations": 50, "max_matrix_distance": 200000.0, "max_matrix_location_pairs": 2500 },
            "truck": { "max_distance": 20000000.0, "max_locations": 10000, "max_matrix_distance": 20000000.0, "max_matrix_location_pairs": 100000000 }
        },
        "thor": {
            "source_to_target_algorithm": "select_optimal",
            "costmatrix": {
                "hierarchy_limits": {
                    "expand_within_distance": efficientExpand,
                    "max_up_transitions": efficientTransitions
                },
                "max_iterations": 2000,
                "allow_second_pass": false,
                "check_reverse_connection": false
            },
            "unidirectional_astar": {
                "hierarchy_limits": {
                    "expand_within_distance": efficientExpand,
                    "max_up_transitions": efficientTransitions
                }
            },
            "bidirectional_astar": {
                "hierarchy_limits": {
                    "expand_within_distance": efficientExpand,
                    "max_up_transitions": efficientTransitions
                }
            },
            "logging": { "color": true, "file_name": "path_to_some_file.log", "long_request": 110.0, "type": "std_out" }
        },
        "costing_options": {
            "auto": { "use_hills": 0.5, "shortest": false },
            "truck": { "use_hills": 0.1 }
        }
    };
}


// ------------------------------------------------------------
// TILE DOWNLOAD LOGIC (HIERARCHY SUPPORTED)
// ------------------------------------------------------------
function getBBox(locations) {
    if (!locations.length) return { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 };
    let minLat = locations[0].lat, maxLat = locations[0].lat;
    let minLon = locations[0].lon, maxLon = locations[0].lon;

    locations.forEach(l => {
        if (l.lat < minLat) minLat = l.lat;
        if (l.lat > maxLat) maxLat = l.lat;
        if (l.lon < minLon) minLon = l.lon;
        if (l.lon > maxLon) maxLon = l.lon;
    });

    const Pad = 0.05;
    return { minLat: minLat - Pad, maxLat: maxLat + Pad, minLon: minLon - Pad, maxLon: maxLon + Pad };
}

const createdDirs = new Set(); // Cache for directory existence check

async function downloadTiles(mod, bbox, locations, serverBase) {
    // console.time("TilesSetup");
    const uniqueKeys = new Set();
    const promises = [];
    createdDirs.clear(); // Reset dir cache per run

    const addTile = (level, x, y) => {
        const key = `${level}/${x}/${y}`;
        if (uniqueKeys.has(key)) return;
        uniqueKeys.add(key);

        const nColumns = Math.floor(360 / (level === 2 ? 0.25 : level === 1 ? 1.0 : 4.0));
        const tileId = (y * nColumns) + x;

        // 1. Calculate Paths
        const p1 = Math.floor(tileId / 1000000).toString().padStart(3, '0');
        const p2 = Math.floor((tileId % 1000000) / 1000).toString().padStart(3, '0');
        const p3 = (tileId % 1000).toString().padStart(3, '0');

        const vfsPath = `/valhalla_tiles/${level}/${p1}/${p2}/${p3}.gph`;
        let serverUrlPath = "";

        if (level === 2) {
            serverUrlPath = `/valhalla_tiles/${level}/${p1}/${p2}/${p3}.gph`;
        } else {
            serverUrlPath = `/valhalla_tiles/${level}/${p2}/${p3}.gph`;
        }

        // Removed spammy console.log here
        promises.push(fetchTile(mod, `${serverBase}${serverUrlPath}`, vfsPath));
    };

    // STRATEGY 1: Global Backbone (L0 & L1) covering the entire trip BBox
    [0, 1].forEach(level => {
        const size = level === 1 ? 1.0 : 4.0;
        const startLonIdx = Math.floor((bbox.minLon + 180) / size);
        const endLonIdx = Math.floor((bbox.maxLon + 180) / size);
        const startLatIdx = Math.floor((bbox.minLat + 90) / size);
        const endLatIdx = Math.floor((bbox.maxLat + 90) / size);

        for (let x = startLonIdx; x <= endLonIdx; x++) {
            for (let y = startLatIdx; y <= endLatIdx; y++) {
                addTile(level, x, y);
            }
        }
    });

    // STRATEGY 2: Local Detail (L2) - 3x3 Grid around EACH point
    // This is critical to avoid "Edge of Tile" errors (index out of bounds)
    locations.forEach(loc => {
        const size = 0.25;
        const centerX = Math.floor((loc.lon + 180) / size);
        const centerY = Math.floor((loc.lat + 90) / size);

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                addTile(2, centerX + dx, centerY + dy);
            }
        }
    });

    // console.log(`👷 [WORKER] Queuing ${promises.length} tiles for check/download...`);
    await Promise.all(promises);
    // console.timeEnd("TilesSetup");
}

async function fetchTile(mod, url, vfsPath) {
    try {
        // 1. Check IndexedDB Cache first
        const cached = await getTileFromCache(vfsPath);
        if (cached) {
            ensureDirs(mod, vfsPath);
            mod.FS.writeFile(vfsPath, new Uint8Array(cached));
            return true;
        }

        // 2. Network Fetch
        const resp = await fetch(url);
        if (resp.ok) {
            const buf = await resp.arrayBuffer();
            if (buf.byteLength < 500) {
                // Suspiciously small tile (likely an error message or empty)
                return false;
            }
            ensureDirs(mod, vfsPath);
            mod.FS.writeFile(vfsPath, new Uint8Array(buf));

            // 3. Save to Cache
            saveTileToCache(vfsPath, buf);
            return true;
        }
        // Silent fail for oceans/empty
    } catch (e) {
        console.warn(`👷 [WORKER] Error handling tile ${vfsPath}:`, e);
    }
    return false;
}

function ensureDirs(mod, vfsPath) {
    const parts = vfsPath.split('/');
    let curr = "";
    // Start at 1 to skip empty root. End at length-1 to avoid creating dir for filename.
    for (let i = 1; i < parts.length - 1; i++) {
        curr += '/' + parts[i];
        if (createdDirs.has(curr)) continue; // RAM Cache Hit

        try {
            if (!mod.FS.analyzePath(curr).exists) {
                mod.FS.mkdir(curr);
            }
            createdDirs.add(curr); // Mark as created
        } catch (e) {
            // If mkdir fails (e.g. exists), mark it anyway to avoid retrying
            createdDirs.add(curr);
        }
    }
}

// ----------------------
// CACHE HELPERS (IndexedDB)
// ----------------------
let dbInstance = null; // Singleton dentro del Worker

function openDB() {
    if (dbInstance) return Promise.resolve(dbInstance);

    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            // Si la versión cambia, onupgradeneeded se dispara
            // Borramos y recreamos para purgar
            if (db.objectStoreNames.contains(STORE_NAME)) {
                db.deleteObjectStore(STORE_NAME);
            }
            db.createObjectStore(STORE_NAME);
        };
        req.onsuccess = (e) => {
            dbInstance = e.target.result;
            resolve(dbInstance);
        };
        req.onerror = () => reject("DB Error");
    });
}

async function getTileFromCache(path) {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, "readonly");
            const req = tx.objectStore(STORE_NAME).get(path);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    } catch (e) { return null; }
}

async function saveTileToCache(path, data) {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(data, path);
    } catch (e) { }
}