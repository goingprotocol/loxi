/**
 * Dynamic Valhalla Tile Loader
 * Downloads only the tiles needed for a specific geographic region
 */

export interface BoundingBox {
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
}

export interface TileCoord {
    level: number;
    x: number;
    y: number;
}

// Global flag to prevent double initialization of the WASM engine

export function calculateRequiredTiles(bbox: BoundingBox, level: number = 0): TileCoord[] {
    const tiles: TileCoord[] = [];
    const tileSize = level === 2 ? 0.25 : level === 1 ? 1.0 : 4.0;

    const minTileX = Math.floor((bbox.minLon + 180) / tileSize);
    const maxTileX = Math.floor((bbox.maxLon + 180) / tileSize);
    const minTileY = Math.floor((bbox.minLat + 90) / tileSize);
    const maxTileY = Math.floor((bbox.maxLat + 90) / tileSize);

    for (let y = minTileY; y <= maxTileY; y++) {
        for (let x = minTileX; x <= maxTileX; x++) {
            tiles.push({ level, x, y });
        }
    }
    return tiles;
}

export function tileToPath(tile: TileCoord): string {
    const tileSize = tile.level === 2 ? 0.25 : tile.level === 1 ? 1.0 : 4.0;
    const nColumns = Math.floor(360 / tileSize);
    const tileId = (tile.y * nColumns) + tile.x;

    // Valhalla hierarchical structure varies by level in this dataset
    // Level 2: Nested (Level/Dir1/Dir2/File.gph)
    // Level 0/1: Flat (Level/Bucket/File.gph)
    if (tile.level === 2) {
        const bucketId = Math.floor(tileId / 1000);
        const dir1 = Math.floor(bucketId / 1000).toString().padStart(3, '0');
        const dir2 = (bucketId % 1000).toString().padStart(3, '0');
        const file = (tileId % 1000).toString().padStart(3, '0');
        return `${tile.level}/${dir1}/${dir2}/${file}.gph`;
    } else {
        const bucket = Math.floor(tileId / 1000).toString().padStart(3, '0');
        const file = (tileId % 1000).toString().padStart(3, '0');
        return `${tile.level}/${bucket}/${file}.gph`;
    }
}

export async function downloadTile(tile: TileCoord, tileServerUrl: string = 'http://localhost:8080'): Promise<ArrayBuffer> {
    const tilePath = tileToPath(tile);
    const url = `${tileServerUrl}/${tilePath}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download tile ${tilePath}: ${response.statusText}`);
    return response.arrayBuffer();
}

export function loadTileIntoMEMFS(module: any, tile: TileCoord, data: ArrayBuffer): void {
    if (!module || !module.FS) throw new Error('Valhalla module FS not available.');
    const tilePath = tileToPath(tile);
    const fullPath = `/valhalla_tiles/${tilePath}`;
    const parts = fullPath.split('/');
    let currentPath = '';
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!part && i > 0) continue;
        currentPath = i === 0 ? "" : currentPath + '/' + part;
        if (!currentPath) currentPath = "/";
        try { module.FS.mkdir(currentPath); } catch (e) { }
    }
    module.FS.writeFile(fullPath, new Uint8Array(data));
    console.log(`✅ Loaded tile into MEMFS: ${fullPath}`);
}

class TileCache {
    private dbName = 'valhalla-tiles';
    private storeName = 'tiles';
    private db: IDBDatabase | null = null;

    // Increment this version to force all clients to delete their old cache and re-download
    private CACHE_VERSION = 'v4-argentina-fix';

