use loxi_types::{Location, Problem, Stop, TimeWindow, Vehicle};
use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

pub fn generate_problem(num_stops: usize, seed: u64) -> Problem {
    let mut rng = ChaCha8Rng::seed_from_u64(seed);

    let center_lat = 40.7128;
    let center_lon = -74.0060;
    let radius = 0.1;

    let capacity = num_stops as f64 * 10.0;

    let stops: Vec<Stop> = (0..num_stops)
        .map(|i| {
            let angle = rng.gen::<f64>() * 2.0 * std::f64::consts::PI;
            let r = rng.gen::<f64>().sqrt() * radius;

            let lat = center_lat + r * angle.cos();
            let lon = center_lon + r * angle.sin();

            let time_start = rng.gen_range(0..43200);
            let time_end = time_start + rng.gen_range(3600..14400);

            Stop::new(
                format!("stop{}", i),
                Location::new(lat, lon),
                TimeWindow::new(time_start, time_end.min(86400)),
                rng.gen_range(180..600),
                rng.gen_range(1.0..10.0),
                rng.gen_range(1..=3),
            )
        })
        .collect();

    let vehicle = Vehicle::new(
        capacity,
        Location::new(center_lat, center_lon),
        Location::new(center_lat, center_lon),
        TimeWindow::new(0, 86400),
        10.0,
    );

    let mut problem = Problem::new(stops, vehicle);
    problem.precompute_matrices();
    problem
}

pub fn benchmark_sizes() -> Vec<usize> {
    vec![5, 10, 15, 20, 25]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_problem() {
        let problem = generate_problem(10, 42);
        assert_eq!(problem.num_stops(), 10);
        assert!(problem.validate().is_ok());
    }

    #[test]
    fn test_deterministic_generation() {
        let p1 = generate_problem(5, 42);
        let p2 = generate_problem(5, 42);

        assert_eq!(p1.num_stops(), p2.num_stops());
        assert_eq!(p1.stops[0].id, p2.stops[0].id);
        assert_eq!(p1.stops[0].location.lat, p2.stops[0].location.lat);
    }
}
