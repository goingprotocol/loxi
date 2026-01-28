use crate::manager::types::{Problem as LoxiProblem, Solution as LoxiSolution, SolutionMetadata};
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
        let jobs = problem
            .stops
            .iter()
            .map(|stop| pragmatic_problem::Job {
                id: stop.id.clone(),
                pickups: None,
                deliveries: Some(vec![pragmatic_problem::JobTask {
                    places: vec![pragmatic_problem::JobPlace {
                        location: PragmaticLocation::Coordinate {
                            lat: stop.location.lat,
                            lng: stop.location.lon,
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
                    location: PragmaticLocation::Coordinate {
                        lat: problem.vehicle.start_location.lat,
                        lng: problem.vehicle.start_location.lon,
                    },
                },
                end: problem.vehicle.end_location.as_ref().map(|loc| pragmatic_problem::ShiftEnd {
                    earliest: None,
                    latest: Self::format_time(problem.vehicle.shift_window.end),
                    location: PragmaticLocation::Coordinate { lat: loc.lat, lng: loc.lon },
                }),
                breaks: None,
                reloads: None,
                recharges: None,
            }],
            capacity: vec![problem.vehicle.capacity as i32],
            skills: None,
            limits: None,
        };

        let matrices = if problem.distance_matrix.is_some() || problem.time_matrix.is_some() {
            let dists = problem
                .distance_matrix
                .as_ref()
                .map_or_else(Vec::new, |d| d.iter().flatten().map(|&v| v as i64).collect());
            let times = problem
                .time_matrix
                .as_ref()
                .map_or_else(Vec::new, |t| t.iter().flatten().map(|&val| val as i64).collect());

            vec![pragmatic_problem::Matrix {
                profile: Some("main_matrix".to_string()),
                timestamp: None,
                distances: dists,
                travel_times: times,
                error_codes: None,
            }]
        } else {
            vec![]
        };

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
        let mut route = Vec::new();
        for tour in &sol.tours {
            for stop in &tour.stops {
                for activity in stop.activities() {
                    if activity.job_id != "departure" && activity.job_id != "arrival" {
                        route.push(activity.job_id.clone());
                    }
                }
            }
        }

        let mut unassigned_jobs = Vec::new();
        if let Some(unassigned) = &sol.unassigned {
            for job in unassigned {
                let reason = job
                    .reasons
                    .first()
                    .map(|r| r.code.clone())
                    .unwrap_or_else(|| "unknown".to_string());
                // Format: "job_id (THREAD: reason)" to be visible in simple string lists
                unassigned_jobs.push(format!("{} ({})", job.job_id, reason));
            }
        }

        let cost = sol.statistic.cost;
        let metadata = SolutionMetadata::new("vrp-rs-pragmatic", 0);

        let mut loxi_sol = LoxiSolution::new(route, cost, metadata);
        loxi_sol.unassigned_jobs = unassigned_jobs;

        Ok(loxi_sol)
    }

    fn format_time(seconds: u32) -> String {
        format!(
            "2026-01-01T{:02}:{:02}:{:02}Z",
            seconds / 3600,
            (seconds % 3600) / 60,
            seconds % 60
        )
    }
}
