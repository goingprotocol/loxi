import { HardwareProbe, NodeSpecs } from './HardwareProbe';
import WebSocket from 'isomorphic-ws';

export class LoxiNode {
    private ws: WebSocket | null = null;
    private url: string;
    private nodeId: string;

    constructor(url: string, nodeId: string) {
        this.url = url;
        this.nodeId = nodeId;
    }

    async start() {
        const specs = await HardwareProbe.getSpecs(this.nodeId);
        console.log(`[LoxiNode] Hardware detected: RAM=${specs.ram_mb}MB, Threads=${specs.thread_count}, GPU=${specs.is_webgpu_enabled}`);

        this.connect(specs);
    }

    private connect(specs: NodeSpecs) {
        this.ws = new WebSocket(this.url);

        if (!this.ws) return;

        this.ws.onopen = () => {
            console.log('[LoxiNode] Connected to Orchestrator.');
            this.sendHandshake(specs);
        };

        this.ws.onmessage = (event: any) => {
            const data = event.data.toString();
            console.log('[LoxiNode] Message received:', data);

            try {
                const msg = JSON.parse(data);
                if (msg.wasm_module) {
                    console.log(`[LoxiNode] ASSIGNMENT RECEIVED! downloading ${msg.wasm_module}...`);
                    // TODO: Fetch WASM and Initialize Worker/Wasm
                } else if (msg.error) {
                    console.error(`[LoxiNode] ORCHESTRATOR REJECTED: ${msg.error}`);
                }
            } catch (e) {
                console.error('Failed to parse message', e);
            }
        };

        this.ws.onerror = (err: any) => {
            console.error('[LoxiNode] WebSocket Error:', err.message || err);
        };

        this.ws.onclose = () => {
            console.log('[LoxiNode] Disconnected.');
        };
    }

    private sendHandshake(specs: NodeSpecs) {
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
            this.ws.send(JSON.stringify(specs));
        }
    }
}