    async init(): Promise<void> {
        if (this.db) return Promise.resolve();

        // 1. Check for version mismatch and clear if needed
        const storedVersion = localStorage.getItem('valhalla_tile_cache_version');
        if (storedVersion !== this.CACHE_VERSION) {
            console.log(`🧹 Cache Mismatch (Old: ${storedVersion}, New: ${this.CACHE_VERSION}). Purging IndexedDB...`);
            await new Promise<void>((resolve) => {
                const req = indexedDB.deleteDatabase(this.dbName);
                req.onerror = () => { console.warn("Failed to delete old DB", req.error); resolve(); };
                req.onsuccess = () => {
                    console.log("✅ Old cache deleted.");
                    localStorage.setItem('valhalla_tile_cache_version', this.CACHE_VERSION);
                    resolve();
                };
                req.onblocked = () => {
                    console.warn("⚠️ DB Delete blocked! Close other tabs.");
                    resolve();
                };
            });
        }

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);
            request.onerror = () => {
                console.error("IndexedDB Open Error:", request.error);
                reject(request.error);
            };
            request.onsuccess = () => { this.db = request.result; resolve(); };
            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName);
            };
        });
    }

    async get(key: string): Promise<ArrayBuffer | null> {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(key);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result || null);
        });
    }

    async set(key: string, value: ArrayBuffer): Promise<void> {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.put(value, key);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }
}

const tileCache = new TileCache();

export async function loadTilesForRegion(
    module: any,
    bbox: BoundingBox,
    tileServerUrl: string = 'http://localhost:8080',
    onProgress?: (loaded: number, total: number) => void
): Promise<void> {
    if (module && !module.FS) {
        console.log("⏳ Waiting for Valhalla FS to be ready...");
        let attempts = 0;
        while (!module.FS && attempts < 100) {
            await new Promise(resolve => setTimeout(resolve, 50));
            attempts++;
        }
    }

    // 1. Setup Robust FS Structure & Config (Deferred until after tile load check)
    // await initializeValhallaConfig(module, tileServerUrl); 


    // 2. Load Tiles (Hierarchy: 0=Highway, 1=Arterial, 2=Local)
    const levels = [0, 1, 2];
    let allTiles: TileCoord[] = [];

    for (const level of levels) {
        allTiles = allTiles.concat(calculateRequiredTiles(bbox, level));
    }

    console.log(`📦 Loading ${allTiles.length} tiles for region...`);
    let loaded = 0;
    for (const tile of allTiles) {
        const tilePath = tileToPath(tile);
        let tileData = await tileCache.get(tilePath);
        if (!tileData) {
            try {
                tileData = await downloadTile(tile, tileServerUrl);
                await tileCache.set(tilePath, tileData);
            } catch (e) {
                console.error(`❌ Tile download failed ${tilePath}:`, e);
                continue;
            }
        }
        loadTileIntoMEMFS(module, tile, tileData!);
        loaded++;
        onProgress?.(loaded, allTiles.length);
    }

    // 3. Determine if we have Level 2 tiles
    // We check if we actually put any Level 2 tiles into FS or if we found them valid
    const level2Available = allTiles.some(t => t.level === 2 && module.FS.analyzePath(`/valhalla_tiles/${tileToPath(t)}`).exists);

    console.log(`🧠 Level 2 availability check: ${level2Available ? "✅ Available" : "❌ Not found (will disable in config)"}`);

    // 4. Initialize Config with dynamic Level 2 support
    await initializeValhallaConfig(module, tileServerUrl, level2Available);

    // 5. Finalizing Valhalla Initialization
    await initializeValhallaEngine(module);

}

