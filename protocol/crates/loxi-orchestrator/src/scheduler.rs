use loxi_core::{Assignment, NodeSpecs, TaskRequirement, TaskType};
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, VecDeque};

// --- Worker Node (Heap Item) ---
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct WorkerNode {
    pub id: String,
    pub ram_mb: u64,
    pub thread_count: u32,
    pub is_webgpu_enabled: bool,
    pub affinity_hashes: Vec<String>,
    pub score: u64, // Pre-calculated capacity score
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
    // MAP: For fast lookup/removal if needed (optional optimization, for now Heap is enough if we assume precise state)
    // Actually, to handle "Node Disconnect", we might need a map. But for dispatch, Heap is key.

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

    pub fn add_worker(&mut self, specs: NodeSpecs) {
        // Calculate Score once
        let hardware_score = specs.ram_mb / 1024 + (specs.thread_count as u64 * 10);
        let tier_score = if specs.is_webgpu_enabled && specs.ram_mb >= 16000 {
            3000
        } else if specs.ram_mb >= 8000 {
            2000
        } else {
            1000
        };
        // Note: Affinity is task-dependent, so in a pure Heap we score on RAW POWER.
        // Task-specific affinity would require multiple queues or scanning (which defeats O(1)).
        // For V1 Scalability, "Power" is the primary sorting metric.

        let node = WorkerNode {
            id: specs.id,
            ram_mb: specs.ram_mb,
            thread_count: specs.thread_count,
            is_webgpu_enabled: specs.is_webgpu_enabled,
            affinity_hashes: specs.affinity_hashes,
            score: tier_score + hardware_score,
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

        if let Some((task_id, req, posted_by)) = self.task_queue.pop_front() {
            // 2a. Assign immediately (Short-circuit Heap)
            println!("⚡ Scheduler: Piping pending task {} to freed worker {}", task_id, worker_id);
            let affinities = req.affinities.clone();
            let metadata = req.metadata.clone();
            let assignment =
                Assignment { node_id: worker_id.to_string(), task_type: req.task_type };
            self.busy_nodes.insert(worker_id.to_string(), assignment.clone());
            return Some((assignment, task_id, posted_by, affinities, metadata));
        } else {
            // 2b. No pending tasks -> Return to Heap
            self.add_worker(original_specs);
            return None;
        }
    }

    /// Internal: Pops the best worker that meets requirements.
    /// Since Heap is sorted by score, we pop. If top doesn't match Requirements (e.g. GPU), we might have to buffer.
    /// For V1 massive scale, we assume homogeneous or "Smart Popping".
    /// To keep it O(1) effectively, we assume the top nodes meet general reqs or we pop-and-repush if mismatch (careful).
    fn pop_best_worker(&mut self, req: &TaskRequirement) -> Option<WorkerNode> {
        // HYBRID HEURISTIC: "Peek & Match"
        // 1. Pop top K candidates (Highest Power)
        // 2. Scan for Affinity (Cache Hit)
        // 3. Fallback to Strongest (Cache Miss)
        // 4. Restore others to Heap

        const SEARCH_DEPTH: usize = 5;
        let mut buffer = Vec::new();
        let mut selected_node: Option<WorkerNode> = None;

        // 1. Gather Candidates
        while buffer.len() < SEARCH_DEPTH {
            if let Some(node) = self.idle_pool.pop() {
                buffer.push(node);
            } else {
                break;
            }
        }

        // 2. Select Best from Buffer
        // Priority A: Affinity Match + Hard Constraints
        if let Some(pos) = buffer.iter().position(|n| {
            let ram_ok = n.ram_mb >= req.min_ram_mb;
            let gpu_ok = !req.use_gpu || n.is_webgpu_enabled;
            // Check if node has any of necessary affinities cached
            let affinity_hit = req.affinities.iter().any(|a| n.affinity_hashes.contains(a));
            ram_ok && gpu_ok && affinity_hit
        }) {
            selected_node = Some(buffer.remove(pos));
            println!("🎯 Scheduler: Affinity HIT! Assigned to expert worker.");
        }
        // Priority B: Any valid node (Strongest first, as buffer is sorted)
        else if let Some(pos) = buffer.iter().position(|n| {
            let ram_ok = n.ram_mb >= req.min_ram_mb;
            let gpu_ok = !req.use_gpu || n.is_webgpu_enabled;
            ram_ok && gpu_ok
        }) {
            selected_node = Some(buffer.remove(pos));
            // println!("⚡ Scheduler: Standard dispatch (Power-based).");
        }

        // 3. Restore ignored nodes
        for node in buffer {
            self.idle_pool.push(node);
        }

        selected_node
    }
}
