/**
 * Valhalla Resource Manager
 * 
 * Unified system for loading Valhalla resources (WASM, config, tiles) from any source:
 * - Local development: /artifacts/
 * - Remote architect: http://architect-url/artifacts/
 * 
 * @typedef {Object} ValhallaResourceConfig
 * @property {string} baseUrl - Base URL for downloading resources (e.g., "http://localhost:8080")
 * @property {string} [wasmPath] - Path to WASM file (default: "valhalla_engine.wasm")
 * @property {string} [configPath] - Path to config file (default: "valhalla.json")
 * @property {string} [tilesPath] - Path to tiles directory (default: "valhalla_tiles")
 */

export class ValhallaResourceManager {
    /**
     * @param {ValhallaResourceConfig} config
     */
    constructor(config) {
        this.config = {
            wasmPath: 'valhalla_engine.wasm',
            configPath: 'valhalla.json',
            tilesPath: 'valhalla_tiles',
            ...config
        };

        /** @type {EmscriptenModule | null} */
        this.module = null;

        /** @type {Promise<EmscriptenModule> | null} */
        this.loadingPromise = null;

        // Make available globally for Emscripten callbacks
        globalThis.ValhallaResourceManager = this;

        // Initialize Cache
        this.initCache();
    }

    /**
     * Initialize Valhalla engine with dynamic resource loading
     * @returns {Promise<EmscriptenModule>}
     */
    async initialize() {
        if (this.module) {
            return this.module;
        }

        if (this.loadingPromise) {
            return this.loadingPromise;
        }

        this.loadingPromise = this.loadValhallaEngine();
        return this.loadingPromise;
    }

    /**
     * @private
     * @returns {Promise<EmscriptenModule>}
     */
    async loadValhallaEngine() {
        // Robust Base URL detection: ensure /logistics is exactly once at the end
        let safeBase = this.config.baseUrl.replace(/\/$/, "");
        if (!safeBase.endsWith("/logistics")) {
            safeBase = `${safeBase}/logistics`;
        }

        console.log(`🏋️ Initializing Valhalla from: ${safeBase}`);

        const self = this;
        const engineUrl = `${safeBase}/assets/valhalla/valhalla_engine.js`;

        // Setup Emscripten Module Config
        const ModuleConfig = {
            locateFile: (path) => {
                const fileName = path.endsWith('.wasm') ? self.config.wasmPath : path;
                // Ensure assets/valhalla prefix if not already present in fileName
                const finalPath = fileName.startsWith('assets/') ? fileName : `assets/valhalla/${fileName}`;
                const resultUrl = `${safeBase}/${finalPath}`.replace(/\/logistics\/logistics/, "/logistics");
                return resultUrl;
            },
            print: (text) => console.log("[VALHALLA]", text),
            printErr: (text) => console.warn("[VALHALLA ERR]", text),
            // Essential bridge for C++ to fetch tiles via JS
            rust_lazy_fs_read: globalThis.rust_lazy_fs_read
        };

        try {
            // Load Emscripten JS via Dynamic Import (Worker-safe & Agnostic)
            const m = await import(engineUrl);
            const ValhallaModule = m.default;

            if (typeof ValhallaModule !== 'function') {
                throw new Error("ValhallaModule factory not found in engine script.");
            }

            const instance = await ValhallaModule({
                ...ModuleConfig,
                INITIAL_MEMORY: 1536 * 1024 * 1024, // 1.5GB (Headroom for 500x500 matrix)
            });
            self.module = instance;
            console.log("✅ Valhalla WASM Factory Initialized (Memory Cap Requested)");

            if (self.module.wasmMemory) {
                console.log(`🧠 Initial Memory Size: ${self.module.wasmMemory.buffer.byteLength} bytes`);
            }

            // Setup tile fetching bridge
            self.setupTileFetcher(self.module);

            // Initialize Valhalla with config
            await self.loadConfig(safeBase);
            return self.module;

        } catch (err) {
            this.loadingPromise = null;
            console.error("❌ Valhalla Engine Loading Failed:", err);
            throw err;
        }
    }

