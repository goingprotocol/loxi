// @ts-check

import "./types.js";

import { getDom } from "./dom.js";
import { createMapController } from "./map.js";
import { loadWasmModule, getWasmBinaryCandidates } from "./wasm_loader.js";
import { startHotReloadPolling } from "./hot_reload.js";
import { clamp, normalizeRouteForMap, parsePositiveInt, randomSeed } from "./utils.js";
import { loadExample, parseProblem, validateProblemMvp } from "./problem.js";
import {
  clearError,
  setDetailsEmpty,
  setDetailsFromSolution,
  setError,
  setStatus,
  setSummaryEmpty,
  setSummaryFromSolution,
  setUiBusy,
} from "./ui.js";
import { runBestOfInWorkers } from "./workers.js";
import { runQualityReport } from "./quality.js";

const dom = getDom();
const map = createMapController(dom.mapEl);

let activeParallelRun = null;

const HOT_RELOAD_ENABLED =
  new URLSearchParams(window.location.search).has("hot") &&
  (location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    location.hostname === "0.0.0.0");

function cancelActiveParallelRun() {
  if (!activeParallelRun) {
    return;
  }
  try {
    activeParallelRun.cancel();
  } finally {
    activeParallelRun = null;
    setUiBusy(dom, false);
    setStatus(dom, "Cancelled");
  }
}

function clearUi() {
  cancelActiveParallelRun();
  clearError(dom);
  setSummaryEmpty(dom);
  setDetailsEmpty(dom);
  map.resetMap();
  if (dom.solutionEl) dom.solutionEl.textContent = "Waiting...";
  if (dom.qualityReportEl)
    dom.qualityReportEl.textContent = 'Run "Quality Report" to compare multiple seeds.';
  setStatus(dom, "Cleared");
}

async function solveSingle() {
  cancelActiveParallelRun();
  clearError(dom);
  setUiBusy(dom, true);

  setStatus(dom, "Parsing problem...");
  const problem = parseProblem(dom);
  validateProblemMvp(problem);
  const problemJson = JSON.stringify(problem);

  // Use 1 worker, 1 run to unblock UI
  setStatus(dom, "Solving (Worker)...");

  const start = performance.now();
  let lastProgressUpdate = 0;

  activeParallelRun = runBestOfInWorkers({
    problemJson,
    runs: 1,
    workers: 1,
    budgetMs: 60000, // Generous budget for single run
    onProgress: ({ completed, requested, bestPenalty, bestCost, phase }) => {
      // Optional: Update status if needed
    },
  });

  const result = await activeParallelRun.promise;
  const totalMs = performance.now() - start;
  activeParallelRun = null;

  if (!result.bestSolution) {
    setError(dom, "Worker completed but returned no solution.");
    setUiBusy(dom, false);
    return;
  }

  const solution = result.bestSolution;
  const solveMs = Number(result.solveMs ?? totalMs);
  const seed = solution.metadata?.seed ?? "?";

  if (dom.solutionEl) dom.solutionEl.textContent = JSON.stringify(solution, null, 2);
  const routeIds = Array.isArray(solution.route) ? solution.route : [];
  const { routeForMap, duplicateCount } = normalizeRouteForMap(routeIds);
  map.renderMapRoute(problem, routeForMap);
  setSummaryFromSolution(dom, { solution, mode: `single worker (seed ${seed})`, solveTimeMs: solveMs });
  setDetailsFromSolution(dom, solution);

  const duplicateNote = duplicateCount > 0 ? `, ${duplicateCount} duplicate stops` : "";
  setStatus(dom, `Solved in ${solveMs.toFixed(2)} ms (seed ${seed}${duplicateNote})`);
  setUiBusy(dom, false);
}

