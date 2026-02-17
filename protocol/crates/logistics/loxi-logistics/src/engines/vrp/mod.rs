use crate::types::{Problem as LoxiProblem, Solution as LoxiSolution, SolutionMetadata};
use std::io::BufWriter;
use std::sync::Arc;
use vrp_pragmatic::core::solver::Solver as CoreSolver;
use vrp_pragmatic::core::solver::VrpConfigBuilder;
use vrp_pragmatic::format::problem as pragmatic_problem;
use vrp_pragmatic::format::problem::PragmaticProblem;
use vrp_pragmatic::format::solution as pragmatic_solution;
use vrp_pragmatic::format::Location as PragmaticLocation;

use vrp_pragmatic::format::problem::create_approx_matrices;

pub struct VrpSolver;

impl VrpSolver {
    pub fn solve(problem: &LoxiProblem) -> Result<LoxiSolution, String> {
        println!(
            "🔍 [VRP Engine] Solver called for task: {:?}; Stops: {}; Has Matrix? {}",
            problem.id,
            problem.stops.len(),
            problem.distance_matrix.is_some()
        );
        if let Some(first) = problem.stops.first() {
            println!("📍 [VRP Engine] Sample Stop Index: {} -> {:?}", first.id, first.matrix_index);
        }
        let (pragmatic_prob, mut matrices) = Self::to_pragmatic(problem)?;

        if matrices.is_empty() {
            matrices = create_approx_matrices(&pragmatic_prob);
        }

        let core_problem = (pragmatic_prob, matrices)
            .read_pragmatic()
            .map_err(|e| format!("Failed to convert to core problem: {:?}", e))?;

        let core_problem = Arc::new(core_problem);

        let config = VrpConfigBuilder::new(core_problem.clone())
            .prebuild()
            .map_err(|e| format!("Failed to prebuild solver config: {}", e))?
            // .with_max_time(Some(2)) // Try 2s limit
            // .with_max_generations(Some(10)) // Force max 10 generations for speed
            .build()
            .map_err(|e| format!("Failed to build solver config: {}", e))?;

        let solver = CoreSolver::new(core_problem.clone(), config);
        let core_solution = solver.solve().map_err(|e| format!("Solver failed: {}", e))?;

        // Use write_pragmatic to serialize the solution to a buffer, then deserialize it
        let mut buffer = Vec::new();
        {
            let mut writer = BufWriter::new(&mut buffer);
            vrp_pragmatic::format::solution::write_pragmatic(
                &core_problem,
                &core_solution,
                vrp_pragmatic::format::solution::PragmaticOutputType::OnlyPragmatic,
                &mut writer,
            )
            .map_err(|e| format!("Failed to serialize solution: {}", e))?;
        }

        let pragmatic_sol: pragmatic_solution::Solution = serde_json::from_slice(&buffer)
            .map_err(|e| format!("Failed to deserialize pragmatic solution: {}", e))?;

        Self::from_pragmatic(problem, pragmatic_sol)
    }

