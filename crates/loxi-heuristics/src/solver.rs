use crate::construction::NearestNeighborConstructor;
use crate::improvement::{Improve2Opt, ImproveRelocate};
use loxi_cost::{evaluate_solution, CostConfig};
use loxi_types::{Problem, Solution, SolutionMetadata};
use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;

#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant;

#[derive(Debug, Clone)]
struct SolverTimer {
    #[cfg(not(target_arch = "wasm32"))]
    start: Instant,
}

impl SolverTimer {
    fn start() -> Self {
        Self {
            #[cfg(not(target_arch = "wasm32"))]
            start: Instant::now(),
        }
    }

    fn elapsed_ms(&self) -> u64 {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.start.elapsed().as_millis() as u64
        }
        #[cfg(target_arch = "wasm32")]
        {
            0
        }
    }
}

pub const SOLVER_VERSION: &str = "0.1.0";

#[derive(Debug, Clone)]
pub struct SolverConfig {
    pub cost_config: CostConfig,
    pub seed: Option<u64>,
    pub max_iterations: u32,
    pub no_improvement_limit: u32,
}

impl Default for SolverConfig {
    fn default() -> Self {
        Self {
            cost_config: CostConfig::default(),
            seed: None,
            max_iterations: 1000,
            no_improvement_limit: 50,
        }
    }
}

pub struct Solver {
    config: SolverConfig,
    #[allow(dead_code)]
    rng: ChaCha8Rng,
}

impl Solver {
    pub fn new(config: SolverConfig) -> Self {
        let rng = match config.seed {
            Some(seed) => ChaCha8Rng::seed_from_u64(seed),
            None => ChaCha8Rng::from_entropy(),
        };

        Self { config, rng }
    }

    pub fn solve(&mut self, problem: &Problem) -> Result<Solution, String> {
        let timer = SolverTimer::start();

        problem.validate()?;

        let mut route = NearestNeighborConstructor::construct(problem);

        if route.is_empty() {
            return Ok(self.create_empty_solution(&timer));
        }

        let iterations = self.improve_route(problem, &mut route);

        let solution = self.create_solution(problem, route, &timer, iterations);

        Ok(solution)
    }

    pub fn refine_solution(
        &mut self,
        problem: &Problem,
        initial: &Solution,
    ) -> Result<Solution, String> {
        let timer = SolverTimer::start();
        problem.validate()?;

        let stop_map: std::collections::HashMap<_, _> =
            problem.stops.iter().enumerate().map(|(idx, stop)| (&stop.id, idx)).collect();

        let mut route: Vec<usize> = Vec::with_capacity(initial.route.len());
        let mut seen = std::collections::HashSet::new();
        for stop_id in &initial.route {
            if let Some(&idx) = stop_map.get(stop_id) {
                if seen.insert(idx) {
                    route.push(idx);
                }
            }
        }

        if route.is_empty() {
            return Err("Initial solution has no valid stops for this problem".to_string());
        }

        let iterations = self.improve_route(problem, &mut route);
        Ok(self.create_solution(problem, route, &timer, iterations))
    }

    fn improve_route(&mut self, problem: &Problem, route: &mut Vec<usize>) -> u32 {
        let mut iterations = 0;
        let mut no_improvement_count = 0;

        while iterations < self.config.max_iterations
            && no_improvement_count < self.config.no_improvement_limit
        {
            let mut improved = false;

            if Improve2Opt::improve(problem, route, &self.config.cost_config, &mut self.rng) {
                improved = true;
            }

            if ImproveRelocate::improve(problem, route, &self.config.cost_config, &mut self.rng) {
                improved = true;
            }

            iterations += 1;

            if improved {
                no_improvement_count = 0;
            } else {
                no_improvement_count += 1;
            }
        }

        iterations
    }

