use loxi_types::{CostBreakdown, Problem, Solution, Violation};

#[derive(Debug, Clone)]
pub struct CostConfig {
    pub distance_weight: f64,
    pub time_weight: f64,
    pub time_window_penalty: f64,
    pub capacity_penalty: f64,
    pub priority_weight: f64,
}

impl Default for CostConfig {
    fn default() -> Self {
        Self {
            distance_weight: 1.0,
            time_weight: 0.1,
            time_window_penalty: 10.0,
            capacity_penalty: 100.0,
            priority_weight: 1.0,
        }
    }
}

pub fn evaluate_solution(
    problem: &Problem,
    solution: &Solution,
    config: &CostConfig,
) -> (f64, CostBreakdown, Vec<Violation>) {
    let mut breakdown = CostBreakdown::default();
    let mut violations = Vec::new();

    if solution.route.is_empty() {
        return (0.0, breakdown, violations);
    }

    let stop_map: std::collections::HashMap<_, _> =
        problem.stops.iter().enumerate().map(|(idx, stop)| (&stop.id, idx)).collect();

    let mut current_time = 0u32;
    let mut current_load = 0.0;
    let mut prev_idx: Option<usize> = None;

    for stop_id in &solution.route {
        let stop_idx = match stop_map.get(stop_id) {
            Some(&idx) => idx,
            None => continue,
        };

        let stop = &problem.stops[stop_idx];

        if let Some(prev) = prev_idx {
            let travel_time = problem.travel_time(prev, stop_idx);
            let distance = problem.distance(prev, stop_idx);

            breakdown.total_time += travel_time;
            breakdown.total_distance += distance;
            current_time += travel_time;
        } else {
            let depot_to_stop_time =
                problem.vehicle.travel_time(&problem.vehicle.start_location, &stop.location);
            let depot_to_stop_dist = problem.vehicle.start_location.distance_to(&stop.location);

            breakdown.total_time += depot_to_stop_time;
            breakdown.total_distance += depot_to_stop_dist;
            current_time += depot_to_stop_time;
        }

        let wait = stop.time_window.wait_time(current_time);
        current_time += wait;

        let late = stop.time_window.late_by(current_time);
        if late > 0 {
            breakdown.time_window_penalty += late as f64 * config.time_window_penalty;
            violations.push(Violation::new("time_window", stop_id.clone(), late as f64));
        }

        current_load += stop.demand;
        if current_load > problem.vehicle.capacity {
            let excess = current_load - problem.vehicle.capacity;
            breakdown.capacity_penalty += excess * config.capacity_penalty;
            violations.push(Violation::new("capacity", stop_id.clone(), excess));
        }

        breakdown.priority_cost += config.priority_weight / (stop.priority as f64 + 1.0);

        current_time += stop.service_time;
        prev_idx = Some(stop_idx);
    }

    if let Some(last_idx) = prev_idx {
        let last_stop = &problem.stops[last_idx];
        let return_time =
            problem.vehicle.travel_time(&last_stop.location, &problem.vehicle.end_location);
        let return_dist = last_stop.location.distance_to(&problem.vehicle.end_location);

        breakdown.total_time += return_time;
        breakdown.total_distance += return_dist;
    }

    let total_cost = breakdown.total_distance * config.distance_weight
        + breakdown.total_time as f64 * config.time_weight
        + breakdown.time_window_penalty
        + breakdown.capacity_penalty
        + breakdown.priority_cost;

    (total_cost, breakdown, violations)
}