    /**
     * Setup dynamic tile fetching from architect
     * @private
     * @param {EmscriptenModule} Module
     */
    setupTileFetcher(Module) {
        const self = this;
        const globalScope = globalThis;

        globalScope.rust_lazy_fs_read = function (pathPtr, offsetLow, offsetHigh, length, bufferPtr) {
            const url = Module.UTF8ToString(pathPtr);
            const offset = (offsetLow >>> 0);

            try {
                let fetchPath = url;
                if (url.startsWith('http://lazyfs/')) {
                    fetchPath = url.replace('http://lazyfs/', '');
                }

                const memfsPath = `/${self.config.tilesPath}/${fetchPath}`;

                // 1. Try Memory First (MEMFS)
                if (length === 0) {
                    try {
                        const stat = Module.FS.stat(memfsPath);
                        return stat.size;
                    } catch (e) { /* fallback below */ }
                } else {
                    try {
                        const data = Module.FS.readFile(memfsPath);
                        const slice = data.subarray(offset, Math.min(offset + length, data.length));
                        if (bufferPtr !== 0) {
                            Module.HEAPU8.set(slice, bufferPtr);
                        }
                        return slice.length;
                    } catch (e) { /* fallback below */ }
                }

                // 2. Fallback to Sync XHR (Network)
                let safeBase = self.config.baseUrl.replace(/\/$/, "");
                if (!safeBase.endsWith("/logistics")) {
                    safeBase = `${safeBase}/logistics`;
                }
                const requestUrl = `${safeBase}/tiles/${fetchPath}`.replace(/\/logistics\/logistics/, "/logistics");

                const xhr = new XMLHttpRequest();

                if (length === 0) {
                    xhr.open("HEAD", requestUrl, false);
                    xhr.send();
                    if (xhr.status === 200) return parseInt(xhr.getResponseHeader("Content-Length") || "0");
                } else {
                    xhr.open("GET", requestUrl, false);
                    const end = offset + length - 1;
                    xhr.setRequestHeader("Range", `bytes=${offset}-${end}`);
                    xhr.responseType = "arraybuffer";
                    xhr.send();

                    if (xhr.status === 200 || xhr.status === 206) {
                        const arrayBuffer = xhr.response;
                        const data = new Uint8Array(arrayBuffer);

                        if (xhr.status === 200 && offset === 0) {
                            self.tileCache.saveTile(fetchPath, arrayBuffer);
                        }

                        if (bufferPtr !== 0) {
                            Module.HEAPU8.set(data, bufferPtr);
                        }
                        return data.length;
                    }
                }
            } catch (e) {
                console.error("❌ Sync Bridge Error:", e);
            }
            return -1;
        };
    }

    /**
     * Regional Warmup: Loads tiles from IndexedDB to MEMFS before routing.
     * @param {Array<{lat: number, lon: number}>} locations
     */
    async warmupRegionalCache(locations) {
        if (!this.module || !locations?.length) return;

        const bbox = this.calculateBoundingBox(locations, 20);
        const tilesToWarm = [];
        const uniqueKeys = new Set();

        const addTile = (level, x, y) => {
            const key = `${level}-${x}-${y}`;
            if (!uniqueKeys.has(key)) {
                uniqueKeys.add(key);
                tilesToWarm.push({ level, x, y });
            }
        };

        [0, 1].forEach(level => {
            const size = level === 1 ? 1.0 : 4.0;
            const startX = Math.floor((bbox.minLon + 180) / size);
            const endX = Math.floor((bbox.maxLon + 180) / size);
            const startY = Math.floor((bbox.minLat + 90) / size);
            const endY = Math.floor((bbox.maxLat + 90) / size);
            for (let x = startX; x <= endX; x++) {
                for (let y = startY; y <= endY; y++) addTile(level, x, y);
            }
        });

        locations.forEach(loc => {
            const size = 0.25;
            const cx = Math.floor((loc.lon + 180) / size);
            const cy = Math.floor((loc.lat + 90) / size);
            const radius = locations.length > 50 ? 0 : 1;
            for (let dx = -radius; dx <= radius; dx++) {
                for (let dy = -radius; dy <= radius; dy++) addTile(2, cx + dx, cy + dy);
            }
        });

        const MAX_L2_TILES = 0;
        let l2Count = 0;
        const finalTiles = tilesToWarm.filter(t => {
            if (t.level < 2) return true;
            if (l2Count < MAX_L2_TILES) {
                l2Count++;
                return true;
            }
            return false;
        });

        console.log(`🧊 Warming up regional cache for ${finalTiles.length} tiles (L2 Capped at ${MAX_L2_TILES})...`);

        let loaded = 0;
        const warmupPromises = finalTiles.map(async (tile) => {
            const tilePath = this.tileToPath(tile);

            try {
                if (this.module.FS.analyzePath(`/${this.config.tilesPath}/${tilePath}`).exists) return;
            } catch (e) { }

            const data = await this.tileCache.getTile(tilePath);
            if (data) {
                const fullPath = `/${this.config.tilesPath}/${tilePath}`;
                const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
                try {
                    this.module.FS.mkdirTree(dir);
                    this.module.FS.writeFile(fullPath, new Uint8Array(data));
                    loaded++;
                } catch (e) { }
            }
        });

        await Promise.all(warmupPromises);
        console.log(`✅ Regional Warmup Complete: ${loaded} tiles loaded to RAM.`);
    }

    calculateBoundingBox(locations, paddingKm) {
        let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
        locations.forEach(l => {
            minLat = Math.min(minLat, l.lat); maxLat = Math.max(maxLat, l.lat);
            minLon = Math.min(minLon, l.lon); maxLon = Math.max(maxLon, l.lon);
        });
        const pad = paddingKm / 111;
        return {
            minLat: minLat - pad, maxLat: maxLat + pad,
            minLon: minLon - pad, maxLon: maxLon + pad
        };
    }

