use loxi_core::{Assignment, NodeSpecs, TaskRequirement};
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, VecDeque};

// --- CONFIG: Trusted Partners (Hardcoded for V1) ---
const TRUSTED_PARTNERS: &[&str] = &[];

// --- Worker Node (Heap Item) ---
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct WorkerNode {
    pub id: String,
    pub ram_mb: u64,
    pub thread_count: u32,
    pub is_webgpu_enabled: bool,
    pub affinity_hashes: Vec<String>,
    pub score: u64, // Pre-calculated capacity score
    pub owner_id: Option<String>,
}

// Custom Ordering for Max-Heap (Highest Score First)
impl Ord for WorkerNode {
    fn cmp(&self, other: &Self) -> Ordering {
        self.score.cmp(&other.score)
    }
}

impl PartialOrd for WorkerNode {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

// --- Scheduler ---
pub struct Scheduler {
    // POOL: Available workers (Idle)
    idle_pool: BinaryHeap<WorkerNode>,

    // QUEUE: Pending tasks waiting for workers
    task_queue: VecDeque<(String, TaskRequirement, String)>, // (ID, Req, PostedBy)

    // TRACKING: Who is doing what (Busy Nodes)
    busy_nodes: HashMap<String, Assignment>,
}

impl Scheduler {
    pub fn new() -> Self {
        Self {
            idle_pool: BinaryHeap::new(),
            task_queue: VecDeque::new(),
            busy_nodes: HashMap::new(),
        }
    }

    pub fn add_worker(
        &mut self,
        specs: NodeSpecs,
    ) -> Option<(Assignment, String, String, Vec<String>, Vec<(String, String)>)> {
        // [QUEUE DRAIN] First, check if this new worker can take a pending task immediately
        if let Some(match_result) = self.try_match_pending(&specs) {
            return Some(match_result);
        }

        self.add_worker_to_pool(specs);
        None
    }

    // INTERNAL HELPER: Just push to heap
    fn add_worker_to_pool(&mut self, specs: NodeSpecs) {
        let hardware_score = specs.ram_mb / 1024 + (specs.thread_count as u64 * 10);
        let tier_score = if specs.is_webgpu_enabled && specs.ram_mb >= 16000 {
            3000
        } else if specs.ram_mb >= 8000 {
            2000
        } else {
            1000
        };

        let node = WorkerNode {
            id: specs.id,
            ram_mb: specs.ram_mb,
            thread_count: specs.thread_count,
            is_webgpu_enabled: specs.is_webgpu_enabled,
            affinity_hashes: specs.affinity_hashes,
            score: tier_score + hardware_score,
            owner_id: specs.owner_id,
        };

        println!("📥 Scheduler: Worker {} added to pool. Score: {}", node.id, node.score);
        self.idle_pool.push(node);
    }

    pub fn schedule_task(
        &mut self,
        task_id: String,
        req: TaskRequirement,
        posted_by: String,
    ) -> Option<Assignment> {
        // 1. Try to pop a worker
        if let Some(worker) = self.pop_best_worker(&req) {
            // Match found!
            let assignment =
                Assignment { node_id: worker.id.clone(), task_type: req.task_type.clone() };
            self.busy_nodes.insert(worker.id, assignment.clone());
            Some(assignment)
        } else {
            // No worker available -> Queue it
            println!("zzz Scheduler: No workers available. Queuing task {}", task_id);
            self.task_queue.push_back((task_id, req, posted_by));
            None
        }
    }

    pub fn release_worker(
        &mut self,
        worker_id: &str,
        original_specs: NodeSpecs,
    ) -> Option<(Assignment, String, String, Vec<String>, Vec<(String, String)>)> {
        // 1. Mark as free (remove from busy)
        self.busy_nodes.remove(worker_id);

        // 2. SMART PIPE: Scan queue for FIRST compatible task
        if let Some(match_result) = self.try_match_pending(&original_specs) {
            return Some(match_result);
        } else {
            // 2b. No compatible pending tasks -> Return to Heap
            self.add_worker_to_pool(original_specs);
            return None;
        }
    }

    // INTERNAL HELPER: Distributed Queue Matching
    fn try_match_pending(
        &mut self,
        specs: &NodeSpecs,
    ) -> Option<(Assignment, String, String, Vec<String>, Vec<(String, String)>)> {
        // We cannot just pop_front() because the head of the queue might be a Specialized task
        // while the freed/new worker is General (Generic). Blind popping causes mismatches.
        let match_idx = self.task_queue.iter().position(|(_id, req, _poster)| {
            let ram_ok = specs.ram_mb >= req.min_ram_mb;
            let cpu_ok = specs.thread_count >= req.min_cpu_threads;
            let gpu_ok = !req.use_gpu || specs.is_webgpu_enabled;

            // Strict Affinity: If task needs affinity, worker MUST have it.
            let affinity_ok = if req.affinities.is_empty() {
                true
            } else {
                req.affinities.iter().any(|a| specs.affinity_hashes.contains(a))
            };

            ram_ok && cpu_ok && gpu_ok && affinity_ok
        });

        if let Some(idx) = match_idx {
            // Match found! Extract specifically that task.
            let (task_id, req, posted_by) = self.task_queue.remove(idx).unwrap();

            println!("⚡ Scheduler: Piping pending task {} to worker {}", task_id, specs.id);
            let affinities = req.affinities.clone();
            let metadata = req.metadata.clone();
            let assignment = Assignment { node_id: specs.id.clone(), task_type: req.task_type };
            self.busy_nodes.insert(specs.id.clone(), assignment.clone());
            return Some((assignment, task_id, posted_by, affinities, metadata));
        }

        None
    }

