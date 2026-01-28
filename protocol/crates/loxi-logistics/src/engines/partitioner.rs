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

    pub fn partition_problem(&self, problem: &Problem) -> Vec<Partition> {
        let mut initial_buckets: HashMap<CellIndex, Vec<Stop>> = HashMap::new();

        // 1. Binning
        for stop in &problem.stops {
            if let Ok(cell) = LatLng::new(stop.location.lat, stop.location.lon)
                .map(|ll| ll.to_cell(self.resolution))
            {
                initial_buckets.entry(cell).or_default().push(stop.clone());
            }
        }

        // 2. Region Growing
        self.region_growing(initial_buckets)
    }

    fn region_growing(&self, mut buckets: HashMap<CellIndex, Vec<Stop>>) -> Vec<Partition> {
        let mut partitions = Vec::new();
        // Frontier: Cells that are adjacent to previously created partitions but weren't consumed yet.
        // We use a BTreeSet for deterministic ordering (default: lowest cell index first).
        let mut frontier: BTreeSet<CellIndex> = BTreeSet::new();

        while !buckets.is_empty() {
            // 1. Pick a seed
            // Priority:
            // A. Frontier (adjacent to previous) to ensure continuity.
            // B. If frontier empty, pick the "first" available cell deterministically.
            let seed_cell = if let Some(&f_cell) = frontier.iter().find(|c| buckets.contains_key(c))
            {
                f_cell
            } else {
                // Frontier is empty or stale. Pick deterministic start from remaining buckets.
                // Cloning keys to sort is acceptable for moderate N.
                let mut keys: Vec<CellIndex> = buckets.keys().cloned().collect();
                keys.sort_unstable(); // Deterministic
                keys[0] // Safe because while check
            };

            // Remove the used seed from frontier to avoid re-picking immediately (though buckets check handles it)
            frontier.remove(&seed_cell);

            let mut cluster_stops = Vec::new();
            let mut current_demand = 0.0;

            // Local BFS Queue for this partition
            let mut queue: VecDeque<CellIndex> = VecDeque::new();
            queue.push_back(seed_cell);

            let mut seen_in_this_pass: HashSet<CellIndex> = HashSet::new();
            seen_in_this_pass.insert(seed_cell);

            while let Some(current_cell) = queue.pop_front() {
                // Try to consume stops from this cell
                // We peek/modify efficiently
                let should_remove_bucket = if let Some(cell_stops) = buckets.get_mut(&current_cell)
                {
                    while let Some(stop) = cell_stops.pop() {
                        if cluster_stops.len() < self.max_cluster_size
                            && (current_demand + stop.demand) <= self.max_demand
                        {
                            current_demand += stop.demand;
                            cluster_stops.push(stop);
                        } else {
                            // Put back and stop consuming for this partition
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

                // If partition is full, we stop EXPANDING this partition.
                // IMPORTANT: The neighbors we *would* have visited are now candidates for the NEXT partition.
                // But we only add them to frontier if they actually have stops.
                if cluster_stops.len() >= self.max_cluster_size {
                    // Add current_cell's UNVISITED neighbors to global frontier
                    // effectively "pausing" the BFS here to resume later.
                    // Use explicit generic u32 for grid_disk to avoid inference error
                    let neighbors = current_cell.grid_disk::<Vec<CellIndex>>(1);
                    for n in neighbors {
                        // If n has data and wasn't processed in this pass fully...
                        if buckets.contains_key(&n) && !seen_in_this_pass.contains(&n) {
                            frontier.insert(n);
                        }
                    }
                    break;
                }

                // Add neighbors to local queue to keep growing THIS partition
                // Sort neighbors for deterministic BFS traversal order
                let mut sorted_neighbors = current_cell.grid_disk::<Vec<CellIndex>>(1);
                sorted_neighbors.sort_unstable();

                for n in sorted_neighbors {
                    if buckets.contains_key(&n) && !seen_in_this_pass.contains(&n) {
                        seen_in_this_pass.insert(n);
                        queue.push_back(n);
                    }
                }
            }

            // After finishing a partition, any leftover cells in the queue (that we didn't get to because full)
            // should be added to the frontier for the next pass.
            for leftover in queue {
                if buckets.contains_key(&leftover) {
                    frontier.insert(leftover);
                }
            }

            // Create Partition
            if !cluster_stops.is_empty() {
                partitions.push(Partition {
                    id: format!("part_{}", seed_cell),
                    job_ids: cluster_stops.iter().map(|s| s.id.clone()).collect(),
                    center_hex: seed_cell.to_string(),
                    total_load: cluster_stops.len(),
                    total_demand: current_demand,
                });
            }
        }

        partitions
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
        let p1 = partitioner.partition_problem(&problem);

        // Run 2
        let p2 = partitioner.partition_problem(&problem);

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
        let partitions = partitioner.partition_problem(&problem);

        assert!(
            partitions.len() >= 5 && partitions.len() <= 6,
            "Expected 5-6 partitions, got {}",
            partitions.len()
        );

        let mut assigned_stops = HashSet::new();
        for p in partitions {
            assert!(p.total_load <= 10);
            for id in p.job_ids {
                assigned_stops.insert(id);
            }
        }

        assert_eq!(assigned_stops.len(), total_stops, "Not all stops were assigned");
    }
}
