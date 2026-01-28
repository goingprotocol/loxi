// valhallaTilesLoader.ts

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

// ------------------------------------------------------------------
// 1. UTILIDADES MATEMÁTICAS
// ------------------------------------------------------------------

export function calculateBoundingBox(locations: Array<{ lat: number; lon: number }>, paddingKm: number = 20): BoundingBox {
    if (locations.length === 0) throw new Error('Empty location list');
    let minLat = locations[0].lat, maxLat = locations[0].lat, minLon = locations[0].lon, maxLon = locations[0].lon;

    for (const loc of locations) {
        minLat = Math.min(minLat, loc.lat); maxLat = Math.max(maxLat, loc.lat);
        minLon = Math.min(minLon, loc.lon); maxLon = Math.max(maxLon, loc.lon);
    }

    // 1 grado latitud ~= 111km.
    const paddingDeg = paddingKm / 111;

    return {
        minLat: minLat - paddingDeg,
        maxLat: maxLat + paddingDeg,
        minLon: minLon - paddingDeg,
        maxLon: maxLon + paddingDeg
    };
}

export function getTileIdFromCoord(lat: number, lon: number, level: number): TileCoord {
    const tileSize = level === 2 ? 0.25 : level === 1 ? 1.0 : 4.0;
    const x = Math.floor((lon + 180) / tileSize);
    const y = Math.floor((lat + 90) / tileSize);
    return { level, x, y };
}

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
    const url = `${tileServerUrl}/valhalla_tiles/${tilePath}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download tile ${tilePath}: ${response.statusText}`);
    return response.arrayBuffer();
}

export function loadTileIntoMEMFS(module: any, tile: TileCoord, data: ArrayBuffer): void {
    if (!module || !module.FS) throw new Error('Valhalla module FS not available.');
    const tilePath = tileToPath(tile);
    const fullPath = `/valhalla_tiles/${tilePath}`;

    // Crear directorios recursivamente
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
}

// ------------------------------------------------------------------
// 2. CACHÉ (IndexedDB)
// ------------------------------------------------------------------

class TileCache {
    private dbName = 'valhalla-tiles';
    private storeName = 'tiles';
    private db: IDBDatabase | null = null;
    private CACHE_VERSION = 'v6-smart-load'; // Incrementado