async function solveBestOfParallel() {
  cancelActiveParallelRun();
  clearError(dom);
  setUiBusy(dom, true);

  setStatus(dom, "Parsing problem...");
  const problem = parseProblem(dom);
  validateProblemMvp(problem);
  const problemJson = JSON.stringify(problem);

  const hw = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : null;
  const defaultWorkers = Number.isFinite(hw) && hw > 0 ? Math.min(4, hw) : 4;
  const requestedWorkers = parsePositiveInt(dom.parallelWorkersEl?.value, defaultWorkers);
  const workers = clamp(requestedWorkers, 1, 32);

  const runs = clamp(parsePositiveInt(dom.parallelRunsEl?.value, 16), 1, 200);
  const budgetMs = clamp(parsePositiveInt(dom.parallelBudgetMsEl?.value, 200), 10, 10000);

  const startTotal = performance.now();
  let lastProgressUpdate = 0;
  activeParallelRun = runBestOfInWorkers({
    problemJson,
    runs,
    workers,
    budgetMs,
    onProgress: ({ completed, requested, bestPenalty, bestCost, phase }) => {
      const now = performance.now();
      if (now - lastProgressUpdate < 100) {
        return;
      }
      lastProgressUpdate = now;
      const phaseLabel = phase ? `${phase}: ` : "";
      setStatus(
        dom,
        `${phaseLabel}Best-of ${completed}/${runs} (requested ${requested}), best penalty ${bestPenalty.toFixed(
          2
        )}, cost ${bestCost.toFixed(2)}`
      );
    },
  });
  const result = await activeParallelRun.promise;
  const totalMs = performance.now() - startTotal;
  activeParallelRun = null;

  if (!result.bestSolution) {
    setStatus(dom, "Best-of produced no result in time budget; falling back to single solve...");
    const wasm = await loadWasmModule();
    const seed = randomSeed();
    const startFallback = performance.now();
    const solutionJson = wasm.solve_route_seeded(problemJson, seed);
    const elapsedFallbackMs = performance.now() - startFallback;
    const solution = JSON.parse(solutionJson);
    if (dom.solutionEl) dom.solutionEl.textContent = JSON.stringify(solution, null, 2);
    const routeIds = Array.isArray(solution.route) ? solution.route : [];
    const { routeForMap, duplicateCount } = normalizeRouteForMap(routeIds);
    map.renderMapRoute(problem, routeForMap);
    setSummaryFromSolution(dom, {
      solution,
      mode: `fallback single (seed ${seed})`,
      solveTimeMs: elapsedFallbackMs,
    });
    setDetailsFromSolution(dom, solution);
    const duplicateNote = duplicateCount > 0 ? `, ${duplicateCount} duplicate stops` : "";
    setStatus(dom, `Fallback solved in ${elapsedFallbackMs.toFixed(2)} ms (seed ${seed}${duplicateNote})`);
    setUiBusy(dom, false);
    return;
  }

  if (dom.solutionEl) dom.solutionEl.textContent = JSON.stringify(result.bestSolution, null, 2);
  const routeIds = Array.isArray(result.bestSolution.route) ? result.bestSolution.route : [];
  const { routeForMap, duplicateCount } = normalizeRouteForMap(routeIds);
  map.renderMapRoute(problem, routeForMap);
  const solveMs = Number(result.solveMs ?? totalMs);
  setSummaryFromSolution(dom, {
    solution: result.bestSolution,
    mode: `best-of (${result.completed}/${runs}, ${workers} workers, budget ${budgetMs} ms)`,
    solveTimeMs: solveMs,
  });
  setDetailsFromSolution(dom, result.bestSolution);
  const duplicateNote = duplicateCount > 0 ? `, ${duplicateCount} duplicate stops` : "";
  setStatus(dom, `Best-of complete in ${solveMs.toFixed(2)} ms${duplicateNote}`);
  setUiBusy(dom, false);
}

async function monitorSwarm() {
  cancelActiveParallelRun();
  clearError(dom);
  setStatus(dom, "Connecting to Swarm Orchestrator...");

  const socket = new WebSocket("ws://localhost:3005");
  let problem = null;

  socket.onopen = () => {
    setStatus(dom, "Monitoring Grid (Active)");
    // Register as a monitor node
    socket.send(JSON.stringify({
      RegisterNode: {
        id: "monitor_" + Math.random().toString(36).substring(7),
        ram_mb: 1024,
        vram_mb: 0,
        thread_count: 1,
        is_webgpu_enabled: false,
        affinity_hashes: [],
        verified_capacity: 0
      }
    }));
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.SubmitSolution) {
        const sol = msg.SubmitSolution;
        setStatus(dom, `🏆 Solution received for ${sol.auction_id} (Cost: ${sol.cost.toFixed(2)})`);

        if (!problem) {
          problem = parseProblem(dom);
        }

        // Generate a deterministic color based on worker_id or auction_id
        const colorSeed = sol.auction_id + sol.worker_id;
        let hash = 0;
        for (let i = 0; i < colorSeed.length; i++) {
          hash = colorSeed.charCodeAt(i) + ((hash << 5) - hash);
        }
        const color = `hsl(${Math.abs(hash) % 360}, 70%, 50%)`;

        // If payload is a JSON string of a Solution object, parse it
        let route = sol.route || [];
        if (sol.payload) {
          try {
            const inner = JSON.parse(sol.payload);
            route = inner.route || route;
          } catch (e) { /* ignore */ }
        }

        const { routeForMap } = normalizeRouteForMap(route);
        map.renderMultiRoute(problem, routeForMap, color);
      }
    } catch (e) {
      console.error("Monitor error:", e);
    }
  };

  socket.onclose = () => {
    setStatus(dom, "Monitor Disconnected");
  };

  socket.onerror = (err) => {
    setError(dom, "WebSocket Connection Error");
    setStatus(dom, "Error");
  };

  // Store socket in activeParallelRun to allow cancelling/closing
  activeParallelRun = {
    cancel: () => socket.close(),
    promise: new Promise(() => { }) // Never resolves normally
  };
}

