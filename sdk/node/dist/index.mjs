var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/HardwareProbe.ts
var HardwareProbe = class {
  static async getSpecs(nodeId) {
    const isBrowser = typeof window !== "undefined";
    const isNode = typeof process !== "undefined" && process.versions != null && process.versions.node != null;
    let ram_mb = 0;
    let thread_count = 1;
    let is_webgpu_enabled = false;
    let vram_mb = 0;
    if (isBrowser) {
      const nav = navigator;
      thread_count = nav.hardwareConcurrency || 4;
      ram_mb = (nav.deviceMemory || 4) * 1024;
      if (nav.gpu) {
        try {
          const adapter = await nav.gpu.requestAdapter();
          if (adapter) {
            is_webgpu_enabled = true;
            vram_mb = 2e3;
          }
        } catch (e) {
          console.warn("WebGPU not available:", e);
        }
      }
    } else if (isNode) {
      try {
        const os = __require("os");
        thread_count = os.cpus().length;
        ram_mb = Math.floor(os.totalmem() / 1024 / 1024);
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
};

// node_modules/isomorphic-ws/browser.js
var ws = null;
if (typeof WebSocket !== "undefined") {
  ws = WebSocket;
} else if (typeof MozWebSocket !== "undefined") {
  ws = MozWebSocket;
} else if (typeof global !== "undefined") {
  ws = global.WebSocket || global.MozWebSocket;
} else if (typeof window !== "undefined") {
  ws = window.WebSocket || window.MozWebSocket;
} else if (typeof self !== "undefined") {
  ws = self.WebSocket || self.MozWebSocket;
}
var browser_default = ws;

// src/LoxiNode.ts
var LoxiNode = class {
  constructor(url, nodeId) {
    this.ws = null;
    this.url = url;
    this.nodeId = nodeId;
  }
  async start() {
    const specs = await HardwareProbe.getSpecs(this.nodeId);
    console.log(`[LoxiNode] Hardware detected: RAM=${specs.ram_mb}MB, Threads=${specs.thread_count}, GPU=${specs.is_webgpu_enabled}`);
    this.connect(specs);
  }
  connect(specs) {
    this.ws = new browser_default(this.url);
    if (!this.ws) return;
    this.ws.onopen = () => {
      console.log("[LoxiNode] Connected to Orchestrator.");
      this.sendHandshake(specs);
    };
    this.ws.onmessage = (event) => {
      const data = event.data.toString();
      console.log("[LoxiNode] Message received:", data);
      try {
        const msg = JSON.parse(data);
        if (msg.wasm_module) {
          console.log(`[LoxiNode] ASSIGNMENT RECEIVED! downloading ${msg.wasm_module}...`);
        } else if (msg.error) {
          console.error(`[LoxiNode] ORCHESTRATOR REJECTED: ${msg.error}`);
        }
      } catch (e) {
        console.error("Failed to parse message", e);
      }
    };
    this.ws.onerror = (err) => {
      console.error("[LoxiNode] WebSocket Error:", err.message || err);
    };
    this.ws.onclose = () => {
      console.log("[LoxiNode] Disconnected.");
    };
  }
  sendHandshake(specs) {
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(specs));
    }
  }
};
export {
  HardwareProbe,
  LoxiNode
};