    async init(): Promise<void> {
        if (this.db) return Promise.resolve();
        const storedVersion = localStorage.getItem('valhalla_tile_cache_version');
        if (storedVersion !== this.CACHE_VERSION) {
            console.log(`🧹 Cache Mismatch. Purging...`);
            await new Promise<void>((resolve) => {
                const req = indexedDB.deleteDatabase(this.dbName);
                req.onsuccess = () => { localStorage.setItem('valhalla_tile_cache_version', this.CACHE_VERSION); resolve(); };
                req.onerror = () => resolve();
            });
        }
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => { this.db = request.result; resolve(); };
            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName);
            };
        });
    }

    async get(key: string): Promise<ArrayBuffer | null> {
        if (!this.db) await this.init();
        return new Promise((resolve) => {
            const tx = this.db!.transaction([this.storeName], 'readonly');
            const req = tx.objectStore(this.storeName).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    }

    async set(key: string, value: ArrayBuffer): Promise<void> {
        if (!this.db) await this.init();
        return new Promise((resolve) => {
            const tx = this.db!.transaction([this.storeName], 'readwrite');
            const req = tx.objectStore(this.storeName).put(value, key);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
        });
    }
}
const tileCache = new TileCache();

// ------------------------------------------------------------------
// 3. CARGA INTELIGENTE (LA ESTRATEGIA SÁNDWICH) 🥪
// ------------------------------------------------------------------

// NOTA: Renombré 'loadTilesForRegion' a 'loadSmartTiles' para que sepas cual es la nueva
export async function loadSmartTiles(
    module: any,
    locations: Array<{ lat: number; lon: number }>,
    tileServerUrl: string = 'http://localhost:8080',
    onProgress?: (loaded: number, total: number) => void
): Promise<void> {

    if (module && !module.FS) {
        let attempts = 0;
        while (!module.FS && attempts < 100) { await new Promise(r => setTimeout(r, 50)); attempts++; }
    }

    // A. Calcular Caja Global con 20km de padding para Rutas/Autopistas
    const bbox = calculateBoundingBox(locations, 20);

    let tilesToDownload: TileCoord[] = [];
    const uniqueKeys = new Set<string>();

    const addTile = (t: TileCoord) => {
        const key = `${t.level}-${t.x}-${t.y}`;
        if (!uniqueKeys.has(key)) {
            uniqueKeys.add(key);
            tilesToDownload.push(t);
        }
    };

    // PASO 1: Descargar Nivel 0 y 1 (Red Troncal) para TODO el viaje
    [0, 1].forEach(level => {
        calculateRequiredTiles(bbox, level).forEach(addTile);
    });

    // PASO 2: Descargar Nivel 2 (Calles) SOLO donde hay paradas (+ vecinos)
    locations.forEach(loc => {
        const centerTile = getTileIdFromCoord(loc.lat, loc.lon, 2);
        // Bajamos matriz de 3x3 tiles alrededor de la parada
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                addTile({ level: 2, x: centerTile.x + dx, y: centerTile.y + dy });
            }
        }
    });

    console.log(`📦 Estrategia Smart: Se cargarán ${tilesToDownload.length} tiles.`);
    console.log("📍 Puntos a cubrir:", locations.length);
    console.log("🗺️ BBox detectado:", bbox);
    console.log("📂 Tiles calculados:", tilesToDownload.map(t =>
        `L${t.level}: ${t.x}/${t.y} (Path: ${tileToPath(t)})`
    ));
    // PASO 3: Ejecutar carga
    let loaded = 0;
    for (const tile of tilesToDownload) {
        const tilePath = tileToPath(tile);
        let tileData = await tileCache.get(tilePath);
        if (!tileData) {
            try {
                tileData = await downloadTile(tile, tileServerUrl);
                await tileCache.set(tilePath, tileData);
            } catch (e) {
                console.warn(`⚠️ Tile faltante: ${tilePath} (Ignorando)`);
                continue;
            }
        }
        loadTileIntoMEMFS(module, tile, tileData!);
        loaded++;
        onProgress?.(loaded, tilesToDownload.length);
    }

    console.log("🔍 AUDITORÍA DE TILES EN MEMORIA (VFS):");
    let missingCount = 0;

    for (const tile of tilesToDownload) {
        const path = `/valhalla_tiles/${tileToPath(tile)}`;
        try {
            // Preguntamos al sistema de archivos de WASM si el archivo existe
            const stat = module.FS.stat(path);
            if (stat.size < 100) {
                console.warn(`⚠️ Tile corrupto o vacío: ${path} (${stat.size} bytes)`);
            }
        } catch (e) {
            console.error(`❌ TILE FALTANTE CRÍTICO: ${path}`);
            missingCount++;
        }
    }

    if (missingCount === 0) {
        console.log(`✅ Todos los ${tilesToDownload.length} tiles están correctamente escritos en memoria.`);
    } else {
        console.error(`🚨 FALTAN ${missingCount} TILES. Valhalla va a fallar.`);
    }

    // PASO 4: Inicializar con Configuración Eficiente
    await initializeValhallaConfig(module);
    await initializeValhallaEngine(module);
}

// ------------------------------------------------------------------
// 4. CONFIGURACIÓN "ECO-FRIENDLY" (Eficiente) 🌿
// ------------------------------------------------------------------

