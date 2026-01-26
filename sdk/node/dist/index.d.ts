interface NodeSpecs {
    id: string;
    ram_mb: number;
    vram_mb: number;
    thread_count: number;
    is_webgpu_enabled: boolean;
}
declare class HardwareProbe {
    static getSpecs(nodeId: string): Promise<NodeSpecs>;
}

declare class LoxiNode {
    private ws;
    private url;
    private nodeId;
    constructor(url: string, nodeId: string);
    start(): Promise<void>;
    private connect;
    private sendHandshake;
}

export { HardwareProbe, LoxiNode, type NodeSpecs };