export async function initializeValhallaConfig(module: any, tileServerUrl: string, enableLevel2: boolean = true): Promise<void> {
    // 1. Setup Base FS Structure
    try {
        ['/valhalla_tiles', '/valhalla_tiles/0', '/valhalla_tiles/1', '/valhalla_tiles/2'].forEach(dir => {
            if (!module.FS.analyzePath(dir).exists) {
                module.FS.mkdir(dir);
            }
        });
    } catch (e) { }

    const template = getGoldenTemplate();

    // DEEP MERGE STRATEGY: WASM-Friendly
    // We start with the golden template and IGNORE complex server config for stability.
    const config = JSON.parse(JSON.stringify(template)); // Deep clone

    // WASM Specific Overrides (Non-negotiable)
    config.mjolnir = config.mjolnir || {};
    config.mjolnir.tile_dir = "/valhalla_tiles";

    // Explicitly remove paths to files that definitely don't exist in VFS
    // This prevents "stat: No such file or directory" errors during init
    delete config.mjolnir.admin;
    delete config.mjolnir.timezone;
    delete config.mjolnir.elevation;
    delete config.mjolnir.transit_dir;
    delete config.mjolnir.tile_extract; // Important: Empty string can cause stat errors
    delete config.mjolnir.traffic_extract;

    // Scrub all potential /data/ or absolute paths that might break WASM readdir/stat
    const scrub = (obj: any) => {
        for (const key in obj) {
            if (typeof obj[key] === 'string') {
                const val = obj[key] as string;
                if (val.startsWith('/') || val.includes(':/')) {
                    // Normalize our VFS paths, delete others
                    if (val.startsWith('/valhalla_tiles') || val === '/valhalla.json') {
                        // Keep but ensure safe
                    } else {
                        delete obj[key];
                    }
                }
            } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                scrub(obj[key]);
            }
        }
    };
    scrub(config);

    // Force specific algorithms and flags for stability in WASM
    if (!config.mjolnir) config.mjolnir = {};
    config.mjolnir.tile_dir = "/valhalla_tiles/"; // Trailing slash for stability
    // config.mjolnir.tile_extract = "";
    config.mjolnir.hierarchy = true;

    // Set safe memory constraints for browser WASM
    config.mjolnir.max_cache_size = 120000000; // 120MB
    config.mjolnir.id_table_size = 100000000;

    // Level 2 is enabled provided the tiles exist
    if (!enableLevel2) {
        if (config.thor?.bidirectional_astar?.hierarchy_limits?.expand_within_distance) {
            delete config.thor.bidirectional_astar.hierarchy_limits.expand_within_distance["2"];
        }
        if (config.thor?.unidirectional_astar?.hierarchy_limits?.expand_within_distance) {
            delete config.thor.unidirectional_astar.hierarchy_limits.expand_within_distance["2"];
        }
        if (config.thor?.costmatrix?.hierarchy_limits?.expand_within_distance) {
            delete config.thor.costmatrix.hierarchy_limits.expand_within_distance["2"];
        }
    }

    // Force basic logging to console
    const logSection = { type: "std_out", color: true };
    config.mjolnir.logging = logSection;
    if (config.thor) config.thor.logging = logSection;
    if (config.loki) config.loki.logging = logSection;

    const configStr = JSON.stringify(config);
    module.FS.writeFile('/valhalla.json', configStr);
    console.log("📝 JIT Config (Scrubbed) written to VFS. Size:", configStr.length);
}