    fn to_pragmatic(
        problem: &LoxiProblem,
    ) -> Result<(pragmatic_problem::Problem, Vec<pragmatic_problem::Matrix>), String> {
        if problem.distance_matrix.is_none() && problem.time_matrix.is_none() {
            return Err("Business Rule Violation: Matrix is required for VRP solving. Haversine fallback is disabled.".to_string());
        }

        // 🟢 1. Collect all Unique Matrix Indices used in this problem
        let mut used_indices = Vec::new();
        used_indices.push(0); // Start Location is always 0 in our MatrixEngine layout

        for stop in &problem.stops {
            used_indices.push(stop.matrix_index.map(|idx| idx as usize).unwrap_or(0));
        }

        if problem.vehicle.end_location.is_some() {
            let end_idx = if let Some(matrix) = &problem.distance_matrix {
                matrix.len() - 1
            } else {
                1 + problem.stops.len()
            };
            used_indices.push(end_idx);
        }

        used_indices.sort();
        used_indices.dedup();

        // 🟢 2. Create Remapping Profile: Old Index -> New Contiguous Index
        let mut mapping = std::collections::HashMap::new();
        for (new_idx, &old_idx) in used_indices.iter().enumerate() {
            mapping.insert(old_idx, new_idx);
        }

        let jobs = problem
            .stops
            .iter()
            .map(|stop| pragmatic_problem::Job {
                id: stop.id.clone(),
                pickups: None,
                deliveries: Some(vec![pragmatic_problem::JobTask {
                    places: vec![pragmatic_problem::JobPlace {
                        location: PragmaticLocation::Reference {
                            index: *mapping
                                .get(&(stop.matrix_index.map(|idx| idx as usize).unwrap_or(0)))
                                .unwrap_or(&0),
                        },
                        duration: stop.service_time as f64,
                        times: Some(vec![vec![
                            Self::format_time(stop.time_window.start),
                            Self::format_time(stop.time_window.end),
                        ]]),
                        tag: None,
                    }],
                    demand: Some(vec![stop.demand as i32]),
                    order: None,
                }]),
                replacements: None,
                services: None,
                skills: None,
                value: None,
                group: None,
                compatibility: None,
            })
            .collect();

        let vehicle_type = pragmatic_problem::VehicleType {
            type_id: "default_vehicle".to_string(),
            vehicle_ids: (1..=problem.fleet_size).map(|i| format!("v{}", i)).collect(),
            profile: pragmatic_problem::VehicleProfile {
                matrix: "main_matrix".to_string(),
                scale: None,
            },
            costs: pragmatic_problem::VehicleCosts { fixed: Some(10.0), distance: 1.0, time: 0.1 },
            shifts: vec![pragmatic_problem::VehicleShift {
                start: pragmatic_problem::ShiftStart {
                    earliest: Self::format_time(problem.vehicle.shift_window.start),
                    latest: None,
                    location: PragmaticLocation::Reference {
                        index: *mapping.get(&0).unwrap_or(&0),
                    },
                },
                end: problem.vehicle.end_location.as_ref().map(|_loc| {
                    let old_end_idx = if let Some(matrix) = &problem.distance_matrix {
                        matrix.len() - 1
                    } else {
                        1 + problem.stops.len()
                    };
                    let index = *mapping.get(&old_end_idx).unwrap_or(&0);
                    pragmatic_problem::ShiftEnd {
                        earliest: None,
                        latest: Self::format_time(problem.vehicle.shift_window.end),
                        location: PragmaticLocation::Reference { index },
                    }
                }),
                breaks: None,
                reloads: None,
                recharges: None,
            }],
            capacity: vec![problem.vehicle.capacity as i32],
            skills: None,
            limits: None,
        };

        // 🟢 3. Build the Remapped Square Matrices
        let size = used_indices.len();
        let mut dists = Vec::with_capacity(size * size);
        let mut times = Vec::with_capacity(size * size);

        if let (Some(d_mat), Some(t_mat)) = (&problem.distance_matrix, &problem.time_matrix) {
            for &r_old in &used_indices {
                for &c_old in &used_indices {
                    let d = d_mat.get(r_old).and_then(|row| row.get(c_old)).cloned().unwrap_or(0.0);
                    let t = t_mat.get(r_old).and_then(|row| row.get(c_old)).cloned().unwrap_or(0);
                    dists.push(d as i64);
                    times.push(t as i64);
                }
            }
        }

        println!(
            "📊 [VRP Engine] Matrix Remapping: Original Dim={}; New Dim={}; Used Indices: {:?}",
            problem.distance_matrix.as_ref().map_or(0, |m| m.len()),
            size,
            used_indices
        );

        let matrices = vec![pragmatic_problem::Matrix {
            profile: Some("main_matrix".to_string()),
            timestamp: None,
            distances: dists,
            travel_times: times,
            error_codes: None,
        }];

        let prob = pragmatic_problem::Problem {
            plan: pragmatic_problem::Plan { jobs, relations: None, clustering: None },
            fleet: pragmatic_problem::Fleet {
                vehicles: vec![vehicle_type],
                profiles: vec![pragmatic_problem::MatrixProfile {
                    name: "main_matrix".to_string(),
                    speed: Some(problem.vehicle.speed_mps),
                }],
                resources: None,
            },
            objectives: None,
        };

        Ok((prob, matrices))
    }

    fn from_pragmatic(
        _original_problem: &LoxiProblem,
        sol: pragmatic_solution::Solution,
    ) -> Result<LoxiSolution, String> {
        let mut routes = Vec::new();
        let mut all_stops = Vec::new();

        for tour in &sol.tours {
            let mut tour_stops = Vec::new();
            for stop in &tour.stops {
                for activity in stop.activities() {
                    if activity.job_id != "departure" && activity.job_id != "arrival" {
                        tour_stops.push(activity.job_id.clone());
                        all_stops.push(activity.job_id.clone());
                    }
                }
            }
            if !tour_stops.is_empty() {
                routes.push(tour_stops);
            }
        }

        let unassigned_jobs = sol
            .unassigned
            .as_ref()
            .map(|u| u.iter().map(|job| job.job_id.clone()).collect())
            .unwrap_or_default();

        let cost = sol.statistic.cost;
        let metadata = SolutionMetadata::new("vrp-rs-pragmatic", 0);

        let mut loxi_sol = LoxiSolution::new(all_stops, cost, metadata);
        loxi_sol.routes = Some(routes);
        loxi_sol.unassigned_jobs = unassigned_jobs;

        Ok(loxi_sol)
    }

    fn format_time(seconds: u32) -> String {
        let days = seconds / 86400;
        let rem = seconds % 86400;
        let hours = rem / 3600;
        let minutes = (rem % 3600) / 60;
        let secs = rem % 60;

        format!("2026-01-{:02}T{:02}:{:02}:{:02}Z", 1 + days, hours, minutes, secs)
    }
}
