use crate::manager::types::{Problem, Stop};
pub use h3o::Resolution;
use h3o::{CellIndex, LatLng};
use std::collections::{HashMap, HashSet};

// Use hashbrown for no_std compatibility if needed, or std::collections if target_os allow.
// Since loxi-logistics is the Manager (std allowed), we can use std.
// But if we want to share with WASM (no_std often used via alloc), hashbrown is safer?
// Wait, loxi-partition-artifact used std::collections. So std is fine.
// But `core.rs` uses `extern crate alloc`.
// I will start with `std` since `loxi-logistics` seems to be `bin/lib` with std.

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
        Self { resolution: Resolution::Nine, max_cluster_size: 25, max_demand: 1000.0 }
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

    fn region_growing(&self, buckets: HashMap<CellIndex, Vec<Stop>>) -> Vec<Partition> {
        let mut partitions = Vec::new();
        let mut visited_cells: HashSet<CellIndex> = HashSet::new();

        for (seed_cell, _stops) in &buckets {
            if visited_cells.contains(seed_cell) {
                continue;
            }

            let mut cluster_stops = Vec::new();
            let mut current_demand = 0.0;
            visited_cells.insert(*seed_cell);

            // Expand via kRing
            let mut cells_to_check = vec![*seed_cell];
            let mut ring = 1;

            while !cells_to_check.is_empty()
                && cluster_stops.len() < self.max_cluster_size
                && current_demand < self.max_demand
            {
                let current_cell = cells_to_check.pop().unwrap();
                if let Some(cell_stops) = buckets.get(&current_cell) {
                    for stop in cell_stops {
                        if cluster_stops.len() < self.max_cluster_size
                            && (current_demand + stop.demand) <= self.max_demand
                        {
                            cluster_stops.push(stop.clone());
                            current_demand += stop.demand;
                        } else {
                            break;
                        }
                    }
                }

                if cluster_stops.len() < self.max_cluster_size && current_demand < self.max_demand {
                    let neighbors: Vec<(CellIndex, u32)> = current_cell.grid_disk_distances(ring);
                    for (n, _) in neighbors {
                        if !visited_cells.contains(&n) {
                            visited_cells.insert(n);
                            cells_to_check.push(n);
                        }
                    }
                    ring += 1;
                    if ring > 3 {
                        break;
                    } // Safety limit
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