function getGoldenTemplate() {
    const efficientHierarchy = {
        "expand_within_distance": { "0": 5000000.0, "1": 50000.0, "2": 5000.0 },
        "max_up_transitions": { "1": 500, "2": 100 }
    };
    return {
        "additional_data": {},
        "httpd": {
            "service": {
                "drain_seconds": 28,
                "interrupt": "ipc:///tmp/interrupt",
                "listen": "tcp://*:8002",
                "loopback": "ipc:///tmp/loopback",
                "shutdown_seconds": 1,
                "timeout_seconds": -1
            }
        },
        "loki": {
            "actions": ["locate", "route", "status", "tile"],
            "logging": {
                "color": true,
                "file_name": "path_to_some_file.log",
                "long_request": 100.0,
                "type": "std_out"
            },
            "service": { "proxy": "ipc:///tmp/loki" },
            "service_defaults": {
                "heading_tolerance": 60,
                "minimum_reachability": 50,
                "mvt_cache_min_zoom": 11,
                "mvt_min_zoom_road_class": [7, 7, 8, 11, 11, 12, 13, 14],
                "node_snap_tolerance": 5,
                "radius": 200,
                "search_cutoff": 35000,
                "street_side_max_distance": 1000,
                "street_side_tolerance": 5
            },
            "use_connectivity": true
        },
        "meili": {
            "auto": { "search_radius": 50, "turn_penalty_factor": 200 },
            "bicycle": { "turn_penalty_factor": 140 },
            "customizable": ["mode", "search_radius", "turn_penalty_factor", "gps_accuracy", "interpolation_distance", "sigma_z", "beta", "max_route_distance_factor", "max_route_time_factor"],
            "default": {
                "beta": 3,
                "breakage_distance": 2000,
                "geometry": false,
                "gps_accuracy": 5.0,
                "interpolation_distance": 10,
                "max_route_distance_factor": 5,
                "max_route_time_factor": 5,
                "max_search_radius": 100,
                "route": true,
                "search_radius": 50,
                "sigma_z": 4.07,
                "turn_penalty_factor": 0
            },
            "grid": { "cache_size": 100240, "size": 500 },
            "logging": { "color": true, "file_name": "path_to_some_file.log", "type": "std_out" },
            "mode": "auto",
            "multimodal": { "turn_penalty_factor": 70 },
            "pedestrian": { "search_radius": 50, "turn_penalty_factor": 100 },
            "service": { "proxy": "ipc:///tmp/meili" },
            "verbose": false
        },
        "mjolnir": {
            // 🛑 LIMPIEZA: Quitamos admin, timezone, tile_extract, traffic_extract
            // Solo dejamos la configuración de procesamiento y directorios válidos
            "data_processing": {
                "allow_alt_name": false,
                "apply_country_overrides": true,
                "grid_divisions_within_tile": 32,
                "infer_internal_intersections": true,
                "infer_turn_channels": true,
                "scan_tar": false,
                "use_admin_db": false,
                "use_direction_on_ways": false,
                "use_rest_area": false,
                "use_urban_tag": false
            },
            "global_synchronized_cache": false,
            "hierarchy": true,
            "id_table_size": 13000000,
            "import_bike_share_stations": false,
            "include_bicycle": true,
            "include_construction": false,
            "include_driveways": true,
            "include_driving": true,
            "include_pedestrian": true,
            "include_platforms": false,
            "keep_all_osm_node_ids": false,
            "keep_osm_node_ids": false,
            "logging": { "color": true, "file_name": "path_to_some_file.log", "type": "std_out" },
            "lru_mem_cache_hard_control": false,
            "max_cache_size": 1000000000,
            "max_concurrent_reader_users": 1,
            "reclassify_links": true,
            "shortcuts": true,
            "tile_dir": "/valhalla_tiles",
            // "tile_extract": "", // Eliminado
            // "admin": "", // Eliminado
            // "timezone": "", // Eliminado
            "transit_dir": "/data/valhalla/transit", // Puede quedarse si está vacío
            "transit_feeds_dir": "/data/valhalla/transit_feeds",
            "transit_pbf_limit": 20000,
            "use_lru_mem_cache": false,
            "use_simple_mem_cache": false
        },
        "odin": {
            "logging": { "color": true, "file_name": "path_to_some_file.log", "type": "std_out" },
            "markup_formatter": {
                "markup_enabled": false,
                "phoneme_format": "<TEXTUAL_STRING> (<span class=<QUOTES>phoneme<QUOTES>>/<VERBAL_STRING>/</span>)"
            },
            "service": { "proxy": "ipc:///tmp/odin" }
        },
        "service_limits": {
            "allow_hard_exclusions": false,
            "auto": { "max_distance": 5000000.0, "max_locations": 20, "max_matrix_distance": 400000.0, "max_matrix_location_pairs": 2500 },
            "bicycle": { "max_distance": 500000.0, "max_locations": 50, "max_matrix_distance": 200000.0, "max_matrix_location_pairs": 2500 },
            "bikeshare": { "max_distance": 500000.0, "max_locations": 50, "max_matrix_distance": 200000.0, "max_matrix_location_pairs": 2500 },
            "bus": { "max_distance": 5000000.0, "max_locations": 50, "max_matrix_distance": 400000.0, "max_matrix_location_pairs": 2500 },
            "centroid": { "max_distance": 200000.0, "max_locations": 5 },
            "hierarchy_limits": {
                "allow_modification": false,
                "bidirectional_astar": {
                    "max_allowed_up_transitions": efficientHierarchy.max_up_transitions,
                    "max_expand_within_distance": efficientHierarchy.expand_within_distance
                },
                "costmatrix": {
                    "max_allowed_up_transitions": efficientHierarchy.max_up_transitions,
                    "max_expand_within_distance": efficientHierarchy.expand_within_distance
                },
                "unidirectional_astar": {
                    "max_allowed_up_transitions": efficientHierarchy.max_up_transitions,
                    "max_expand_within_distance": efficientHierarchy.expand_within_distance
                },
                "matrix": {
                    "max_distance": 50000000.0,
                    "max_locations": 10000,
                    "max_matrix_distance": 50000000.0,
                    "max_matrix_location_pairs": 100000000
                },
            },
            "isochrone": { "max_contours": 4, "max_distance": 25000.0, "max_distance_contour": 200, "max_locations": 1, "max_time_contour": 120 },
            "max_alternates": 2,
            "max_distance_disable_hierarchy_culling": 0,
            "max_exclude_locations": 50,
            "max_exclude_polygons_length": 10000,
            "max_linear_cost_edges": 50000,
            "max_radius": 200,
            "max_reachability": 100,
            "max_timedep_distance": 500000,
            "max_timedep_distance_matrix": 0,
            "min_linear_cost_factor": 1,
            "motor_scooter": { "max_distance": 500000.0, "max_locations": 50, "max_matrix_distance": 200000.0, "max_matrix_location_pairs": 2500 },
            "motorcycle": { "max_distance": 500000.0, "max_locations": 50, "max_matrix_distance": 200000.0, "max_matrix_location_pairs": 2500 },
            "multimodal": { "max_distance": 500000.0, "max_locations": 50, "max_matrix_distance": 0.0, "max_matrix_location_pairs": 0 },
            "pedestrian": { "max_distance": 250000.0, "max_locations": 50, "max_matrix_distance": 200000.0, "max_matrix_location_pairs": 2500, "max_transit_walking_distance": 10000, "min_transit_walking_distance": 1 },
            "skadi": { "max_shape": 750000, "min_resample": 10.0 },
            "status": { "allow_verbose": false },
            "taxi": { "max_distance": 5000000.0, "max_locations": 20, "max_matrix_distance": 400000.0, "max_matrix_location_pairs": 2500 },
            "trace": { "max_alternates": 3, "max_alternates_shape": 100, "max_distance": 200000.0, "max_gps_accuracy": 100.0, "max_search_radius": 100.0, "max_shape": 16000 },
            "transit": { "max_distance": 500000.0, "max_locations": 50, "max_matrix_distance": 200000.0, "max_matrix_location_pairs": 2500 },
            "truck": { "max_distance": 5000000.0, "max_locations": 20, "max_matrix_distance": 400000.0, "max_matrix_location_pairs": 2500 }
        },
        "statsd": { "port": 8125, "prefix": "valhalla" },
        "thor": {
            "bidirectional_astar": {
                "alternative_cost_extend": 1.2,
                "alternative_iterations_delta": 100000,
                "hierarchy_limits": {
                    "expand_within_distance": efficientHierarchy.expand_within_distance,
                    "max_up_transitions": efficientHierarchy.max_up_transitions
                },
                "threshold_delta": 420.0
            },
            "clear_reserved_memory": false,
            "costmatrix": {
                "allow_second_pass": false,
                "check_reverse_connection": true,
                "hierarchy_limits": efficientHierarchy.expand_within_distance,
                "max_iterations": 2800,
                "max_reserved_locations": 25,
                "min_iterations": 100
            },
            "extended_search": false,
            "logging": { "color": true, "file_name": "path_to_some_file.log", "long_request": 110.0, "type": "std_out" },
            "max_reserved_labels_count_astar": 2000000,
            "max_reserved_labels_count_bidir_astar": 1000000,
            "max_reserved_labels_count_bidir_dijkstras": 2000000,
            "max_reserved_labels_count_dijkstras": 4000000,
            "service": { "proxy": "ipc:///tmp/thor" },
            "source_to_target_algorithm": "select_optimal",
            "unidirectional_astar": {
                "hierarchy_limits": {
                    "expand_within_distance": efficientHierarchy.expand_within_distance,
                    "max_up_transitions": efficientHierarchy.max_up_transitions
                }
            }
        }
    };
}
// ------------------------------------------------------------------
// 5. INICIALIZACIÓN
// ------------------------------------------------------------------

