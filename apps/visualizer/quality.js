// @ts-check

import { extractPenalty, randomSeed, summarizeStats } from "./utils.js";

/**
 * @param {ReturnType<import("./dom.js").getDom>} dom
 * @param {(msg: string) => void} setStatus
 * @param {() => Promise<any>} loadWasmModule
 * @param {() => any} parseProblem
 */
export async function runQualityReport(dom, setStatus, loadWasmModule, parseProblem) {
  setStatus("Loading WASM...");
  const wasm = await loadWasmModule();

  setStatus("Parsing problem...");
  const problem = parseProblem();
  const problemJson = JSON.stringify(problem);

  const runs = 10;
  const costs = [];
  const penalties = [];
  const violations = [];
  const solveTimes = [];

  for (let i = 0; i < runs; i += 1) {
    const seed = randomSeed();
    const start = performance.now();
    const solutionJson = wasm.solve_route_seeded(problemJson, seed);
    const elapsedMs = performance.now() - start;
    const solution = JSON.parse(solutionJson);
    costs.push(Number(solution.cost || 0));
    penalties.push(extractPenalty(solution));
    violations.push(Array.isArray(solution.violations) ? solution.violations.length : 0);
    solveTimes.push(elapsedMs);
  }

  const costStats = summarizeStats(costs);
  const penaltyStats = summarizeStats(penalties);
  const violationStats = summarizeStats(violations);
  const timeStats = summarizeStats(solveTimes);

  if (dom.qualityReportEl) {
    dom.qualityReportEl.textContent = [
      `Runs: ${runs}`,
      `Cost (min/median/avg/p90/max): ${costStats.min.toFixed(2)} / ${costStats.median.toFixed(
        2
      )} / ${costStats.avg.toFixed(2)} / ${costStats.p90.toFixed(2)} / ${costStats.max.toFixed(2)}`,
      `Penalties (min/median/avg/p90/max): ${penaltyStats.min.toFixed(
        2
      )} / ${penaltyStats.median.toFixed(2)} / ${penaltyStats.avg.toFixed(2)} / ${penaltyStats.p90.toFixed(
        2
      )} / ${penaltyStats.max.toFixed(2)}`,
      `Violations (min/median/avg/p90/max): ${violationStats.min} / ${violationStats.median} / ${violationStats.avg.toFixed(
        2
      )} / ${violationStats.p90} / ${violationStats.max}`,
      `Solve time ms (min/median/avg/p90/max): ${timeStats.min.toFixed(2)} / ${timeStats.median.toFixed(
        2
      )} / ${timeStats.avg.toFixed(2)} / ${timeStats.p90.toFixed(2)} / ${timeStats.max.toFixed(2)}`,
      "",
      "Tip: If penalties/violations stay near zero across runs, the route is likely feasible and stable.",
    ].join("\n");
  }

  setStatus("Quality report ready");
}