    tileToPath(tile) {
        const tileSize = tile.level === 2 ? 0.25 : tile.level === 1 ? 1.0 : 4.0;
        const nColumns = Math.floor(360 / tileSize);
        const tileId = (tile.y * nColumns) + tile.x;
        const p1 = Math.floor(tileId / 1000000).toString().padStart(3, '0');
        const p2 = Math.floor((tileId % 1000000) / 1000).toString().padStart(3, '0');
        const p3 = (tileId % 1000).toString().padStart(3, '0');
        return tile.level === 2 ? `${tile.level}/${p1}/${p2}/${p3}.gph` : `${tile.level}/${p2}/${p3}.gph`;
    }

    initCache() {
        this.tileCache = {
            DB_NAME: 'LoxiTileCache',
            STORE_NAME: 'tiles',
            DB_VERSION: 1,
            dbPromise: null,
            MAX_TILES: 1000,

            openDB: function () {
                if (this.dbPromise) return this.dbPromise;
                this.dbPromise = new Promise((resolve, reject) => {
                    if (typeof indexedDB === 'undefined') {
                        reject("IndexedDB not supported");
                        return;
                    }
                    const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
                    req.onupgradeneeded = (e) => {
                        const db = e.target.result;
                        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                            const store = db.createObjectStore(this.STORE_NAME);
                            store.createIndex('lastUsed', 'lastUsed', { unique: false });
                        }
                    };
                    req.onsuccess = (e) => resolve(e.target.result);
                    req.onerror = () => reject("DB Open Error");
                });
                return this.dbPromise;
            },

            saveTile: async function (path, data) {
                try {
                    const db = await this.openDB();
                    const tx = db.transaction(this.STORE_NAME, "readwrite");
                    const store = tx.objectStore(this.STORE_NAME);
                    store.put({ data, lastUsed: Date.now() }, path);
                    this.cleanup(db);
                } catch (e) { }
            },

            getTile: async function (path) {
                try {
                    const db = await this.openDB();
                    const tx = db.transaction(this.STORE_NAME, "readwrite");
                    const store = tx.objectStore(this.STORE_NAME);
                    const req = store.get(path);
                    return await new Promise((resolve) => {
                        req.onsuccess = () => {
                            if (req.result) {
                                req.result.lastUsed = Date.now();
                                store.put(req.result, path);
                                resolve(req.result.data);
                            } else { resolve(null); }
                        };
                        req.onerror = () => resolve(null);
                    });
                } catch (e) { return null; }
            },

            cleanup: async function (db) {
                const tx = db.transaction(this.STORE_NAME, "readwrite");
                const store = tx.objectStore(this.STORE_NAME);
                const countReq = store.count();
                countReq.onsuccess = () => {
                    if (countReq.result > this.MAX_TILES) {
                        const index = store.index('lastUsed');
                        const cursorReq = index.openCursor();
                        let deleted = 0;
                        const toDelete = countReq.result - this.MAX_TILES;
                        cursorReq.onsuccess = (e) => {
                            const cursor = e.target.result;
                            if (cursor && deleted < toDelete) {
                                cursor.delete();
                                deleted++;
                                cursor.continue();
                            }
                        };
                    }
                };
            }
        };
        this.tileCache.openDB().catch(e => console.warn("Cache Init Failed:", e));
    }

    async warmUpCache() { return 0; }

    async loadConfig(safeBase) {
        if (!this.module?.FS) throw new Error("Emscripten FS not available");
        const configUrl = `${safeBase}/assets/valhalla/${this.config.configPath}`.replace(/\/logistics\/logistics/, "/logistics");
        const response = await fetch(configUrl);
        if (!response.ok) throw new Error(`Failed to load config: ${response.statusText}`);
        const configData = await response.arrayBuffer();
        try { this.module.FS.mkdir('/artifacts'); } catch (e) { }
        this.module.FS.writeFile('/artifacts/valhalla.json', new Uint8Array(configData));
        try { this.module.FS.mkdir('/' + this.config.tilesPath); } catch (e) { }
        const result = this.module.ccall('init_valhalla', 'number', ['string'], ['/artifacts/valhalla.json']);
        if (result !== 0) throw new Error(`Valhalla initialization failed with code: ${result}`);
        console.log("🎉 Valhalla engine initialized successfully");
    }

    async calculateMatrix(request) {
        if (!this.module) throw new Error("Valhalla not initialized");
        const requestJson = JSON.stringify(request);
        const resultJson = this.module.ccall('valhalla_matrix', 'string', ['string'], [requestJson]);
        return JSON.parse(resultJson);
    }

    async calculateRoute(request) {
        if (!this.module) throw new Error("Valhalla not initialized");
        const requestJson = JSON.stringify(request);
        const resultJson = this.module.ccall('valhalla_route', 'string', ['string'], [requestJson]);
        return JSON.parse(resultJson);
    }

    getModule() { return this.module; }
}

export function createValhallaManager(baseUrl) {
    return new ValhallaResourceManager({ baseUrl });
}
