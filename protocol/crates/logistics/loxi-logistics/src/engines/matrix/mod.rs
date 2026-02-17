use crate::types::Problem;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ValhallaLocation {
    pub lat: f64,
    pub lon: f64,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub location_type: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ValhallaProblem {
    pub sources: Vec<ValhallaLocation>,
    pub targets: Vec<ValhallaLocation>,
    pub costing: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub costing_options: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ValhallaSolution {
    pub sources_to_targets: Vec<Vec<RoutingCost>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ValhallaError {
    pub error: String,
    pub status_code: Option<u16>,
    pub status: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RoutingCost {
    pub distance: f64,
    pub time: f64,
    pub from_index: Option<usize>,
    pub to_index: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RoutesProblem {
    pub routes: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RoutesResponse {
    pub routes: Vec<serde_json::Value>,
}

pub mod valhalla_sys;
pub use valhalla_sys::ValhallaEngine;

// Link to the native Valhalla engine (Phase 2 Unified WASM)
pub struct MatrixEngine;

impl MatrixEngine {
    pub fn calculate(request_json: &str) -> Result<Vec<u8>, String> {
        #[cfg(all(any(target_arch = "wasm32", target_arch = "wasm64"), feature = "include_wasm"))]
        {
            // Auto-initialize if needed
            static mut INITIALIZED: bool = false;
            unsafe {
                if !INITIALIZED {
                    let _ = Self::init("/artifacts/valhalla.json");
                    INITIALIZED = true;
                }
            }
            valhalla_sys::ValhallaEngine::matrix(request_json)
        }
        #[cfg(not(all(
            any(target_arch = "wasm32", target_arch = "wasm64"),
            feature = "include_wasm"
        )))]
        {
            let _ = request_json;
            Err("Matrix calculation via Valhalla is currently handled as an external WASM module."
                .to_string())
        }
    }

    pub fn calculate_route(request_json: &str) -> Result<Vec<u8>, String> {
        #[cfg(all(any(target_arch = "wasm32", target_arch = "wasm64"), feature = "include_wasm"))]
        {
            // 1. Initialize Valhalla if needed
            static mut INITIALIZED: bool = false;
            unsafe {
                if !INITIALIZED {
                    let _ = Self::init("/artifacts/valhalla.json");
                    INITIALIZED = true;
                }
            }

            // 2. Parse the high-level RoutesProblem (Multiple routes)
            let problem: RoutesProblem = serde_json::from_str(request_json)
                .map_err(|e| format!("Failed to parse RoutesProblem: {}", e))?;

            let mut final_routes = Vec::new();

            for route_val in problem.routes {
                // Each route_val is expected to have { id, stops: [{ location: {lat, lon} }] }
                let stops = route_val
                    .get("stops")
                    .and_then(|v| v.as_array())
                    .ok_or("Route missing stops array")?;

                if stops.len() < 2 {
                    continue;
                }

                // 3. Construct Valhalla-specific route request for THIS route
                let locations: Vec<ValhallaLocation> = stops
                    .iter()
                    .enumerate()
                    .map(|(i, s)| {
                        let loc = s.get("location").ok_or("Stop missing location")?;
                        let lat = loc.get("lat").and_then(|v| v.as_f64()).ok_or("lat missing")?;
                        let lon = loc.get("lon").and_then(|v| v.as_f64()).ok_or("lon missing")?;

                        // Native Valhalla expects decimal degrees (E6 conversion if needed)
                        let from_e6 = |v: f64| if v.abs() > 180.0 { v / 1000000.0 } else { v };

                        // Use 'through' for intermediate points to join all segments into a single leg
                        let loc_type =
                            if i == 0 || i == stops.len() - 1 { "break" } else { "through" };

                        Ok(ValhallaLocation {
                            lat: from_e6(lat),
                            lon: from_e6(lon),
                            location_type: Some(loc_type.to_string()),
                        })
                    })
                    .collect::<Result<Vec<_>, String>>()?;

                let v_request = serde_json::json!({
                    "locations": locations,
                    "costing": "auto",
                    "costing_options": {
                        "auto": {
                            "ignore_access": true,
                            "ignore_oneways": true,
                            "ignore_restrictions": true
                        }
                    }
                });

                let v_req_json = serde_json::to_string(&v_request).unwrap();

                // 4. Call Native Valhalla
                let resp_bytes = valhalla_sys::ValhallaEngine::route(&v_req_json)?;
                let resp_json: serde_json::Value = serde_json::from_slice(&resp_bytes)
                    .map_err(|_| "Valhalla route result is not valid JSON")?;

                // 5. Extract Shape (trip -> legs[0] -> shape)
                let shape = resp_json
                    .get("trip")
                    .and_then(|t| t.get("legs"))
                    .and_then(|l| l.as_array())
                    .and_then(|a| a.first())
                    .and_then(|f| f.get("shape"))
                    .and_then(|s| s.as_str())
                    .unwrap_or("");

                // 6. Build summarized route object
                let mut final_route = route_val.clone();
                if let Some(obj) = final_route.as_object_mut() {
                    obj.insert("shape".to_string(), serde_json::Value::String(shape.to_string()));
                }
                final_routes.push(final_route);
            }

            let response = RoutesResponse { routes: final_routes };
            serde_json::to_vec(&response)
                .map_err(|e| format!("failed to serialize RoutesResponse: {}", e))
        }
        #[cfg(not(all(
            any(target_arch = "wasm32", target_arch = "wasm64"),
            feature = "include_wasm"
        )))]
        {
            let _ = request_json;
            Err("Route calculation via Valhalla is currently handled as an external WASM module."
                .to_string())
        }
    }

    pub fn calculate_matrices_for_problem(
        problem: &Problem,
    ) -> Result<(Vec<Vec<f64>>, Vec<Vec<u32>>), String> {
        let mut locations = Vec::new();

        // 1. Collect all unique locations in order
        locations.push(problem.vehicle.start_location);
        for stop in &problem.stops {
            locations.push(stop.location);
        }
        if let Some(end_loc) = problem.vehicle.end_location {
            locations.push(end_loc);
        }

        // 2. Build Valhalla Request
        let v_locations: Vec<ValhallaLocation> = locations
            .iter()
            .map(|l| {
                let (lat, lon) = l.to_f64();
                ValhallaLocation { lat, lon, location_type: None }
            })
            .collect();

        let request = ValhallaProblem {
            sources: v_locations.clone(),
            targets: v_locations.clone(),
            costing: "auto".to_string(),
            costing_options: Some(serde_json::json!({
                "auto": {
                    "ignore_access": true,
                    "ignore_oneways": true,
                    "ignore_restrictions": true
                }
            })),
        };

        let request_json =
            serde_json::to_string(&request).map_err(|e| format!("Serialization failed: {}", e))?;

        println!("🌐 [MatrixEngine] Requesting Matrix for {} locations", v_locations.len());

        // --- DEBUG: Log Request Coordinates ---
        web_sys::console::log_1(
            &format!("🌐 [Valhalla] Requesting Matrix for {} locations", v_locations.len()).into(),
        );
        // --------------------------------------

        // 3. Call Native Valhalla (Returns Vec<u8>)
        let response_bytes = Self::calculate(&request_json)?;

        println!(
            "✅ [MatrixEngine] Raw calculation returned successfully! (Length: {} bytes)",
            response_bytes.len()
        );

        // --- DEBUG: Log Raw Response ---
        web_sys::console::log_1(
            &format!(
                "✅ [Rust] MatrixEngine::calculate returned successfully! (Length: {} bytes)",
                response_bytes.len()
            )
            .into(),
        );
        // -------------------------------

        // Try to parse as Success from Slice (Zero-Copy JSON)
        let solution: ValhallaSolution = match serde_json::from_slice(&response_bytes) {
            Ok(sol) => sol,
            Err(_) => {
                // Try to parse as Error
                if let Ok(err) = serde_json::from_slice::<ValhallaError>(&response_bytes) {
                    return Err(format!(
                        "Valhalla Error [{}]: {}",
                        err.status_code.unwrap_or(0),
                        err.error
                    ));
                }
                // If neither, try to show snippet of raw content
                let snippet =
                    String::from_utf8_lossy(&response_bytes).chars().take(100).collect::<String>();
                return Err(format!("Deserialization failed. Raw content start: {}", snippet));
            }
        };

        // 4. Map back to matrices
        let size = locations.len();
        let mut dist_matrix = vec![vec![0.0; size]; size];
        let mut time_matrix = vec![vec![0; size]; size];

        for (from_idx, row) in solution.sources_to_targets.iter().enumerate() {
            for (to_idx, cost) in row.iter().enumerate() {
                dist_matrix[from_idx][to_idx] = cost.distance * 1000.0; // Valhalla returns km, but we want meters
                time_matrix[from_idx][to_idx] = cost.time as u32;
            }
        }

        Ok((dist_matrix, time_matrix))
    }

    pub fn init(config_json_path: &str) -> Result<(), String> {
        #[cfg(all(any(target_arch = "wasm32", target_arch = "wasm64"), feature = "include_wasm"))]
        {
            valhalla_sys::ValhallaEngine::init(config_json_path)
        }
        #[cfg(not(all(
            any(target_arch = "wasm32", target_arch = "wasm64"),
            feature = "include_wasm"
        )))]
        {
            let _ = config_json_path;
            Ok(())
        }
    }
}
