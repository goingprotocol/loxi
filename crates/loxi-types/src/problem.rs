use crate::{Location, Stop, TimeWindow};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Vehicle {
    pub capacity: f64,
    pub start_location: Location,
    pub end_location: Location,
    pub shift_window: TimeWindow,
    pub speed_mps: f64,
}

impl Vehicle {
    pub fn new(
        capacity: f64,
        start_location: Location,
        end_location: Location,
        shift_window: TimeWindow,
        speed_mps: f64,
    ) -> Self {
        Self { capacity, start_location, end_location, shift_window, speed_mps }
    }

    pub fn travel_time(&self, from: &Location, to: &Location) -> u32 {
        let distance = from.distance_to(to);
        (distance / self.speed_mps).round() as u32
    }
}

impl Default for Vehicle {
    fn default() -> Self {
        Self {
            capacity: 100.0,
            start_location: Location::new(0.0, 0.0),
            end_location: Location::new(0.0, 0.0),
            shift_window: TimeWindow::new(0, 86400),
            speed_mps: 10.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Problem {
    pub stops: Vec<Stop>,
    pub vehicle: Vehicle,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distance_matrix: Option<Vec<Vec<f64>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_matrix: Option<Vec<Vec<u32>>>,
}

impl Problem {
    pub fn new(stops: Vec<Stop>, vehicle: Vehicle) -> Self {
        Self { stops, vehicle, distance_matrix: None, time_matrix: None }
    }

    pub fn num_stops(&self) -> usize {
        self.stops.len()
    }

    pub fn distance(&self, from_idx: usize, to_idx: usize) -> f64 {
        if let Some(ref matrix) = self.distance_matrix {
            matrix[from_idx][to_idx]
        } else {
            self.stops[from_idx].location.distance_to(&self.stops[to_idx].location)
        }
    }

    pub fn travel_time(&self, from_idx: usize, to_idx: usize) -> u32 {
        if let Some(ref matrix) = self.time_matrix {
            matrix[from_idx][to_idx]
        } else {
            let distance = self.distance(from_idx, to_idx);
            (distance / self.vehicle.speed_mps).round() as u32
        }
    }

    pub fn precompute_matrices(&mut self) {
        let n = self.stops.len();
        let mut dist_matrix = vec![vec![0.0; n]; n];
        let mut time_matrix = vec![vec![0; n]; n];

        for i in 0..n {
            for j in 0..n {
                if i != j {
                    let dist = self.stops[i].location.distance_to(&self.stops[j].location);
                    let time = (dist / self.vehicle.speed_mps).round() as u32;
                    dist_matrix[i][j] = dist;
                    time_matrix[i][j] = time;
                }
            }
        }

        self.distance_matrix = Some(dist_matrix);
        self.time_matrix = Some(time_matrix);
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.stops.is_empty() {
            return Err("Problem must have at least one stop".to_string());
        }

        if !self.vehicle.capacity.is_finite() || self.vehicle.capacity <= 0.0 {
            return Err("Vehicle capacity must be positive".to_string());
        }

        if !self.vehicle.speed_mps.is_finite() || self.vehicle.speed_mps <= 0.0 {
            return Err("Vehicle speed_mps must be a finite positive number".to_string());
        }

        if self.vehicle.shift_window.start > self.vehicle.shift_window.end {
            return Err("Vehicle shift_window.start must be <= shift_window.end".to_string());
        }

        let mut seen_ids = std::collections::HashSet::with_capacity(self.stops.len());
        for (idx, stop) in self.stops.iter().enumerate() {
            if stop.id.trim().is_empty() {
                return Err(format!("Stop #{} has empty id", idx));
            }
            if !seen_ids.insert(&stop.id) {
                return Err(format!("Duplicate stop id: {}", stop.id));
            }

            if !stop.location.lat.is_finite()
                || !stop.location.lon.is_finite()
                || stop.location.lat < -90.0
                || stop.location.lat > 90.0
                || stop.location.lon < -180.0
                || stop.location.lon > 180.0
            {
                return Err(format!(
                    "Stop \"{}\" has invalid location (lat/lon out of range)",
                    stop.id
                ));
            }

            if stop.time_window.start > stop.time_window.end {
                return Err(format!("Stop \"{}\" has invalid time_window (start > end)", stop.id));
            }

            if !stop.demand.is_finite() || stop.demand < 0.0 {
                return Err(format!(
                    "Stop \"{}\" has invalid demand (must be finite and >= 0)",
                    stop.id
                ));
            }
        }

        let n = self.stops.len();
        if let Some(ref dist) = self.distance_matrix {
            if dist.len() != n || dist.iter().any(|row| row.len() != n) {
                return Err(format!("distance_matrix must be {}x{}", n, n));
            }
            for (i, row) in dist.iter().enumerate() {
                for (j, &v) in row.iter().enumerate() {
                    if !v.is_finite() || v < 0.0 {
                        return Err(format!(
                            "distance_matrix[{}][{}] must be finite and >= 0",
                            i, j
                        ));
                    }
                }
            }
        }

        if let Some(ref time) = self.time_matrix {
            if time.len() != n || time.iter().any(|row| row.len() != n) {
                return Err(format!("time_matrix must be {}x{}", n, n));
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_problem(num_stops: usize) -> Problem {
        let stops: Vec<Stop> = (0..num_stops)
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
    fn test_problem_creation() {
        let problem = create_test_problem(5);
        assert_eq!(problem.num_stops(), 5);
        assert!(problem.validate().is_ok());
    }

    #[test]
    fn test_precompute_matrices() {
        let mut problem = create_test_problem(3);
        problem.precompute_matrices();

        assert!(problem.distance_matrix.is_some());
        assert!(problem.time_matrix.is_some());

        let dist_matrix = problem.distance_matrix.unwrap();
        assert_eq!(dist_matrix.len(), 3);
        assert_eq!(dist_matrix[0].len(), 3);
    }

    #[test]
    fn test_problem_allows_capacity_overflow() {
        let stops = vec![
            Stop::new("stop1", Location::new(40.0, -74.0), TimeWindow::new(0, 86400), 300, 60.0, 1),
            Stop::new("stop2", Location::new(40.1, -74.1), TimeWindow::new(0, 86400), 300, 60.0, 1),
        ];

        let vehicle = Vehicle { capacity: 100.0, ..Vehicle::default() };

        let problem = Problem::new(stops, vehicle);
        assert!(problem.validate().is_ok());
    }
}
