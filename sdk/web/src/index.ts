
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
    worker_id: string;
    result_hash: string;
    payload: string | null;
    metadata: [string, string][];
}

export interface ArtifactContext {
    addLog: (msg: string, level: 'info' | 'success' | 'error' | 'action') => void;
    specs: NodeSpecs;
    lease: WorkerLease;
}

export type WorkerEvent =
    | { type: 'CONNECTED' }
    | { type: 'DISCONNECTED' }
    | { type: 'TASK_BROADCAST', requirement: TaskRequirement }
    | { type: 'TASK_ASSIGNED', lease: WorkerLease }
    | { type: 'TASK_COMPLETED', auction_id: string, duration: number }
    | { type: 'TASK_ERROR', auction_id: string, error: string }
    | { type: 'LOG', message: string, level: 'info' | 'success' | 'error' | 'action' };

/**
 * Shared Type Contract (Loxi Protocol v3)
 * This SDK is AGNOSTIC. It does not know about Logistics, Finance, or AI.
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
    | { RevealRequest: { auction_id: string, destination: string } }
    | { UpdateMissionStatus: { mission_id: string, status: string, details?: string } }
    | { KeepAlive: {} }
    | { Error: string };

export class LoxiWorkerDevice {
    private ws: WebSocket | null = null;
    private specs: NodeSpecs | null = null;
    private activeLease: WorkerLease | null = null;
    private isBidding: boolean = false;
    private eventListeners: ((event: WorkerEvent) => void)[] = [];
    private pendingReveal: { auction_id: string, ticket: string, payload: string, architect_address: string } | null = null;

    private constraints: { maxRamMb?: number, maxThreads?: number } = {};

    constructor(private orchestratorUrl: string) { }

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
            if (this.pendingReveal && this.pendingReveal.auction_id === req.auction_id) {
                this.addLog(`🔓 Revealing data for ${req.auction_id}`, "action");
                this.revealingSolution(this.pendingReveal);
            }
        }
    }

    private async executeAgnosticTask(lease: WorkerLease) {
        try {
            let archAddr = lease.architect_address;

            // Local dev helper (should be configurable)
            if (archAddr.includes("192.168.0.196")) {
                archAddr = archAddr.replace("192.168.0.196", "localhost");
            }

            // 1. DATA FETCH
            this.addLog(`📥 Claiming Data from Architect...`, "action");
            const dataSocket = new WebSocket(archAddr);
            const responseMsg: LoxiMessage = await new Promise((resolve, reject) => {
                dataSocket.onopen = () => {
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
                setTimeout(() => reject("Timeout"), 15000);
            });

            // PROTOCOL CONSISTENCY: Architect returns LoxiMessage::PostTask
            let payload: string | null = null;
            if ('PostTask' in responseMsg) {
                payload = responseMsg.PostTask.payload;
            } else {
                // Fallback for legacy or direct binary sends (though not standard)
                payload = typeof responseMsg === 'string' ? responseMsg : JSON.stringify(responseMsg);
            }

            if (!payload) {
                throw new Error("No payload received from Architect.");
            }

            // 2. ARTIFACT RESOLUTION (Agnostic Dynamic Download)
            const affinityArtifact = lease.affinities?.find(a => a.startsWith("loxi_")) || "unknown";
            this.addLog(`🚀 Downloading Artifact from Architect: ${affinityArtifact}`, "action");

            // Derive Artifact URL from Architect Address
            // Transition from ws://3006 (Data Plane) -> http://3007 (Artifact Store)
            let archBase = archAddr.replace("ws://", "http://").replace("wss://", "https://");
            if (archBase.includes(":3006")) {
                archBase = archBase.replace(":3006", ":3007");
            }

            const moduleUrl = `${archBase}/artifacts/${affinityArtifact}.js`;

            // AGNOSTIC ON-DEMAND LOADING: Only download what we need, when we need it.
            this.addLog(`📂 Fetching Artifact: ${moduleUrl}`, "info");
            const module = await import(/* @vite-ignore */ moduleUrl);

            this.addLog(`✅ Artifact Loaded: ${affinityArtifact}`, "success");

            // CACHING: Update local specs and notify Orchestrator
            if (this.specs && !this.specs.affinity_hashes.includes(affinityArtifact)) {
                this.specs.affinity_hashes.push(affinityArtifact);
                try {
                    localStorage.setItem('loxi_affinities', JSON.stringify(this.specs.affinity_hashes));
                } catch (e) {
                    console.warn("SDK: Failed to persist affinity cache", e);
                }
                this.addLog(`💾 Caching Affinity: ${affinityArtifact}`, "info");
                this.ws?.send(JSON.stringify({ RegisterNode: this.specs }));
            }

            if (typeof module.run !== 'function') {
                throw new Error(`Artifact ${affinityArtifact} from ${moduleUrl} does not implement ABI.`);
            }

            // 3. RUN
            const start = Date.now();
            const context: ArtifactContext = {
                addLog: (m, t) => this.addLog(m, t),
                specs: this.specs!,
                lease
            };

            const result = await module.run(payload, context);
            const duration = Date.now() - start;

            // 4. COMMIT
            const resultString = JSON.stringify(result);
            const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(resultString));
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const resultHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

            this.pendingReveal = {
                auction_id: lease.auction_id,
                ticket: lease.ticket,
                payload: resultString,
                architect_address: archAddr
            };

            this.ws?.send(JSON.stringify({
                SubmitSolution: {
                    auction_id: lease.auction_id,
                    worker_id: this.specs?.id,
                    result_hash: resultHash,
                    payload: null,
                    metadata: [["duration", duration.toString()]]
                }
            }));

            this.emit({ type: 'TASK_COMPLETED', auction_id: lease.auction_id, duration });

        } catch (err: any) {
            this.addLog(`❌ Execution Failed: ${err}`, "error");
            this.emit({ type: 'TASK_ERROR', auction_id: lease.auction_id, error: String(err) });
        } finally {
            this.activeLease = null;
            this.isBidding = false;
        }
    }

    private revealingSolution(pending: any) {
        const ws = new WebSocket(pending.architect_address);
        ws.onopen = () => {
            ws.send(JSON.stringify({
                PushSolution: {
                    auction_id: pending.auction_id,
                    ticket: pending.ticket,
                    payload: pending.payload
                }
            }));
            setTimeout(() => ws.close(), 500);
        };
    }
}