function toggleLabels() {
  const next = !map.labelsVisible;
  map.setLabelsVisible(next);
  if (dom.toggleLabelsBtn) dom.toggleLabelsBtn.textContent = next ? "Hide Labels" : "Show Labels";
}

function wireEvents() {
  dom.monitorBtn?.addEventListener("click", () => {
    monitorSwarm().catch(err => {
      console.error(err);
      setError(dom, String(err));
    });
  });

  dom.solveBtn?.addEventListener("click", () => {
    solveSingle().catch((error) => {
      console.error(error);
      setStatus(dom, "Error");
      setError(dom, String(error));
      if (dom.solutionEl) dom.solutionEl.textContent = String(error);
      setUiBusy(dom, false);
    });
  });

  dom.solveParallelBtn?.addEventListener("click", () => {
    solveBestOfParallel().catch((error) => {
      console.error(error);
      setStatus(dom, "Error");
      setError(dom, String(error));
      if (dom.solutionEl) dom.solutionEl.textContent = String(error);
      setUiBusy(dom, false);
    });
  });

  dom.cancelBtn?.addEventListener("click", () => cancelActiveParallelRun());
  dom.clearBtn?.addEventListener("click", () => clearUi());

  dom.loadExampleBtn?.addEventListener("click", () => {
    loadExample(dom, (m) => setStatus(dom, m), "../examples/simple_3stop.json").catch((error) => {
      console.error(error);
      setStatus(dom, "Error");
      setError(dom, String(error));
      if (dom.solutionEl) dom.solutionEl.textContent = String(error);
    });
  });
  dom.loadExample25Btn?.addEventListener("click", () => {
    loadExample(dom, (m) => setStatus(dom, m), "../examples/buenos_aires_25stops.json").catch((error) => {
      console.error(error);
      setStatus(dom, "Error");
      setError(dom, String(error));
      if (dom.solutionEl) dom.solutionEl.textContent = String(error);
    });
  });
  dom.loadExample60Btn?.addEventListener("click", () => {
    loadExample(dom, (m) => setStatus(dom, m), "../examples/buenos_aires_60stops.json").catch((error) => {
      console.error(error);
      setStatus(dom, "Error");
      setError(dom, String(error));
      if (dom.solutionEl) dom.solutionEl.textContent = String(error);
    });
  });

  dom.loadExample1000Btn?.addEventListener("click", () => {
    loadExample(dom, (m) => setStatus(dom, m), "../examples/large_1000stops.json").catch((error) => {
      console.error(error);
      setStatus(dom, "Error");
      setError(dom, String(error));
      if (dom.solutionEl) dom.solutionEl.textContent = String(error);
    });
  });

  dom.qualityBtn?.addEventListener("click", () => {
    runQualityReport(dom, (m) => setStatus(dom, m), loadWasmModule, () => parseProblem(dom)).catch((error) => {
      console.error(error);
      setStatus(dom, "Error");
      setError(dom, String(error));
      if (dom.qualityReportEl) dom.qualityReportEl.textContent = String(error);
    });
  });

  dom.toggleLabelsBtn?.addEventListener("click", () => toggleLabels());
}

// Initial state
setStatus(dom, "Ready");
setSummaryEmpty(dom);
clearError(dom);
setDetailsEmpty(dom);
if (dom.toggleLabelsBtn) dom.toggleLabelsBtn.textContent = map.labelsVisible ? "Hide Labels" : "Show Labels";
wireEvents();

startHotReloadPolling({
  enabled: HOT_RELOAD_ENABLED,
  candidates: getWasmBinaryCandidates(),
  onChange: () => location.reload(),
});

// Default example
loadExample(dom, (m) => setStatus(dom, m), "../examples/simple_3stop.json").catch((error) => {
  console.error(error);
  setStatus(dom, "Error");
  if (dom.solutionEl) dom.solutionEl.textContent = String(error);
});


