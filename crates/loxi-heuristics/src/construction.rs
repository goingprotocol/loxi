use loxi_types::Problem;

pub struct NearestNeighborConstructor;

impl NearestNeighborConstructor {
    pub fn construct(problem: &Problem) -> Vec<usize> {
        if problem.stops.is_empty() {
            return vec![];
        }

        let n = problem.num_stops();
        let mut route = Vec::with_capacity(n);
        let mut unvisited: Vec<bool> = vec![true; n];

        let mut current_idx = Self::find_nearest_to_depot(problem, &unvisited);
        route.push(current_idx);
        unvisited[current_idx] = false;

        while route.len() < n {
            let nearest = Self::find_nearest(problem, current_idx, &unvisited);
            if let Some(next_idx) = nearest {
                route.push(next_idx);
                unvisited[next_idx] = false;
                current_idx = next_idx;
            } else {
                break;
            }
        }

        route
    }

    fn find_nearest_to_depot(problem: &Problem, unvisited: &[bool]) -> usize {
        let mut best_idx = 0;
        let mut best_dist = f64::MAX;

        for (idx, stop) in problem.stops.iter().enumerate() {
            if unvisited[idx] {
                let dist = problem.vehicle.start_location.distance_to(&stop.location);
                if dist < best_dist {
                    best_dist = dist;
                    best_idx = idx;
                }
            }
        }

        best_idx
    }

    fn find_nearest(problem: &Problem, current: usize, unvisited: &[bool]) -> Option<usize> {
        let mut best_idx = None;
        let mut best_dist = f64::MAX;

        for (idx, &is_unvisited) in unvisited.iter().enumerate() {
            if is_unvisited {
                let dist = problem.distance(current, idx);
                if dist < best_dist {
                    best_dist = dist;
                    best_idx = Some(idx);
                }
            }
        }

        best_idx
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
                    Location::new(40.0 + i as f64 * 0.01, -74.0 + i as f64 * 0.01),
                    TimeWindow::new(0, 86400),
                    300,
                    5.0,
                    1,
                )
            })
            .collect();

        Problem::new(stops, Vehicle::default())
    }

    #[test]
    fn test_nearest_neighbor_empty() {
        let problem = Problem::new(vec![], Vehicle::default());
        let route = NearestNeighborConstructor::construct(&problem);
        assert!(route.is_empty());
    }

    #[test]
    fn test_nearest_neighbor_single_stop() {
        let problem = create_test_problem(1);
        let route = NearestNeighborConstructor::construct(&problem);
        assert_eq!(route.len(), 1);
        assert_eq!(route[0], 0);
    }

    #[test]
    fn test_nearest_neighbor_multiple_stops() {
        let problem = create_test_problem(5);
        let route = NearestNeighborConstructor::construct(&problem);
        assert_eq!(route.len(), 5);

        let mut sorted = route.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, vec![0, 1, 2, 3, 4]);
    }
}
