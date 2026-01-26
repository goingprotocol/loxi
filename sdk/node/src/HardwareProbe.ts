export interface NodeSpecs {
    id: string;
    ram_mb: number;
    vram_mb: number;
    thread_count: number;
    is_webgpu_enabled: boolean;
}

export class HardwareProbe {
    static async getSpecs(nodeId: string): Promise<NodeSpecs> {
        const isBrowser = typeof window !== 'undefined';
        const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;

        let ram_mb = 0;
        let thread_count = 1;
        let is_webgpu_enabled = false;
        let vram_mb = 0;

        if (isBrowser) {
            // Browser Environment
            const nav = navigator as any;
            thread_count = nav.hardwareConcurrency || 4;
            // @ts-ignore
            ram_mb = (nav.deviceMemory || 4) * 1024; // deviceMemory is in GB

            if (nav.gpu) {
                try {
                    const adapter = await nav.gpu.requestAdapter();
                    if (adapter) {
                        is_webgpu_enabled = true;
                        // WebGPU doesn't expose VRAM size directly for privacy, 
                        // but we can assume a tiers based on limits or user agent helper
                        vram_mb = 2000; // Minimal assumption for a valid GPU
                    }
                } catch (e) {
                    console.warn("WebGPU not available:", e);
                }
            }
        } else if (isNode) {
            // Node.js Environment
            try {
                const os = require('os');
                thread_count = os.cpus().length;
                ram_mb = Math.floor(os.totalmem() / 1024 / 1024);

                // Node.js doesn't have WebGPU standard yet (unless using binding like headless-gl)
                // For now we assume no GPU on Node unless explicitly configured
                is_webgpu_enabled = false;
            } catch (e) {
                console.warn("Could not load OS module", e);
            }
        }

        return {
            id: nodeId,
            ram_mb,
            vram_mb,
            thread_count,
            is_webgpu_enabled
        };
    }
}
