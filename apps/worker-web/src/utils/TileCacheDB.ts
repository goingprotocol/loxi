// IndexedDB Tile Cache
// Shared between Main Thread and Workers to avoid redownloading tiles.

const DB_NAME = 'LoxiTileCache';
const STORE_NAME = 'tiles';
const DB_VERSION = 1;

export const openDB = (): Promise<IDBDatabase> => {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e: any) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        req.onsuccess = (e: any) => resolve(e.target.result);
        req.onerror = (e) => reject("DB Open Error");
    });
};

export const saveTile = async (path: string, data: ArrayBuffer) => {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(data, path);
    } catch (e) { console.warn("Cache Write Failed", e); }
};

export const getTile = async (path: string): Promise<ArrayBuffer | undefined> => {
    return new Promise(async (resolve) => {
        try {
            const db = await openDB();
            const tx = db.transaction(STORE_NAME, "readonly");
            const req = tx.objectStore(STORE_NAME).get(path);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(undefined);
        } catch (e) { resolve(undefined); }
    });
};
