// @ts-check

import { loadWasmModule } from "./wasm_loader.js";

let initPromise = null;
let wasm = null;

async function ensureInit() {
  if (initPromise) {
    return initPromise;
  }
  initPromise = (async () => {
    wasm = await loadWasmModule();
  })();
  return initPromise;
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type === "init") {
    try {
      await ensureInit();
      self.postMessage({ type: "ready" });
    } catch (error) {
      self.postMessage({
        type: "error",
        requestId: msg.requestId ?? null,
        // @ts-ignore
        error: error?.message ? String(error.message) : String(error),
      });
    }
    return;
  }
  if (msg.type !== "solve") {
    return;
  }

  const { requestId, problemJson, seed } = msg;

  try {
    await ensureInit();

    const seedValue = typeof seed === "bigint" ? seed : BigInt(seed);
    const start = performance.now();
    const solutionJson = wasm.solve_route_seeded(problemJson, seedValue);
    const elapsedMs = performance.now() - start;

    self.postMessage({
      type: "result",
      requestId,
      seed: seedValue.toString(),
      elapsedMs,
      solutionJson,
    });
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId,
      // @ts-ignore
      error: error?.message ? String(error.message) : String(error),
    });
  }
};


