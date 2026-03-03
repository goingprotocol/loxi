use loxi_core::{Assignment, NodeSpecs, TaskRequirement};
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, VecDeque};
use std::time::{Duration, Instant};

type ScheduleResult = Option<(Assignment, String, String, Vec<String>, Vec<(String, String)>)>;

// --- CONFIG: Trusted Partners ---
// Loaded once at startup from LOXI_TRUSTED_PARTNERS env var (comma-separated node IDs).
// Example: LOXI_TRUSTED_PARTNERS=node-abc,node-xyz
static TRUSTED_PARTNERS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();

fn trusted_partners() -> &'static [String] {
    TRUSTED_PARTNERS.get_or_init(|| {
        std::env::var("LOXI_TRUSTED_PARTNERS")
            .unwrap_or_default()
            .split(',')
            .filter(|s| !s.is_empty())
            .map(|s| s.trim().to_string())
            .collect()
    })
}

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
    // WATCHDOG: When each worker was assigned (for timeout enforcement)
    busy_timestamps: HashMap<String, Instant>,
    // REVERSE INDEX: O(1) lookup of which auction a worker is handling
    pub worker_to_auction: HashMap<String, String>,
}

impl Default for Scheduler {
    fn default() -> Self {
        Self::new()
    }
}

impl Scheduler {
    pub fn new() -> Self {
        Self {
            idle_pool: BinaryHeap::new(),
            task_queue: VecDeque::new(),
            busy_nodes: HashMap::new(),
            busy_timestamps: HashMap::new(),
            worker_to_auction: HashMap::new(),
        }
    }