export async function initializeValhallaEngine(module: any): Promise<void> {
    // 1. Double check FS readiness
    if (!module || !module.FS) {
        console.warn("⚠️ Valhalla FS not yet available for engine init.");
        return;
    }

    // 2. Load the config we just wrote
    let currentConfigStr = "";
    try {
        currentConfigStr = module.FS.readFile('/valhalla.json', { encoding: 'utf8' });
    } catch (e) {
        console.error("❌ Critical: /valhalla.json could not be read before init!");
        throw new Error("Valhalla config file missing or unreadable in VFS");
    }

    // 3. JS-side Check: Has anything changed?
    if (module.valhallaInitialized && module.lastConfigStr === currentConfigStr) {
        // Test probe (Buenos Aires)
        try {
            const dummyInput = JSON.stringify({ locations: [{ lat: -34.6037, lon: -58.3816 }, { lat: -34.6040, lon: -58.3820 }], costing: "auto" });
            const probeRes = module.ccall("valhalla_matrix", "string", ["string"], [dummyInput]);
            if (typeof probeRes === 'string' && !probeRes.includes("Valhalla not initialized")) {
                console.log("✔️ Valhalla Engine alive and config is identical. Skipping re-init.");
                return;
            }
        } catch (e) { }
    }

    // 4. Check if we have at least SOME tiles before initializing
    try {
        const levels = [0, 1, 2];
        levels.forEach(lvl => {
            try {
                const path = `/valhalla_tiles/${lvl}`;
                if (module.FS.analyzePath(path).exists) {
                    const files = module.FS.readdir(path);
                    console.log(`📂 Level ${lvl} subdirs: ${files.length - 2}`);
                }
            } catch (e) { }
        });
    } catch (e) { }

    // 5. Initialization Attempt
    try {
        console.log("🏾 Initializing Valhalla Engine (JIT Mode)...");
        console.log(`📡 Config target: /valhalla.json`);

        // @ts-ignore
        const result = module.ccall(
            "init_valhalla",
            "number",
            ["string"],
            ["/valhalla.json"]
        );

        if (result === 0) {
            console.log(`✅ Valhalla Engine Initialized Successfully!`);
            module.valhallaInitialized = true;
            module.lastConfigStr = currentConfigStr;
        } else {
            // Code non-zero is an error in this bridge
            console.warn(`❌ Valhalla Init returned error code: ${result}. Probing for life...`);

            const dummyInput = JSON.stringify({ locations: [{ lat: -34.6037, lon: -58.3816 }, { lat: -34.6040, lon: -58.3820 }], costing: "auto" });
            const probeRes = module.ccall("valhalla_matrix", "string", ["string"], [dummyInput]);

            if (typeof probeRes === 'string' && !probeRes.includes("Valhalla not initialized") && !probeRes.includes("error")) {
                console.log("✅ Probe Succeeded despite error code. Engine is responsive.");
                module.valhallaInitialized = true;
                module.lastConfigStr = currentConfigStr;
                return;
            }

            console.error("🕵️ Probe Response (after error):", probeRes);
            console.error("🛠️ Config used was:", currentConfigStr);
            throw new Error(`Valhalla initialization failed with code ${result}. Engine says: ${probeRes}`);
        }
    } catch (e: any) {
        console.error("❌ Failed to initialize Valhalla engine:", e);
        throw e;
    }
}

