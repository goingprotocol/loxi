use crate::manager::types::{Problem, Stop};
pub use h3o::Resolution;
use h3o::{CellIndex, LatLng};
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};

pub struct Partition {
    pub id: String,
    pub job_ids: Vec<String>,
    pub center_hex: String,
    pub total_load: usize,
    pub total_demand: f64,
}

pub struct Partitioner {
    pub resolution: Resolution,
    pub max_cluster_size: usize,
    pub max_demand: f64,
}

impl Partitioner {
    pub fn new() -> Self {
        Self { resolution: Resolution::Nine, max_cluster_size: 100, max_demand: 10000.0 }
    }

    pub fn with_options(resolution: Resolution, max_cluster_size: usize, max_demand: f64) -> Self {
        Self { resolution, max_cluster_size, max_demand }
    }

    pub fn partition_problem(&self, problem: &Problem) -> (Vec<Partition>, Vec<String>) {
        let mut initial_buckets: HashMap<CellIndex, Vec<Stop>> = HashMap::new();
        let mut unassigned_jobs = Vec::new();

        // 1. Binning
        for stop in &problem.stops {
            if let Ok(cell) = LatLng::new(stop.location.lat, stop.location.lon)
                .map(|ll| ll.to_cell(self.resolution))
            {
                initial_buckets.entry(cell).or_default().push(stop.clone());
            } else {
                unassigned_jobs.push(stop.id.clone());
            }
        }

        // 2. Region Growing
        let (partitions, clustered_unassigned) = self.region_growing(initial_buckets);
        unassigned_jobs.extend(clustered_unassigned);

        (partitions, unassigned_jobs)
    }