export async function initializeValhallaConfig(module: any): Promise<void> {
    try {
        ['/valhalla_tiles', '/valhalla_tiles/0', '/valhalla_tiles/1', '/valhalla_tiles/2'].forEach(dir => {
            if (!module.FS.analyzePath(dir).exists) module.FS.mkdir(dir);
        });
    } catch (e) { }

    const template = getGoldenTemplate();
    const config = JSON.parse(JSON.stringify(template));

    // Limpieza de paths
    delete (config.mjolnir as any).admin;
    delete (config.mjolnir as any).timezone;
    delete (config.mjolnir as any).elevation;
    delete (config.mjolnir as any).tile_extract;
    delete (config.mjolnir as any).traffic_extract;
    // 🧹 LIMPIEZA DE MEMORIA: Borramos el archivo viejo si existe
    try {
        module.FS.unlink('/valhalla.json');
        console.log("🧹 Configuración antigua borrada.");
    } catch (e) {
        // Si no existe, no pasa nada
    }

    module.FS.writeFile('/valhalla.json', JSON.stringify(config));
    console.log("📝 Configuración escrita en VFS.");
}

export async function initializeValhallaEngine(module: any): Promise<void> {
    if (module.valhallaInitialized) return;

    try {
        console.log("🔌 Inicializando Motor Valhalla...");
        // @ts-ignore
        const result = module.ccall("init_valhalla", "number", ["string"], ["/valhalla.json"]);

        if (result === 0) {
            console.log(`✅ Valhalla Inicializado (Code 0)`);
            module.valhallaInitialized = true;
        } else {
            // Probe de vida
            const dummy = JSON.stringify({ locations: [{ lat: -34.6, lon: -58.4 }, { lat: -34.61, lon: -58.41 }], costing: "auto" });
            const res = module.ccall("valhalla_matrix", "string", ["string"], [dummy]);
            if (!res.includes("Valhalla not initialized")) {
                console.log("✅ El motor responde correctamente.");
                module.valhallaInitialized = true;
            } else {
                throw new Error(`Fallo crítico: ${res}`);
            }
        }
    } catch (e) {
        console.error("❌ Error fatal iniciando Valhalla:", e);
        throw e;
    }
}