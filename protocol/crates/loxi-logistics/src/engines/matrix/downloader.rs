use std::collections::HashSet;
use std::path::PathBuf;

#[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
use std::fs;
#[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
use std::io::Write;

pub struct TileDownloader;

impl TileDownloader {
    /// Download tiles for a specific bounding box.
    /// Returns the path to the directory containing the tiles (Native) or a success message (WASM).
    pub async fn download_tiles(bbox: (f64, f64, f64, f64)) -> Result<PathBuf, String> {
        let (min_lon, min_lat, max_lon, max_lat) = bbox;
        let zoom = 12; // Standard zoom for routing tiles in this context

        let tiles = bbox_to_tiles(min_lon, min_lat, max_lon, max_lat, zoom);
        println!("TileDownloader: Need to fetch {} tiles for bbox {:?}", tiles.len(), bbox);

        let base_url = "https://tile.openstreetmap.org"; // Placeholder source, normally Valhalla MVT/PBF source
        let cache_dir = get_cache_dir();

        #[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
        {
            if !cache_dir.exists() {
                fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
            }
        }

        for (x, y, z) in tiles {
            let url = format!("{}/{}/{}/{}.png", base_url, z, x, y); // Using PNG for test, Valhalla uses PBF

            // Native Implementation
            #[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
            {
                let file_path = cache_dir.join(format!("{}_{}_{}.png", z, x, y));
                if !file_path.exists() {
                    println!("Fetching: {}", url);
                    match reqwest::get(&url).await {
                        Ok(resp) => {
                            if resp.status().is_success() {
                                let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
                                let mut file =
                                    fs::File::create(&file_path).map_err(|e| e.to_string())?;
                                file.write_all(&bytes).map_err(|e| e.to_string())?;
                            } else {
                                println!("Failed to fetch {}: Status {}", url, resp.status());
                            }
                        }
                        Err(e) => println!("Error fetching {}: {}", url, e),
                    }
                }
            }

            // WASM Implementation
            #[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
            {
                // In WASM, we can't block. We use fetch.
                // For this MVP, we just log that we would download it.
                // In a real WASM worker, we would store this in OPFS or cache API.
                use web_sys::console;
                let log_msg =
                    format!("WASM: Would fetch tile {} from {}", format!("{}_{}_{}", z, x, y), url);
                console::log_1(&log_msg.into());

                // Real implementation would involve:
                // let resp = reqwest::get(&url).await...
                // store_in_indexeddb(key, bytes)...
            }
        }

        Ok(cache_dir)
    }
}

fn get_cache_dir() -> PathBuf {
    #[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
    {
        PathBuf::from("/tmp/loxi_tiles")
    }
    #[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
    {
        PathBuf::from("/virtual/loxi_tiles")
    }
}

// Helper: Convert BBox to Tile Coordinates (Slippy Map)
fn bbox_to_tiles(
    min_lon: f64,
    min_lat: f64,
    max_lon: f64,
    max_lat: f64,
    zoom: u32,
) -> HashSet<(u32, u32, u32)> {
    let mut tiles = HashSet::new();

    let min_x = long2tile(min_lon, zoom);
    let max_x = long2tile(max_lon, zoom);
    let min_y = lat2tile(max_lat, zoom); // Lat is inverted (max lat = min y)
    let max_y = lat2tile(min_lat, zoom);

    for x in min_x..=max_x {
        for y in min_y..=max_y {
            tiles.insert((x, y, zoom));
        }
    }
    tiles
}

fn long2tile(lon: f64, zoom: u32) -> u32 {
    let n = 2.0_f64.powi(zoom as i32);
    ((lon + 180.0) / 360.0 * n).floor() as u32
}

fn lat2tile(lat: f64, zoom: u32) -> u32 {
    let n = 2.0_f64.powi(zoom as i32);
    let lat_rad = lat.to_radians();
    ((1.0 - lat_rad.tan().asinh() / std::f64::consts::PI) / 2.0 * n).floor() as u32
}