    fn region_growing(
        &self,
        mut buckets: HashMap<CellIndex, Vec<Stop>>,
    ) -> (Vec<Partition>, Vec<String>) {
        let mut partitions = Vec::new();
        let mut frontier: BTreeSet<CellIndex> = BTreeSet::new();

        while !buckets.is_empty() {
            let mut keys: Vec<CellIndex> = buckets.keys().cloned().collect();
            keys.sort_unstable();
            let seed_cell =
                frontier.iter().find(|c| buckets.contains_key(c)).cloned().unwrap_or(keys[0]);
            frontier.remove(&seed_cell);

            let mut cluster_stops = Vec::new();
            let mut current_demand = 0.0;
            let mut queue: VecDeque<CellIndex> = VecDeque::new();
            queue.push_back(seed_cell);
            let mut seen_in_this_pass: HashSet<CellIndex> = HashSet::new();
            seen_in_this_pass.insert(seed_cell);

            while let Some(current_cell) = queue.pop_front() {
                let should_remove_bucket = if let Some(cell_stops) = buckets.get_mut(&current_cell)
                {
                    while let Some(stop) = cell_stops.pop() {
                        if cluster_stops.len() < self.max_cluster_size
                            && (current_demand + stop.demand) <= self.max_demand
                        {
                            current_demand += stop.demand;
                            cluster_stops.push(stop);
                        } else {
                            cell_stops.push(stop);
                            break;
                        }
                    }
                    cell_stops.is_empty()
                } else {
                    false
                };

                if should_remove_bucket {
                    buckets.remove(&current_cell);
                }

                if cluster_stops.len() >= self.max_cluster_size {
                    let neighbors = current_cell.grid_disk::<Vec<CellIndex>>(1);
                    for n in neighbors {
                        if buckets.contains_key(&n) && !seen_in_this_pass.contains(&n) {
                            frontier.insert(n);
                        }
                    }
                    break;
                }

                let mut sorted_neighbors = current_cell.grid_disk::<Vec<CellIndex>>(1);
                sorted_neighbors.sort_unstable();
                for n in sorted_neighbors {
                    if buckets.contains_key(&n) && !seen_in_this_pass.contains(&n) {
                        seen_in_this_pass.insert(n);
                        queue.push_back(n);
                    }
                }
            }

            for leftover in queue {
                if buckets.contains_key(&leftover) {
                    frontier.insert(leftover);
                }
            }

            if !cluster_stops.is_empty() {
                partitions.push(Partition {
                    id: seed_cell.to_string(),
                    job_ids: cluster_stops.iter().map(|s| s.id.clone()).collect(),
                    center_hex: seed_cell.to_string(),
                    total_load: cluster_stops.len(),
                    total_demand: current_demand,
                });
            }
        }

        let mut unassigned = Vec::new();
        for stops in buckets.values() {
            for stop in stops {
                unassigned.push(stop.id.clone());
            }
        }

        (partitions, unassigned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manager::types::{Location, TimeWindow};

    fn make_stop(id: &str, lat: f64, lon: f64) -> Stop {
        Stop {
            id: id.to_string(),
            location: Location { lat, lon },
            time_window: TimeWindow { start: 0, end: 100 },
            service_time: 10,
            demand: 1.0,
            priority: 1,
        }
    }

    #[test]
    fn test_partitioning_determinism() {
        let mut stops = Vec::new();
        // Create a dense 5x5 grid
        for i in 0..5 {
            for j in 0..5 {
                stops.push(make_stop(
                    &format!("{},{}", i, j),
                    40.7128 + (i as f64 * 0.001),
                    -74.0060 + (j as f64 * 0.001),
                ));
            }
        }

        let vehicle = crate::manager::types::Vehicle {
            capacity: 100.0,
            start_location: Location { lat: 40.0, lon: -74.0 },
            end_location: None,
            shift_window: TimeWindow { start: 0, end: 1000 },
            speed_mps: 10.0,
        };

        let problem = Problem::new(stops, vehicle);

        let partitioner = Partitioner::with_options(Resolution::Nine, 5, 100.0);

        // Run 1
        let (p1, _) = partitioner.partition_problem(&problem);

        // Run 2
        let (p2, _) = partitioner.partition_problem(&problem);

        assert_eq!(p1.len(), p2.len(), "Partition count mismatch");
        for (part1, part2) in p1.iter().zip(p2.iter()) {
            assert_eq!(part1.job_ids.len(), part2.job_ids.len(), "Cluster size mismatch");
            // Sets might be differently ordered internally if not sorted,
            // but our logic enforces creation order. Let's sort to be sure for checking contents.
            let mut ids1 = part1.job_ids.clone();
            let mut ids2 = part2.job_ids.clone();
            ids1.sort();
            ids2.sort();
            assert_eq!(ids1, ids2, "Cluster content mismatch");
        }
    }

    #[test]
    fn test_partitioning_coverage() {
        let mut stops = Vec::new();
        let total_stops = 50;
        for i in 0..total_stops {
            stops.push(make_stop(&format!("stop_{}", i), 40.0 + (i as f64 * 0.001), -74.0));
        }

        let vehicle = crate::manager::types::Vehicle {
            capacity: 1000.0, // High capacity
            start_location: Location { lat: 40.0, lon: -74.0 },
            end_location: None,
            shift_window: TimeWindow { start: 0, end: 1000 },
            speed_mps: 10.0,
        };

        let problem = Problem::new(stops, vehicle);

        // Max cluster size 10 -> Should usually get 5 partitions, maybe 6 if greedy packing is imperfect
        let partitioner = Partitioner::with_options(Resolution::Nine, 10, 1000.0);
        let (partitions, unassigned) = partitioner.partition_problem(&problem);

        assert!(
            partitions.len() >= 5 && partitions.len() <= 6,
            "Expected 5-6 partitions, got {}",
            partitions.len()
        );

        let mut assigned_stops = HashSet::new();
        // Add assigned
        for p in partitions {
            assert!(p.total_load <= 10);
            for id in p.job_ids {
                assigned_stops.insert(id);
            }
        }

        assert_eq!(
            assigned_stops.len() + unassigned.len(),
            total_stops,
            "Not all stops were accounted for"
        );
    }
}
