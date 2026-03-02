
export type TaskType = "Compute" | "Proxy" | { Custom: string };

export interface NodeSpecs {
    id: string;
    ram_mb: number;
    vram_mb: number;
    thread_count: number;
    is_webgpu_enabled: boolean;
    affinity_hashes: string[];
    verified_capacity: number;
    owner_id?: string;
}

export interface TaskRequirement {
    id: string;
    affinities: string[];
    min_ram_mb: number;
    use_gpu: boolean;
    task_type: TaskType;
    priority_for_owner?: string;
    metadata: [string, string][];
}

export interface WorkerLease {
    auction_id: string;
    worker_id: string;
    architect_address: string;
    task_type: TaskType;
    ticket: string;
    affinities?: string[];
    metadata?: [string, string][];
}

export interface Solution {
    auction_id: string;
    mission_id?: string;
    worker_id: string;
    result_hash: string;
    payload: string | null;
    metadata: [string, string][];
}

export interface ArtifactContext {
    addLog: (msg: string, level: 'info' | 'success' | 'error' | 'action') => void;
    specs: NodeSpecs;
    lease: WorkerLease;
    dependencies: Map<string, ArrayBuffer>;
    architectBase: string;
}

export const WORKER_STATUS = {
    SUCCESS: 0,
    ERROR: 1,
    LOG: 2
} as const;

export type WorkerEvent =
    | { type: 'CONNECTED' }
    | { type: 'DISCONNECTED' }
    | { type: 'TASK_BROADCAST', requirement: TaskRequirement }
    | { type: 'TASK_ASSIGNED', lease: WorkerLease }
    | { type: 'TASK_COMPLETED', auction_id: string, duration: number }
    | { type: 'TASK_ERROR', auction_id: string, error: string }
    | { type: 'OWNER_NOTIFICATION', notify_type: string, payload: string, metadata: [string, string][] }
    | { type: 'SIGNAL', from_id: string, payload: string }
    | { type: 'LOG', message: string, level: 'info' | 'success' | 'error' | 'action' };

/**
 * Shared Type Contract (Loxi Protocol v3)
 * This SDK is AGNOSTIC. It does not know about Logistics, Finance, or any specific domain.
 * It only speaks the Loxi Message Protocol.
 */
export type LoxiMessage =
    | { RegisterNode: NodeSpecs }
    | { RegisterAuthority: { domain_id: string, authority_address: string } }
    | { DiscoverAuthority: { domain_id: string } }
    | { AuthorityFound: { domain_id: string, authority_address: string } }
    | { ClaimTask: { auction_id: string, ticket: string } }
    | { RequestLease: { domain_id: string, requirement: TaskRequirement, count: number } }
    | { LeaseAssignment: WorkerLease }
    | { PostTask: { auction_id: string, requirement: TaskRequirement, payload: string | null } }
    | { SubmitBid: { auction_id: string, worker_id: string, specs: NodeSpecs, price: number } }
    | { SubmitSolution: Solution }
    | { PushData: { auction_id: string, payload: string, progress: number } }
    | { PushSolution: { auction_id: string, ticket: string, payload: string } }
    | { AuctionClosed: { auction_id: string, winner_id: string, winning_hash: string } }
    | { RevealRequest: { auction_id: string, worker_id: string, destination: string } }
    | { UpdateMissionStatus: { mission_id: string, status: string, details?: string } }
    | {
        NotifyOwner: {
            owner_id: string,
            notify_type: string,
            payload: string,
            metadata: [string, string][]
        }
    }
    | { Signal: { from_id: string, target_id: string, payload: string } }
    | { KeepAlive: {} }
    | { Error: string };

export class LoxiWorkerDevice {
    private ws: WebSocket | null = null;
    private specs: NodeSpecs | null = null;
    private activeLease: WorkerLease | null = null;
    private isBidding: boolean = false;
    private eventListeners: ((event: WorkerEvent) => void)[] = [];
    private pendingReveals = new Map<string, { ticket: string, payload: string, architect_address: string }>();

    private constraints: { maxRamMb?: number, maxThreads?: number } = {};

    private orchestratorUrl: string;