    fn create_solution(
        &self,
        problem: &Problem,
        route: Vec<usize>,
        timer: &SolverTimer,
        iterations: u32,
    ) -> Solution {
        let stop_ids: Vec<String> =
            route.iter().map(|&idx| problem.stops[idx].id.clone()).collect();

        let mut metadata = SolutionMetadata::new(SOLVER_VERSION, timer.elapsed_ms());
        metadata.seed = self.config.seed;
        metadata.iterations = Some(iterations);

        let temp_solution = Solution::new(stop_ids.clone(), 0.0, metadata.clone());

        let (cost, breakdown, violations) =
            evaluate_solution(problem, &temp_solution, &self.config.cost_config);

        let mut solution = Solution::new(stop_ids, cost, metadata);
        solution.cost_breakdown = breakdown;
        solution.violations = violations;

        solution
    }

    fn create_empty_solution(&self, timer: &SolverTimer) -> Solution {
        let metadata = SolutionMetadata::new(SOLVER_VERSION, timer.elapsed_ms());
        Solution::new(vec![], 0.0, metadata)
    }
}

impl Default for Solver {
    fn default() -> Self {
        Self::new(SolverConfig::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use loxi_types::{Location, Stop, TimeWindow, Vehicle};

    fn create_test_problem(n: usize) -> Problem {
        let stops: Vec<Stop> = (0..n)
            .map(|i| {
                Stop::new(
                    format!("stop{}", i),
                    Location::new(40.0 + i as f64 * 0.01, -74.0),
                    TimeWindow::new(0, 86400),
                    300,
                    5.0,
                    1,
                )
            })
            .collect();

        let vehicle = Vehicle { capacity: (n as f64 * 10.0), ..Vehicle::default() };

        Problem::new(stops, vehicle)
    }

    #[test]
    fn test_solve_empty_problem() {
        let problem = Problem::new(vec![], Vehicle::default());
        let mut solver = Solver::default();

        let result = solver.solve(&problem);
        assert!(result.is_err());
    }

    #[test]
    fn test_solve_small_problem() {
        let problem = create_test_problem(5);
        let mut solver = Solver::default();

        let solution = solver.solve(&problem).unwrap();

        assert_eq!(solution.num_stops(), 5);
        assert!(solution.cost > 0.0);
        assert_eq!(solution.metadata.solver_version, SOLVER_VERSION);
    }

    #[test]
    fn test_deterministic_solve() {
        let problem = create_test_problem(5);

        let config1 = SolverConfig { seed: Some(42), ..Default::default() };
        let config2 = SolverConfig { seed: Some(42), ..Default::default() };

        let mut solver1 = Solver::new(config1);
        let mut solver2 = Solver::new(config2);

        let solution1 = solver1.solve(&problem).unwrap();
        let solution2 = solver2.solve(&problem).unwrap();

        assert_eq!(solution1.route, solution2.route);
        assert_eq!(solution1.cost, solution2.cost);
    }

    #[test]
    fn test_solve_medium_problem() {
        let problem = create_test_problem(25);
        let mut solver = Solver::default();

        let solution = solver.solve(&problem).unwrap();

        assert_eq!(solution.num_stops(), 25);
        assert!(solution.cost > 0.0);
        assert!(solution.metadata.solve_time_ms < 10_000);
    }

    #[test]
    fn test_refine_solution_keeps_stop_set() {
        let problem = create_test_problem(10);

        let mut solver =
            Solver::new(SolverConfig { seed: Some(42), max_iterations: 200, ..Default::default() });
        let initial = solver.solve(&problem).unwrap();

        let mut refiner = Solver::new(SolverConfig {
            seed: Some(1337),
            max_iterations: 200,
            ..Default::default()
        });
        let refined = refiner.refine_solution(&problem, &initial).unwrap();

        assert_eq!(refined.num_stops(), initial.num_stops());

        let mut a = refined.route.clone();
        let mut b = initial.route.clone();
        a.sort();
        b.sort();
        assert_eq!(a, b);
    }
}
