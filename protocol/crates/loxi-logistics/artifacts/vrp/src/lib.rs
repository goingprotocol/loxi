use loxi_types::{Problem, Solution};
use loxi_wasm_sdk::{loxi_worker_wrapper, LoxiArtifact};
use serde::{Deserialize, Serialize};
use serde_json;
use wasm_bindgen::prelude::*;

// --- VRP DOMAIN TYPES ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Location {
    pub lat: f64,
    pub lon: f64,
}

impl Location {
    pub fn new(lat: f64, lon: f64) -> Self {
        Self { lat, lon }
    }
    pub fn distance_to(&self, other: &Location) -> f64 {
        ((self.lat - other.lat).powi(2) + (self.lon - other.lon).powi(2)).sqrt()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stop {
    pub id: String,
    pub location: Location,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Vehicle {
    pub start_location: Location,
    pub end_location: Option<Location>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VrpProblem {
    pub stops: Vec<Stop>,
    pub vehicle: Vehicle,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distance_matrix: Option<Vec<Vec<f64>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_matrix: Option<Vec<Vec<u32>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VrpSolution {
    pub route: Vec<String>,
    pub unassigned_jobs: Vec<String>,
    pub cost: f64,
}

// --- ARTIFACT IMPLEMENTATION (SDK Glue) ---

pub struct VrpArtifact;

impl LoxiArtifact for VrpArtifact {
    type Problem = Problem; // Raw Loxi Problem (Agnostic Wrapper)
    type Solution = VrpSolution;

    fn solve(agnostic_problem: &Self::Problem) -> Result<Self::Solution, String> {
        // Unwrap the inner payload which contains the VRP specific data
        let payload_str = agnostic_problem.payload.as_ref().ok_or("Empty payload in problem")?;

        let vrp_problem: VrpProblem = serde_json::from_str(payload_str)
            .map_err(|e| format!("Failed to parse VRP payload: {}", e))?;

        Ok(solve_internal(vrp_problem))
    }

    fn get_cost(solution: &Self::Solution) -> f64 {
        solution.cost
    }
}

// --- WASM ENTRY POINT ---

#[wasm_bindgen]
pub fn solve(agnostic_problem_json: &str) -> String {
    // Delegates to standardized SDK wrapper
    match loxi_worker_wrapper::<VrpArtifact>(agnostic_problem_json) {
        Ok(json) => json,
        Err(e) => format!("{{\"error\": \"{:?}\"}}", e),
    }
}

// --- CORE LOGIC (Nearest Neighbor Heuristic) ---

fn solve_internal(problem: VrpProblem) -> VrpSolution {
    let stops = problem.stops;
    if stops.is_empty() {
        return VrpSolution { route: vec![], unassigned_jobs: vec![], cost: 0.0 };
    }

    let n = stops.len();
    let mut route = Vec::new();
    let mut current_loc = problem.vehicle.start_location.clone();
    let mut current_idx: Option<usize> = None;
    let mut total_cost = 0.0;

    let mut stop_indices: Vec<usize> = (0..n).collect();

    while !stop_indices.is_empty() {
        if route.len() >= 20 {
            break;
        }

        let nearest_res = stop_indices
            .iter()
            .enumerate()
            .map(|(i, &stop_idx)| {
                let d = if let Some(ref matrix) = problem.distance_matrix {
                    match current_idx {
                        Some(prev_idx) => matrix[prev_idx][stop_idx],
                        None => current_loc.distance_to(&stops[stop_idx].location),
                    }
                } else {
                    current_loc.distance_to(&stops[stop_idx].location)
                };
                (i, stop_idx, d)
            })
            .min_by(|(_, _, d1), (_, _, d2)| d1.partial_cmp(d2).unwrap());

        if let Some((iter_idx, stop_idx, d)) = nearest_res {
            stop_indices.remove(iter_idx);
            let stop = &stops[stop_idx];
            current_loc = stop.location.clone();
            current_idx = Some(stop_idx);
            total_cost += d;
            route.push(stop.id.clone());
        } else {
            break;
        }
    }

    let unassigned_jobs: Vec<String> = stop_indices.iter().map(|&i| stops[i].id.clone()).collect();

    if let Some(_prev_idx) = current_idx {
        let end_loc =
            problem.vehicle.end_location.as_ref().unwrap_or(&problem.vehicle.start_location);
        total_cost += current_loc.distance_to(end_loc);
    }

    VrpSolution {
        route,
        unassigned_jobs,
        cost: if problem.distance_matrix.is_some() { total_cost } else { total_cost * 111.0 },
    }
}