    pub fn add_worker(&mut self, specs: NodeSpecs) -> ScheduleResult {
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
            self.busy_timestamps.insert(assignment.node_id.clone(), Instant::now());
            self.worker_to_auction.insert(worker.id.clone(), task_id.clone());
            self.busy_nodes.insert(worker.id, assignment.clone());
            Some(assignment)
        } else {
            // No worker available -> Queue it
            println!("zzz Scheduler: No workers available. Queuing task {}", task_id);
            self.task_queue.push_back((task_id, req, posted_by));
            None
        }
    }

    pub fn release_worker(&mut self, worker_id: &str, original_specs: NodeSpecs) -> ScheduleResult {
        // 1. Mark as free (remove from busy)
        self.busy_nodes.remove(worker_id);
        self.busy_timestamps.remove(worker_id);
        self.worker_to_auction.remove(worker_id);

        // 2. SMART PIPE: Scan queue for FIRST compatible task
        if let Some(match_result) = self.try_match_pending(&original_specs) {
            return Some(match_result);
        }
        // 2b. No compatible pending tasks -> Return to Heap
        self.add_worker_to_pool(original_specs);
        None
    }

    // INTERNAL HELPER: Distributed Queue Matching
    fn try_match_pending(&mut self, specs: &NodeSpecs) -> ScheduleResult {
        // We cannot just pop_front() because the head of the queue might be a Specialized task
        // while the freed/new worker is General (Generic). Blind popping causes mismatches.

        // PASS 1: Prefer Affinity Match (Optimization)
        let affinity_match_idx = self.task_queue.iter().position(|(_id, req, _poster)| {
            let ram_ok = specs.ram_mb >= req.min_ram_mb;
            let cpu_ok = specs.thread_count >= req.min_cpu_threads;
            let gpu_ok = !req.use_gpu || specs.is_webgpu_enabled;

            let has_affinity = !req.affinities.is_empty()
                && req.affinities.iter().any(|a| specs.affinity_hashes.contains(a));

            ram_ok && cpu_ok && gpu_ok && has_affinity
        });

        if let Some(idx) = affinity_match_idx {
            return self.extract_task(idx, specs, "Affinity Match");
        }

        // PASS 2: Fallback to Hardware Match (Dynamic Loading)
        let generic_match_idx = self.task_queue.iter().position(|(_id, req, _poster)| {
            let ram_ok = specs.ram_mb >= req.min_ram_mb;
            let cpu_ok = specs.thread_count >= req.min_cpu_threads;
            let gpu_ok = !req.use_gpu || specs.is_webgpu_enabled;

            // We accept any task here as long as hardware fits.
            // Affinity miss implies dynamic loading will happen.
            ram_ok && cpu_ok && gpu_ok
        });

        if let Some(idx) = generic_match_idx {
            return self.extract_task(idx, specs, "Hardware Match (Dynamic Load)");
        }

        None
    }

    fn extract_task(&mut self, idx: usize, specs: &NodeSpecs, reason: &str) -> ScheduleResult {
        // Match found! Extract specifically that task.
        let (task_id, req, posted_by) = self.task_queue.remove(idx).unwrap();

        println!(
            "⚡ Scheduler: Piping pending task {} to worker {} [{}]",
            task_id, specs.id, reason
        );
        let affinities = req.affinities.clone();
        let metadata = req.metadata.clone();
        let assignment = Assignment { node_id: specs.id.clone(), task_type: req.task_type };
        self.busy_timestamps.insert(specs.id.clone(), Instant::now());
        self.worker_to_auction.insert(specs.id.clone(), task_id.clone());
        self.busy_nodes.insert(specs.id.clone(), assignment.clone());
        Some((assignment, task_id, posted_by, affinities, metadata))
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

        const SEARCH_DEPTH: usize = 20;
        let mut buffer = Vec::new();
        let mut selected_node: Option<WorkerNode> = None;

        println!(
            "🔎 Scheduler: Scanning pool for Task {} (Affinities: {:?})",
            req.id, req.affinities
        );

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
            if trusted_partners().iter().any(|p| p == target_owner) {
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
                        "ℹ️ Node {} skipped for affinity cache (Needs {:?}).",
                        n.id, req.affinities
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
            if !req.affinities.is_empty() {
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

                if ram_ok && cpu_ok && gpu_ok && n.score > best_score {
                    best_score = n.score;
                    best_idx = Some(i);
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

    /// Removes workers whose assignments have exceeded `timeout` from the busy
    /// tracking maps and returns `(worker_id, auction_id)` pairs so the caller
    /// can re-queue their tasks via the O(1) reverse index.
    /// The worker is NOT returned to the idle pool — its actual state is unknown.
    pub fn drain_expired(&mut self, timeout: Duration) -> Vec<(String, Option<String>)> {
        let expired: Vec<String> = self
            .busy_timestamps
            .iter()
            .filter(|(_, ts)| ts.elapsed() > timeout)
            .map(|(id, _)| id.clone())
            .collect();

        expired
            .into_iter()
            .map(|id| {
                let auction_id = self.worker_to_auction.remove(&id);
                self.busy_nodes.remove(&id);
                self.busy_timestamps.remove(&id);
                (id, auction_id)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use loxi_core::{NodeSpecs, TaskRequirement, TaskType};

    fn specs(id: &str, ram_mb: u64, threads: u32, gpu: bool, affinities: Vec<&str>) -> NodeSpecs {
        NodeSpecs {
            id: id.to_string(),
            ram_mb,
            vram_mb: 0,
            thread_count: threads,
            is_webgpu_enabled: gpu,
            affinity_hashes: affinities.iter().map(|s| s.to_string()).collect(),
            verified_capacity: 0,
            owner_id: None,
        }
    }

    fn req(
        id: &str,
        min_ram: u64,
        min_cpu: u32,
        gpu: bool,
        affinities: Vec<&str>,
    ) -> TaskRequirement {
        TaskRequirement {
            id: id.to_string(),
            affinities: affinities.iter().map(|s| s.to_string()).collect(),
            min_ram_mb: min_ram,
            min_cpu_threads: min_cpu,
            use_gpu: gpu,
            task_type: TaskType::Compute,
            priority_for_owner: None,
            metadata: vec![],
        }
    }

    // Tier 2: affinity worker beats a higher-scoring generic worker
    #[test]
    fn affinity_worker_beats_higher_score_generic() {
        let mut sched = Scheduler::new();
        sched.add_worker(specs("high_score", 32_000, 16, true, vec![]));
        sched.add_worker(specs("affinity_worker", 8_000, 4, false, vec!["model-xyz"]));

        let result = sched.schedule_task(
            "t1".to_string(),
            req("t1", 4_000, 2, false, vec!["model-xyz"]),
            "poster".to_string(),
        );

        assert!(result.is_some());
        assert_eq!(result.unwrap().node_id, "affinity_worker");
    }

    // Tier 3: hardware fallback when no worker has the affinity (dynamic loading)
    #[test]
    fn hardware_fallback_when_no_affinity_match() {
        let mut sched = Scheduler::new();
        sched.add_worker(specs("worker_a", 16_000, 8, false, vec!["other-model"]));

        let result = sched.schedule_task(
            "t1".to_string(),
            req("t1", 4_000, 2, false, vec!["model-xyz"]),
            "poster".to_string(),
        );

        assert!(result.is_some());
        assert_eq!(result.unwrap().node_id, "worker_a");
    }

    // Under-spec worker: task must be queued, not assigned
    #[test]
    fn undersized_worker_queues_task() {
        let mut sched = Scheduler::new();
        sched.add_worker(specs("tiny", 2_000, 4, false, vec![]));

        let result = sched.schedule_task(
            "t1".to_string(),
            req("t1", 8_000, 2, false, vec![]),
            "poster".to_string(),
        );

        assert!(result.is_none());
    }

    // Reverse index is populated when a task is scheduled
    #[test]
    fn worker_to_auction_populated_on_schedule() {
        let mut sched = Scheduler::new();
        sched.add_worker(specs("w1", 8_000, 4, false, vec![]));

        sched.schedule_task(
            "task-42".to_string(),
            req("task-42", 1_000, 1, false, vec![]),
            "poster".to_string(),
        );

        assert_eq!(sched.worker_to_auction.get("w1").map(String::as_str), Some("task-42"));
    }

    // Reverse index is cleared when a worker is released
    #[test]
    fn release_clears_reverse_index() {
        let mut sched = Scheduler::new();
        let s = specs("w1", 8_000, 4, false, vec![]);
        sched.add_worker(s.clone());
        sched.schedule_task(
            "task-42".to_string(),
            req("task-42", 1_000, 1, false, vec![]),
            "poster".to_string(),
        );

        assert!(sched.worker_to_auction.contains_key("w1"));
        sched.release_worker("w1", s);
        assert!(!sched.worker_to_auction.contains_key("w1"));
    }

    // drain_expired returns (worker_id, Some(auction_id)) and clears reverse index
    #[test]
    fn drain_expired_returns_worker_auction_pair() {
        let mut sched = Scheduler::new();
        sched.add_worker(specs("w1", 8_000, 4, false, vec![]));
        sched.schedule_task(
            "task-exp".to_string(),
            req("task-exp", 1_000, 1, false, vec![]),
            "poster".to_string(),
        );

        std::thread::sleep(std::time::Duration::from_millis(2));
        let expired = sched.drain_expired(Duration::from_nanos(1));

        assert_eq!(expired.len(), 1);
        let (wid, aid) = &expired[0];
        assert_eq!(wid, "w1");
        assert_eq!(aid.as_deref(), Some("task-exp"));
        assert!(!sched.worker_to_auction.contains_key("w1"));
    }

    // Queued task is piped immediately to the next worker that joins
    #[test]
    fn queued_task_pipes_to_next_available_worker() {
        let mut sched = Scheduler::new();

        let result = sched.schedule_task(
            "task-pending".to_string(),
            req("task-pending", 1_000, 1, false, vec![]),
            "poster".to_string(),
        );
        assert!(result.is_none()); // Queued

        let pipe = sched.add_worker(specs("w1", 8_000, 4, false, vec![]));
        assert!(pipe.is_some());
        let (assignment, task_id, ..) = pipe.unwrap();
        assert_eq!(assignment.node_id, "w1");
        assert_eq!(task_id, "task-pending");
    }
}