pub fn evaluate_route(problem: &Problem, route: &[usize], config: &CostConfig) -> f64 {
    let mut cost = 0.0;
    let mut current_time = 0u32;
    let mut current_load = 0.0;

    if route.is_empty() {
        return cost;
    }

    let first_stop = &problem.stops[route[0]];
    let depot_dist = problem.vehicle.start_location.distance_to(&first_stop.location);
    let depot_time =
        problem.vehicle.travel_time(&problem.vehicle.start_location, &first_stop.location);

    cost += depot_dist * config.distance_weight;
    cost += depot_time as f64 * config.time_weight;
    current_time += depot_time;

    for i in 0..route.len() {
        let stop_idx = route[i];
        let stop = &problem.stops[stop_idx];

        if i > 0 {
            let prev_idx = route[i - 1];
            let travel_time = problem.travel_time(prev_idx, stop_idx);
            let distance = problem.distance(prev_idx, stop_idx);

            cost += distance * config.distance_weight;
            cost += travel_time as f64 * config.time_weight;
            current_time += travel_time;
        }

        current_time += stop.time_window.wait_time(current_time);
        let late = stop.time_window.late_by(current_time);
        cost += late as f64 * config.time_window_penalty;

        current_load += stop.demand;
        if current_load > problem.vehicle.capacity {
            let excess = current_load - problem.vehicle.capacity;
            cost += excess * config.capacity_penalty;
        }

        cost += config.priority_weight / (stop.priority as f64 + 1.0);

        current_time += stop.service_time;
    }

    let last_stop = &problem.stops[route[route.len() - 1]];
    let return_dist = last_stop.location.distance_to(&problem.vehicle.end_location);
    let return_time =
        problem.vehicle.travel_time(&last_stop.location, &problem.vehicle.end_location);

    cost += return_dist * config.distance_weight;
    cost += return_time as f64 * config.time_weight;

    cost
}

#[cfg(test)]
mod tests {
    use super::*;
    use loxi_types::{Location, SolutionMetadata, Stop, TimeWindow, Vehicle};

    fn create_simple_problem() -> Problem {
        let stops = vec![
            Stop::new("A", Location::new(40.0, -74.0), TimeWindow::new(0, 86400), 300, 10.0, 1),
            Stop::new("B", Location::new(40.01, -74.01), TimeWindow::new(0, 86400), 300, 10.0, 1),
            Stop::new("C", Location::new(40.02, -74.02), TimeWindow::new(0, 86400), 300, 10.0, 1),
        ];

        Problem::new(stops, Vehicle::default())
    }

    #[test]
    fn test_evaluate_empty_solution() {
        let problem = create_simple_problem();
        let solution = Solution::new(vec![], 0.0, SolutionMetadata::new("test", 0));
        let config = CostConfig::default();

        let (cost, breakdown, violations) = evaluate_solution(&problem, &solution, &config);
        assert_eq!(cost, 0.0);
        assert_eq!(breakdown.total_distance, 0.0);
        assert!(violations.is_empty());
    }

    #[test]
    fn test_evaluate_simple_route() {
        let problem = create_simple_problem();
        let route = vec!["A".to_string(), "B".to_string(), "C".to_string()];
        let solution = Solution::new(route, 0.0, SolutionMetadata::new("test", 0));
        let config = CostConfig::default();

        let (cost, breakdown, _violations) = evaluate_solution(&problem, &solution, &config);
        assert!(cost > 0.0);
        assert!(breakdown.total_distance > 0.0);
    }

    #[test]
    fn test_evaluate_route_by_indices() {
        let problem = create_simple_problem();
        let route = vec![0, 1, 2];
        let config = CostConfig::default();

        let cost = evaluate_route(&problem, &route, &config);
        assert!(cost > 0.0);
    }

    #[test]
    fn test_capacity_violation() {
        let stops = vec![
            Stop::new("A", Location::new(40.0, -74.0), TimeWindow::new(0, 86400), 300, 60.0, 1),
            Stop::new("B", Location::new(40.01, -74.01), TimeWindow::new(0, 86400), 300, 60.0, 1),
        ];

        let vehicle = Vehicle { capacity: 100.0, ..Vehicle::default() };

        let problem = Problem::new(stops, vehicle);
        let route = vec!["A".to_string(), "B".to_string()];
        let solution = Solution::new(route, 0.0, SolutionMetadata::new("test", 0));
        let config = CostConfig::default();

        let (_cost, breakdown, violations) = evaluate_solution(&problem, &solution, &config);
        assert!(breakdown.capacity_penalty > 0.0);
        assert!(!violations.is_empty());

        assert!(violations.iter().any(|v| v.violation_type == "capacity"));
    }
}
