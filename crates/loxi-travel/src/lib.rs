use loxi_types::Problem;

#[derive(Debug, Clone)]
pub struct TravelTimeMatrix {
    pub time_matrix: Vec<Vec<u32>>,
    pub distance_matrix: Option<Vec<Vec<f64>>>,
}

impl TravelTimeMatrix {
    pub fn validate(&self, n: usize) -> Result<(), String> {
        if self.time_matrix.len() != n {
            return Err(format!(
                "time_matrix has {} rows but problem has {} stops",
                self.time_matrix.len(),
                n
            ));
        }
        for (i, row) in self.time_matrix.iter().enumerate() {
            if row.len() != n {
                return Err(format!(
                    "time_matrix row {} has {} cols but problem has {} stops",
                    i,
                    row.len(),
                    n
                ));
            }
        }

        if let Some(ref dist) = self.distance_matrix {
            if dist.len() != n {
                return Err(format!(
                    "distance_matrix has {} rows but problem has {} stops",
                    dist.len(),
                    n
                ));
            }
            for (i, row) in dist.iter().enumerate() {
                if row.len() != n {
                    return Err(format!(
                        "distance_matrix row {} has {} cols but problem has {} stops",
                        i,
                        row.len(),
                        n
                    ));
                }
            }
        }

        Ok(())
    }

    pub fn apply_to_problem(&self, problem: &Problem) -> Result<Problem, String> {
        let n = problem.num_stops();
        self.validate(n)?;

        let mut cloned = problem.clone();
        cloned.time_matrix = Some(self.time_matrix.clone());
        if let Some(ref dist) = self.distance_matrix {
            cloned.distance_matrix = Some(dist.clone());
        }
        Ok(cloned)
    }
}

pub trait TravelTimeProvider {
    fn build_matrix(&self, problem: &Problem) -> Result<TravelTimeMatrix, String>;
}

#[derive(Debug, Clone, Default)]
pub struct EuclideanTravelTimeProvider;

impl TravelTimeProvider for EuclideanTravelTimeProvider {
    fn build_matrix(&self, problem: &Problem) -> Result<TravelTimeMatrix, String> {
        problem.validate()?;
        let n = problem.num_stops();

        let mut dist_matrix = vec![vec![0.0; n]; n];
        let mut time_matrix = vec![vec![0u32; n]; n];

        for i in 0..n {
            for j in 0..n {
                if i == j {
                    continue;
                }
                let dist = problem.stops[i].location.distance_to(&problem.stops[j].location);
                let time = (dist / problem.vehicle.speed_mps).round() as u32;
                dist_matrix[i][j] = dist;
                time_matrix[i][j] = time;
            }
        }

        Ok(TravelTimeMatrix { time_matrix, distance_matrix: Some(dist_matrix) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use loxi_types::{Location, Stop, TimeWindow, Vehicle};

    #[test]
    fn euclidean_provider_builds_square_matrices() {
        let stops = vec![
            Stop::new("A", Location::new(40.0, -74.0), TimeWindow::new(0, 86400), 60, 1.0, 1),
            Stop::new("B", Location::new(40.01, -74.01), TimeWindow::new(0, 86400), 60, 1.0, 1),
            Stop::new("C", Location::new(40.02, -74.02), TimeWindow::new(0, 86400), 60, 1.0, 1),
        ];
        let problem = Problem::new(stops, Vehicle::default());

        let provider = EuclideanTravelTimeProvider;
        let matrix = provider.build_matrix(&problem).unwrap();
        matrix.validate(problem.num_stops()).unwrap();

        assert_eq!(matrix.time_matrix.len(), 3);
        assert_eq!(matrix.time_matrix[0].len(), 3);
        assert!(matrix.distance_matrix.is_some());
    }

    #[test]
    fn apply_to_problem_sets_problem_matrices() {
        let stops = vec![
            Stop::new("A", Location::new(40.0, -74.0), TimeWindow::new(0, 86400), 60, 1.0, 1),
            Stop::new("B", Location::new(40.01, -74.01), TimeWindow::new(0, 86400), 60, 1.0, 1),
        ];
        let problem = Problem::new(stops, Vehicle::default());

        let provider = EuclideanTravelTimeProvider;
        let matrix = provider.build_matrix(&problem).unwrap();
        let updated = matrix.apply_to_problem(&problem).unwrap();

        assert!(updated.time_matrix.is_some());
        assert!(updated.distance_matrix.is_some());
        assert_eq!(updated.num_stops(), 2);
    }
}