// ------------------------------------------------------------------
// Golden Template: Configuración 1:1 Exhaustiva (Basada en Loxi Production)
// ------------------------------------------------------------------
function getGoldenTemplate() {
    return {
        "mjolnir": {
            "tile_dir": "/valhalla_tiles",
            "hierarchy": true,
            "id_table_size": 13000000,
            "max_cache_size": 1000000000,
            "data_processing": {
                "use_admin_db": false,
                "use_urban_tag": false,
                "use_rest_area": false
            },
            "logging": {
                "type": "std_out",
                "color": true
            }
        },
        "loki": {
            "actions": [
                "locate",
                "route",
                "sources_to_targets",  // <--- Matriz (Vital)
                "optimized_route",     // <--- VRP/TSP (Vital)
                "isochrone"
            ],
            "use_connectivity": true,
            "service_defaults": {
                "radius": 0,
                "minimum_reachability": 50,
                "search_cutoff": 35000,
                "node_snap_tolerance": 5,
                "street_side_tolerance": 5,
                "street_side_max_distance": 1000,
                "heading_tolerance": 60,
                "mvt_min_zoom_road_class": {
                    "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, "5": 0, "6": 0, "7": 0
                },
                "mvt_cache_min_zoom": 0,
                "mvt_cache_max_zoom": 20
            },
            "logging": {
                "type": "std_out",
                "color": true
            }
        },
        "thor": {
            "source_to_target_algorithm": "select_optimal",
            "logging": {
                "type": "std_out",
                "color": true
            }
        },
        "odin": {
            "markup_set": "all",
            "logging": {
                "type": "std_out",
                "color": true
            }
        },
        "meili": {
            "mode": "map_matching",
            "customizable": [
                "mode",
                "search_radius",
                "turn_penalty_factor",
                "gps_accuracy",
                "interpolation_distance",
                "sigma_z",
                "beta",
                "max_route_distance_factor",
                "breakage_distance_factor"
            ],
            "verbose": false,
            "default": {
                "sigma_z": 4.07,
                "gps_accuracy": 5.0,
                "beta": 3,
                "breakage_distance_factor": 2000,
                "interpolation_distance": 10,
                "search_radius": 50,
                "turn_penalty_factor": 200,
                "max_route_distance_factor": 5,
                "breakage_distance": 2000,
            },
            "grid": {
                "size": 500,
                "cache_size": 100240
            },
            "logging": {
                "type": "std_out",
                "color": true
            }
        },
        "service_limits": {
            "max_exclude_locations": 50,
            "max_reachability": 100,
            "max_radius": 200000,
            "max_timedep_distance": 500000,
            "max_alternates": 2,
            "max_exclude_polygons_length": 10000,
            "max_exclude_polygons": {
                "max_locations": 50,
                "max_distance": 200000,
                "max_matrix_distance": 200000,
                "max_matrix_location_pairs": 2500
            },
            "auto": {
                "max_distance": 5000000,
                "max_locations": 200,
                "max_matrix_distance": 400000,
                "max_matrix_location_pairs": 2500
            },
            "truck": {
                "max_distance": 5000000,
                "max_locations": 200,
                "max_matrix_distance": 400000,
                "max_matrix_location_pairs": 2500
            },
            "pedestrian": {
                "max_distance": 250000,
                "max_locations": 50,
                "max_matrix_distance": 200000,
                "max_matrix_location_pairs": 2500,
                "min_transit_walking_distance": 1,
                "max_transit_walking_distance": 500
            },
            "bicycle": {
                "max_distance": 500000,
                "max_locations": 50,
                "max_matrix_distance": 200000,
                "max_matrix_location_pairs": 2500
            },
            "multimodal": {
                "max_distance": 500000,
                "max_locations": 50,
                "max_matrix_distance": 0,
                "max_matrix_location_pairs": 0
            },
            "transit": {
                "max_distance": 500000,
                "max_locations": 50,
                "max_matrix_distance": 200000,
                "max_matrix_location_pairs": 2500
            },
            "isochrone": {
                "max_contours": 4,
                "max_time": 120,
                "max_time_contour": 120,
                "max_distance": 25000,
                "max_distance_contour": 25000,
                "max_locations": 1
            },
            "trace": {
                "max_distance": 200000,
                "max_gps_accuracy": 100,
                "max_search_radius": 100,
                "max_heading_distance": 60,
                "max_matched_points": 100,
                "max_shape": 16000,
                "max_alternates": 0,
                "max_alternates_shape": 10000
            },
            "skadi": {
                "max_shape": 750000,
                "min_resample": 10.0
            },
            "status": {
                "allow_verbose": false
            }
        },
        "costing_options": {
            "auto": { "use_hills": 0.5 },
            "truck": { "use_hills": 0.1 }
        }
    };
}

export function calculateBoundingBox(locations: Array<{ lat: number; lon: number }>): BoundingBox {
    if (locations.length === 0) throw new Error('Empty location list');
    let minLat = locations[0].lat, maxLat = locations[0].lat, minLon = locations[0].lon, maxLon = locations[0].lon;
    for (const loc of locations) {
        minLat = Math.min(minLat, loc.lat); maxLat = Math.max(maxLat, loc.lat);
        minLon = Math.min(minLon, loc.lon); maxLon = Math.max(maxLon, loc.lon);
    }
    const latPadding = Math.max(0.1, (maxLat - minLat) * 0.1), lonPadding = Math.max(0.1, (maxLon - minLon) * 0.1);
    return { minLat: minLat - latPadding, maxLat: maxLat + latPadding, minLon: minLon - lonPadding, maxLon: maxLon + lonPadding };
}