    /// For V1 massive scale, we assume homogeneous or "Smart Popping".
    /// To keep it O(1) effectively, we assume the top nodes meet general reqs or we pop-and-repush if mismatch (careful).
    fn pop_best_worker(&mut self, req: &TaskRequirement) -> Option<WorkerNode> {
        // HYBRID HEURISTIC: "Peek & Match"
        // 1. Pop top K candidates (Highest Score from Heap)
        // 2. Scan Buffer for VIP Match (Tier 1)
        // 3. Scan Buffer for Affinity Match (Tier 2)
        // 4. Scan Buffer for Generic Match (Tier 3 - Strict)
        // 5. Restore unselected to Heap

        const SEARCH_DEPTH: usize = 5;
        let mut buffer = Vec::new();
        let mut selected_node: Option<WorkerNode> = None;

        // --- DEBUG PROBE START ---
        println!(
            "🔎 Scheduler: Scanning pool for Task {} (Affinities: {:?})",
            req.id, req.affinities
        );
        // --- DEBUG PROBE END ---

        // 1. Gather Candidates (Top K)
        while buffer.len() < SEARCH_DEPTH {
            if let Some(node) = self.idle_pool.pop() {
                buffer.push(node);
            } else {
                break;
            }
        }

        let mut inspected_nodes = Vec::new(); // For debug log

        // 2. Scan Buffer for VIP Match
        if let Some(ref target_owner) = req.priority_for_owner {
            if TRUSTED_PARTNERS.contains(&target_owner.as_str()) {
                if let Some(pos) = buffer.iter().position(|n| {
                    let ram_ok = n.ram_mb >= req.min_ram_mb;
                    let cpu_ok = n.thread_count >= req.min_cpu_threads;
                    let gpu_ok = !req.use_gpu || n.is_webgpu_enabled;
                    let is_owned = n.owner_id.as_deref() == Some(target_owner.as_str());
                    ram_ok && cpu_ok && gpu_ok && is_owned
                }) {
                    println!(
                        "💎 Scheduler: VIP MATCH! Assigned to owned worker of {}",
                        target_owner
                    );
                    selected_node = Some(buffer.remove(pos));
                }
            } else {
                println!(
                    "⚠️ Scheduler: Ignored priority request for untrusted owner: {}",
                    target_owner
                );
            }
        }

        // 3. Scan Buffer for Affinity Match (Tier 2)
        if selected_node.is_none() {
            if let Some(pos) = buffer.iter().position(|n| {
                inspected_nodes.push(format!("{{ID: {}, Aff: {:?}}}", n.id, n.affinity_hashes));

                let ram_ok = n.ram_mb >= req.min_ram_mb;
                let cpu_ok = n.thread_count >= req.min_cpu_threads;
                let gpu_ok = !req.use_gpu || n.is_webgpu_enabled;
                // Check if node has any of necessary affinities cached
                let affinity_hit = req.affinities.iter().any(|a| n.affinity_hashes.contains(a));

                if !affinity_hit && !req.affinities.is_empty() {
                    // Debug why it failed
                    println!(
                        "❌ Node {} rejected. Task needs {:?} but Node has {:?}",
                        n.id, req.affinities, n.affinity_hashes
                    );
                }

                ram_ok && cpu_ok && gpu_ok && affinity_hit
            }) {
                selected_node = Some(buffer.remove(pos));
                println!("🎯 Scheduler: Affinity HIT! Assigned to expert worker.");
            }
        }

        // 4. Scan Buffer for Generic Match (Tier 3 - Strict Fallback)
        if selected_node.is_none() {
            // Debug Trigger
            if req.affinities.len() > 0 {
                println!(
                    "⚠️ Scheduler: No Affinity match in buffer. Candidates checked: {:?}",
                    inspected_nodes
                );
            }

            // Find best scoring node that meets specs
            // Conflict = Task has affinities but Node doesn't (otherwise Tier 2 would have caught it).
            // So here we ONLY allow nodes if req.affinities IS EMPTY.

            let mut best_score = 0;
            let mut best_idx = None;

            for (i, n) in buffer.iter().enumerate() {
                let ram_ok = n.ram_mb >= req.min_ram_mb;
                let cpu_ok = n.thread_count >= req.min_cpu_threads;
                let gpu_ok = !req.use_gpu || n.is_webgpu_enabled;

                // DYNAMIC LOADING (Tier 3):
                // If we reach here, no worker had the affinity cached (Tier 2).
                // We pick the best hardware match and assume they will download the artifact.
                // We only strictly fail if hardware requirements are not met.

                if ram_ok && cpu_ok && gpu_ok {
                    if n.score > best_score {
                        best_score = n.score;
                        best_idx = Some(i);
                    }
                }
            }

            if let Some(idx) = best_idx {
                selected_node = Some(buffer.remove(idx));
                println!(
                    "📦 Scheduler: Dynamic Loading Triggered. Assigned to worker for download."
                );
            }
        }

        // 5. Restore ignored nodes
        for node in buffer {
            self.idle_pool.push(node);
        }

        selected_node
    }
}
