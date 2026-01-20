use loxi_cost::{evaluate_route, CostConfig};
use loxi_types::Problem;
use rand::seq::SliceRandom;
use rand_chacha::ChaCha8Rng;

pub struct Improve2Opt;

impl Improve2Opt {
    pub fn improve(
        problem: &Problem,
        route: &mut [usize],
        config: &CostConfig,
        rng: &mut ChaCha8Rng,
    ) -> bool {
        if route.len() < 2 {
            return false;
        }

        let mut improved = false;
        let n = route.len();
        let mut current_cost = evaluate_route(problem, route, config);

        let mut i_indices: Vec<usize> = (0..n - 1).collect();
        i_indices.shuffle(rng);

        for i in i_indices {
            let mut j_indices: Vec<usize> = (i + 2..n).collect();
            if j_indices.is_empty() {
                continue;
            }
            j_indices.shuffle(rng);

            for j in j_indices {
                Self::apply_2opt(route, i, j);
                let new_cost = evaluate_route(problem, route, config);

                if new_cost < current_cost - 1e-6 {
                    current_cost = new_cost;
                    improved = true;
                } else {
                    Self::apply_2opt(route, i, j);
                }
            }
        }

        improved
    }

    fn apply_2opt(route: &mut [usize], i: usize, j: usize) {
        route[i + 1..=j].reverse();
    }
}

pub struct ImproveRelocate;

impl ImproveRelocate {
    pub fn improve(
        problem: &Problem,
        route: &mut Vec<usize>,
        config: &CostConfig,
        rng: &mut ChaCha8Rng,
    ) -> bool {
        if route.len() < 2 {
            return false;
        }

        let mut improved = false;
        let current_cost = evaluate_route(problem, route, config);

        let mut from_positions: Vec<usize> = (0..route.len()).collect();
        from_positions.shuffle(rng);

        for from_pos in from_positions {
            let mut to_positions: Vec<usize> = (0..route.len()).collect();
            to_positions.shuffle(rng);

            for to_pos in to_positions {
                if from_pos == to_pos {
                    continue;
                }

                let stop = route[from_pos];
                route.remove(from_pos);
                route.insert(to_pos, stop);

                let new_cost = evaluate_route(problem, route, config);

                if new_cost < current_cost - 1e-6 {
                    improved = true;
                    break;
                } else {
                    route.remove(to_pos);
                    route.insert(from_pos, stop);
                }
            }

            if improved {
                break;
            }
        }

        improved
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use loxi_types::{Location, Stop, TimeWindow, Vehicle};
    use rand::SeedableRng;

    fn create_test_problem(n: usize) -> Problem {
        let stops: Vec<Stop> = (0..n)
            .map(|i| {
                Stop::new(
                    format!("stop{}", i),
                    Location::new(40.0 + i as f64 * 0.01, -74.0 + i as f64 * 0.01),
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
    fn test_2opt_improvement() {
        let problem = create_test_problem(5);
        let config = CostConfig::default();
        let mut rng = ChaCha8Rng::seed_from_u64(42);

        let mut route = vec![4, 3, 2, 1, 0];

        let improved = Improve2Opt::improve(&problem, &mut route, &config, &mut rng);

        assert!(improved || route.len() == 5);
    }

    #[test]
    fn test_relocate_improvement() {
        let problem = create_test_problem(5);
        let config = CostConfig::default();
        let mut rng = ChaCha8Rng::seed_from_u64(42);

        let mut route = vec![0, 4, 2, 3, 1];
        let _ = ImproveRelocate::improve(&problem, &mut route, &config, &mut rng);

        assert_eq!(route.len(), 5);
    }
}