    constructor(orchestratorUrl: string) {
        this.orchestratorUrl = orchestratorUrl;
    }

    public setConstraints(constraints: { maxRamMb?: number, maxThreads?: number }) {
        this.constraints = constraints;
        if (this.specs) this.refreshSpecs();
    }

    public setSpecs(specs: NodeSpecs) {
        this.specs = specs;
        this.refreshSpecs();
    }

    private refreshSpecs() {
        if (!this.specs) return;
        const realThreads = navigator.hardwareConcurrency || 4;
        // @ts-ignore
        const realRamGb = navigator.deviceMemory || 4;
        const realRamMb = realRamGb * 1024;
        this.specs.ram_mb = Math.min(this.constraints.maxRamMb || realRamMb, realRamMb);
        this.specs.thread_count = Math.min(this.constraints.maxThreads || realThreads, realThreads);
    }

    public onEvent(callback: (event: WorkerEvent) => void) {
        this.eventListeners.push(callback);
    }

    private emit(event: WorkerEvent) {
        this.eventListeners.forEach(cb => cb(event));
    }

    private addLog(message: string, level: 'info' | 'success' | 'error' | 'action' = 'info') {
        this.emit({ type: 'LOG', message, level });
    }

    public connect() {
        if (!this.specs) throw new Error("NodeSpecs must be set before connecting");

        this.ws = new WebSocket(this.orchestratorUrl);

        this.ws.onopen = () => {
            this.emit({ type: 'CONNECTED' });
            this.addLog("Synchronized with Grid Orchestrator", "success");

            // PERSISTENCE RECOVERY
            try {
                const cached = localStorage.getItem('loxi_affinities');
                if (cached && this.specs) {
                    const parsed = JSON.parse(cached);
                    if (Array.isArray(parsed)) {
                        // Merge unique
                        const newSet = new Set([...this.specs.affinity_hashes, ...parsed]);
                        this.specs.affinity_hashes = Array.from(newSet);
                        this.addLog(`♻️ Restored ${parsed.length} cached affinities`, "info");
                    }
                }
            } catch (e) {
                console.warn("SDK: Failed to load affinity cache", e);
            }

            this.ws?.send(JSON.stringify({ RegisterNode: this.specs }));
        };

        this.ws.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                this.handleMessage(msg);
            } catch (err) {
                console.error("SDK: Message parse fail", err);
            }
        };

        this.ws.onclose = () => {
            this.emit({ type: 'DISCONNECTED' });
            this.addLog("Disconnected from Grid", "error");
        };
    }

    private async handleMessage(msg: any) {
        if (msg.RequestLease) {
            const req = msg.RequestLease.requirement;
            if (this.activeLease || this.isBidding) return;

            // Compatibility check
            const freeRam = (this.specs?.ram_mb || 0) * 0.8;
            if (req.min_ram_mb <= freeRam) {
                this.isBidding = true;
                this.emit({ type: 'TASK_BROADCAST', requirement: req });

                this.ws?.send(JSON.stringify({
                    SubmitBid: {
                        auction_id: req.id,
                        worker_id: this.specs?.id,
                        specs: this.specs,
                        price: 10
                    }
                }));

                // Failsafe bidding lock
                setTimeout(() => { if (!this.activeLease) this.isBidding = false; }, 5000);
            }
        }

        if (msg.LeaseAssignment) {
            const lease = msg.LeaseAssignment;
            if (this.activeLease) return;
            this.isBidding = false;
            this.activeLease = lease;
            this.emit({ type: 'TASK_ASSIGNED', lease });
            this.executeAgnosticTask(lease);
        }

        if (msg.RevealRequest) {
            const req = msg.RevealRequest;
            const pending = this.pendingReveals.get(req.auction_id);
            if (pending) {
                this.addLog(`🔓 Merit Granted. Revealing payload for ${req.auction_id}`, "success");
                this.revealingSolution(req.auction_id, pending);
                this.pendingReveals.delete(req.auction_id); // Clear state
            }
        }

        if (msg.NotifyOwner) {
            const { notify_type, payload, metadata } = msg.NotifyOwner;
            this.addLog(`📢 Notification Received: ${notify_type}`, "info");
            this.emit({ type: 'OWNER_NOTIFICATION', notify_type, payload, metadata });
        }

        if (msg.Signal) {
            const { from_id, payload } = msg.Signal;
            this.emit({ type: 'SIGNAL', from_id, payload });
        }
    }

    /**
     * Send an opaque signaling message to another node via the orchestrator.
     * Use this to exchange WebRTC SDP offers/answers and ICE candidates.
     */
    public sendSignal(targetId: string, payload: string) {
        if (!this.specs?.id) throw new Error("Node not registered");
        this.ws?.send(JSON.stringify({
            Signal: { from_id: this.specs.id, target_id: targetId, payload }
        }));
    }

    private async executeAgnosticTask(lease: WorkerLease) {
        try {
            let archAddr = lease.architect_address;

            // Local dev helper
            if (archAddr.includes("192.168.0.196")) {
                archAddr = archAddr.replace("192.168.0.196", "localhost");
            }

            // 1. DATA FETCH
            this.addLog(`📥 Claiming Data from Architect...`, "action");

            let responseMsg: LoxiMessage;

            // STANDARD WEBSOCKET PROTOCOL
            const dataSocket = new WebSocket(archAddr);
            responseMsg = await new Promise((resolve, reject) => {
                dataSocket.onopen = () => {
                    this.addLog("🔌 Connected to Architect Data Plane", "success");
                    dataSocket.send(JSON.stringify({ ClaimTask: { auction_id: lease.auction_id, ticket: lease.ticket } }));
                };
                dataSocket.onmessage = (e) => {
                    try {
                        resolve(JSON.parse(e.data));
                    } catch (err) {
                        reject(`Failed to parse Architect response: ${err}`);
                    }
                };
                dataSocket.onerror = () => reject("Data connection failed");
                setTimeout(() => reject("Timeout claiming data (15s)"), 15000);
            });

            // PROTOCOL CONSISTENCY
            let payload: string | null = null;
            if ('PostTask' in responseMsg) {
                payload = responseMsg.PostTask.payload;
            } else {
                payload = typeof responseMsg === 'string' ? responseMsg : JSON.stringify(responseMsg);
            }

            if (payload === null) throw new Error("No payload received from Architect.");

            // AGNOSTIC UNWRAPPING
            if (payload.startsWith("{")) {
                try {
                    const outer = JSON.parse(payload);
                    if (outer.payload && typeof outer.payload === 'string' && outer.payload.startsWith("{")) {
                        payload = outer.payload;
                    }
                } catch (e) { }
            }

            // Re-assert for TS
            const finalPayload = payload as string;

            this.addLog(`📥 Data Payload Ready (${finalPayload.length} bytes)`, "info");

            // 2. ARTIFACT RESOLUTION & EXECUTION via WORKER
            const taskStart = performance.now();
            const affinityArtifact = lease.affinities?.find(a => a.startsWith("loxi_")) || "unknown";
            this.addLog(`🚀 Launching Worker for: ${affinityArtifact}`, "action");

            let archBase = "";
            try {
                // Parse URL to get origin (host:port) and strip path 
                // e.g. ws://localhost:8080/logistics/data -> http://localhost:8080
                const urlObj = new URL(archAddr);
                const protocol = urlObj.protocol === 'wss:' ? 'https:' : 'http:';
                archBase = `${protocol}//${urlObj.host}`;
            } catch (e) {
                // Fallback for raw strings if somehow not a valid URL
                archBase = archAddr.replace("ws://", "http://").replace("wss://", "https://");
            }

            // In Loxi Node V1 (Modular Monolith), Artifacts are served by the same server as the API.
            // If the orchestrator is on 3005, then the artifacts are also on 3005 under /logistics/.
            // (Keeping old 8080 logic for legacy deployments if any, but favoring consistency)
            if (archBase.includes(":3005") || archBase.includes(":3006")) {
                // No-op: Serve from the same server in modular monolith mode
            }

            // DYNAMIC RESOLUTION: Map affinity to worker path
            const workerName = affinityArtifact.replace("loxi_", "");
            const workerUrl = `${archBase}/assets/pkg/${workerName}/worker.js`.replace("/assets/pkg", "/logistics/assets/pkg").replace("/logistics/logistics", "/logistics");

            // Determine Task Type for Worker Protocol (Harmonized with templates)
            let taskType = 'UNKNOWN';
            if (affinityArtifact.includes("matrix")) taskType = 'CALCULATE_MATRIX';
            else if (affinityArtifact.includes("vrp")) taskType = 'SOLVE_VRP';
            else if (affinityArtifact.includes("partitioner")) taskType = 'PARTITION_PROBLEM';

            this.addLog(`👷 Spawning Agnostic Worker from ${workerUrl}`, "info");

            // Cross-Origin Shim:
            // Chrome/Safari/Firefox don't allow 'new Worker(remoteUrl)' across origins.
            // We create a minimal Blob shim that imports the remote module.
            // This preserves the 'base' of the remote script, so native imports like 
            // '../../shared/...' inside the worker still work!
            const shim = `
                let pending = null;
                function shimHandler(e) {
                    pending = e;
                    console.log('📦 [Shim] Message buffered:', e.data.type);
                }
                self.onmessage = shimHandler;
                console.log('👷 [Shim] Attempting to import worker from: ${workerUrl}');
                import('${workerUrl}')
                    .then(() => {
                        console.log('✅ [Shim] Worker script imported successfully');
                        if (pending && self.onmessage !== shimHandler) {
                             console.log('🚀 [Shim] Re-dispatching buffered message to new handler');
                             const msg = pending;
                             pending = null;
                             self.onmessage(msg);
                        }
                    })
                    .catch(err => {
                        console.error('❌ [Shim] Failed to load worker script:', err);
                        self.postMessage({ 
                            status: 2, 
                            level: 'error', 
                            message: 'Failed to load worker script: ' + err.message 
                        });
                    });
            `;
            const blob = new Blob([shim], { type: 'application/javascript' });
            const blobUrl = URL.createObjectURL(blob);
            const worker = new Worker(blobUrl, { type: 'module' });

            const result = await new Promise<any>((resolve, reject) => {
                worker.onmessage = (e) => {
                    const { status, type, result, error, message, level } = e.data;

                    // 1. Handle Logs from Worker
                    if (status === WORKER_STATUS.LOG) {
                        this.addLog(`👷 [${workerName.toUpperCase()}] ${message}`, level || 'info');
                        return;
                    }

                    // 2. Handle Completion (Legacy string support + Numeric)
                    const normalizedType = type ? type.toUpperCase() : '';
                    if (status === WORKER_STATUS.SUCCESS || normalizedType === 'SUCCESS') resolve(result);
                    if (status === WORKER_STATUS.ERROR || normalizedType === 'ERROR') reject(error);
                };
                worker.onerror = (e) => {
                    console.error("🏁 Worker Shim Error:", e);
                    reject(`Worker Loading/Execution Error: Check CORS/CSP or network errors at ${workerUrl}`);
                };

                // Send Payload + Context
                worker.postMessage({
                    type: taskType,
                    payload: finalPayload,
                    ctx: {
                        architectBase: archBase,
                        lease: lease,
                        specs: this.specs
                    }
                });
            });

            worker.terminate();
            URL.revokeObjectURL(blobUrl);

            // Update affinity cache
            if (this.specs && !this.specs.affinity_hashes.includes(affinityArtifact)) {
                this.specs.affinity_hashes = [...this.specs.affinity_hashes, affinityArtifact];
                try {
                    localStorage.setItem('loxi_affinities', JSON.stringify(this.specs.affinity_hashes));
                } catch (_) {}
                // Re-register with updated specs so orchestrator knows about new affinity
                this.ws?.send(JSON.stringify({ RegisterNode: this.specs }));
                this.addLog(`♻️ Registered affinity: ${affinityArtifact}`, 'info');
            }

            this.addLog(`✅ Worker Execution Complete`, "success");

            // 4. COMMIT (Loxi Protocol v3 Handshake)
            const resultString = typeof result === 'string' ? result : JSON.stringify(result);
            const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(resultString));
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const resultHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

            this.pendingReveals.set(lease.auction_id, {
                ticket: lease.ticket,
                payload: resultString,
                architect_address: archAddr
            });

            // Send COMMIT
            const missionId = lease.metadata?.find(m => m[0] === 'mission_id')?.[1];
            const taskDuration = Math.round(performance.now() - taskStart);

            this.ws?.send(JSON.stringify({
                SubmitSolution: {
                    auction_id: lease.auction_id,
                    mission_id: missionId,
                    worker_id: this.specs?.id,
                    result_hash: resultHash,
                    payload: null,
                    metadata: [
                        ["duration", String(taskDuration)],
                        ["score", "100"]
                    ]
                }
            }));

            this.addLog(`🔒 Commit Sent (Hash: ${resultHash.substring(0, 8)}...)`, "success");
            this.emit({ type: 'TASK_COMPLETED', auction_id: lease.auction_id, duration: taskDuration });

        } catch (err: any) {
            this.addLog(`❌ Execution Failed: ${err}`, "error");
            this.emit({ type: 'TASK_ERROR', auction_id: lease.auction_id, error: String(err) });
        } finally {
            this.activeLease = null;
            this.isBidding = false;
        }
    }

    private revealingSolution(auctionId: string, pending: any) {
        const ws = new WebSocket(pending.architect_address);
        ws.onopen = () => {
            ws.send(JSON.stringify({
                PushSolution: {
                    auction_id: auctionId,
                    ticket: pending.ticket,
                    payload: pending.payload
                }
            }));
            setTimeout(() => ws.close(), 500);
        };
    }

    /**
     * Specialized helper to run the solution visualizer.
     */
    public async runVisualizer(payload: string, architectUrl?: string) {
        return this.runAgnosticWorker(
            architectUrl || this.orchestratorUrl.replace("/orchestrator", "/logistics/data"),
            "solution_visualizer",
            "VISUALIZE_ROUTES",
            payload
        );
    }

    /**
     * Executes a generic worker artifact downloaded from the grid.
     */
    public async runAgnosticWorker(
        architectAddr: string,
        workerName: string,
        taskType: string,
        payload: string
    ): Promise<any> {
        let archBase = "";
        try {
            const urlObj = new URL(architectAddr);
            const protocol = urlObj.protocol === 'wss:' ? 'https:' : 'http:';
            const path = urlObj.pathname.replace(/\/data$/, "").replace(/\/$/, "");
            archBase = `${protocol}//${urlObj.host}${path}`;
        } catch (e) {
            archBase = architectAddr.replace("ws://", "http://").replace("wss://", "https://").replace(/\/data$/, "").replace(/\/$/, "");
        }

        const workerUrl = `${archBase}/assets/pkg/${workerName}/worker.js`.replace("/assets/pkg", "/logistics/assets/pkg").replace("/logistics/logistics", "/logistics");
        this.addLog(`👷 Spawning Visualizer Worker from ${workerUrl}`, "info");

        const shim = `import '${workerUrl}';`;
        const blob = new Blob([shim], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        const worker = new Worker(blobUrl, { type: 'module' });

        try {
            const result = await new Promise<any>((resolve, reject) => {
                worker.onmessage = (e) => {
                    const { status, type, result, error, message, level } = e.data;
                    if (status === WORKER_STATUS.LOG) {
                        this.addLog(`👷 [${workerName.toUpperCase()}] ${message}`, level || 'info');
                        return;
                    }
                    const normalizedType = type ? type.toUpperCase() : '';
                    if (status === WORKER_STATUS.SUCCESS || normalizedType === 'SUCCESS') resolve(result);
                    if (status === WORKER_STATUS.ERROR || normalizedType === 'ERROR') reject(error);
                };
                worker.onerror = (_e) => reject(`Worker execution failed: ${workerUrl}`);

                worker.postMessage({
                    type: taskType,
                    payload,
                    ctx: {
                        architectBase: archBase,
                        specs: this.specs
                    }
                });
            });
            return result;
        } finally {
            worker.terminate();
            URL.revokeObjectURL(blobUrl);
        }
    }
}
