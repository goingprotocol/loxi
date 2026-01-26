use crate::manager::types::Problem;
use h3o::{CellIndex, LatLng, Resolution};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone)]
pub struct Partition {
    pub id: String,
    pub job_ids: Vec<String>,
    pub center_hex: String,
    pub total_load: usize,
}

pub struct Partitioner {
    pub resolution: Resolution,
    pub min_cluster_size: usize,
    pub max_cluster_size: usize,
}

impl Partitioner {
    pub fn new() -> Self {
        Self {
            resolution: Resolution::Nine, // ~170m edge length
            min_cluster_size: 10,
            max_cluster_size: 50,
        }
    }

    /// The Main "Chef" Function: Chops the big routing problem into bite-sized Partitions.
    pub fn partition_problem(&self, problem: &Problem) -> Vec<Partition> {
        let mut initial_buckets: HashMap<CellIndex, Vec<String>> = HashMap::new();

        // 1. Quantize (Binning) - Group stops by their H3 Cell based on actual location
        for (i, stop) in problem.stops.iter().enumerate() {
            let lat = stop.location.lat;
            let lon = stop.location.lon;

            if let Ok(cell) = LatLng::new(lat, lon).map(|ll| ll.to_cell(self.resolution)) {
                initial_buckets.entry(cell).or_default().push(stop.id.clone());
            }
        }

        // --- REAL LOGIC SIMULATION (Assuming Job Input) ---
        // Let's pretend we have a list of jobs with lat/lon.
        // Step 1: Bin pointers to cells.

        // Step 2: Region Growing (The "Blob" Logic)
        let partitions = self.region_growing(initial_buckets);

        partitions
    }

    fn region_growing(&self, buckets: HashMap<CellIndex, Vec<String>>) -> Vec<Partition> {
        let mut partitions = Vec::new();
        let mut visited_cells: HashSet<CellIndex> = HashSet::new();

        // Iterate through populated cells
        for (seed_cell, jobs) in &buckets {
            if visited_cells.contains(seed_cell) {
                continue;
            }

            // Start a new Cluster
            let mut cluster_jobs = jobs.clone();
            visited_cells.insert(*seed_cell);

            // Expand via kRing (Neighbors) until MAX_SIZE is reached
            let k_ring: Vec<(CellIndex, u32)> = seed_cell.grid_disk_distances(1); // 1-ring neighbors

            for (neighbor, _dist) in k_ring {
                if cluster_jobs.len() >= self.max_cluster_size {
                    break;
                }

                if let Some(neighbor_jobs) = buckets.get(&neighbor) {
                    if !visited_cells.contains(&neighbor) {
                        cluster_jobs.extend(neighbor_jobs.clone());
                        visited_cells.insert(neighbor);
                    }
                }
            }

            // Create Partition Object
            if cluster_jobs.len() > self.max_cluster_size {
                partitions.extend(self.handle_dense_cell(*seed_cell, cluster_jobs));
            } else {
                partitions.push(Partition {
                    id: format!("part_{}", seed_cell),
                    job_ids: cluster_jobs,
                    center_hex: seed_cell.to_string(),
                    total_load: 0,
                });
            }
        }

        partitions
    }

    /// The "Mitosis" Strategy for Dense Cells.
    /// If a cell has 1,000 orders, we can't give it to one Scout.
    /// 1. Try to Zoom In (Res 9 -> Res 10) to separate buildings.
    /// 2. If already max zoom (same building), split the list (Round Robin).
    fn handle_dense_cell(&self, cell: CellIndex, jobs: Vec<String>) -> Vec<Partition> {
        // Base Case: Just split the list if we can't zoom further or for simplicity in Phase 1
        // In full L2, we would use cell.children() to create sub-buckets.

        let mut sub_partitions = Vec::new();
        for (i, chunk) in jobs.chunks(self.max_cluster_size).enumerate() {
            sub_partitions.push(Partition {
                id: format!("part_{}_sub_{}", cell, i),
                job_ids: chunk.to_vec(),
                center_hex: cell.to_string(),
                total_load: chunk.len(),
            });
        }
        sub_partitions
    }
}
