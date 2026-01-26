// @ts-check

import { extractPenalty, formatNumber, getSolverVersion } from "./utils.js";

/**
 * @param {ReturnType<import("./dom.js").getDom>} dom
 * @param {string} message
 */
export function setStatus(dom, message) {
  if (dom.statusEl) dom.statusEl.textContent = message;
}

/**
 * @param {ReturnType<import("./dom.js").getDom>} dom
 * @param {unknown} message
 */
export function setError(dom, message) {
  if (!dom.errorsEl) {
    return;
  }
  const text = (message ?? "").toString().trim();
  dom.errorsEl.textContent = text ? text : "No errors.";
}

/**
 * @param {ReturnType<import("./dom.js").getDom>} dom
 */
export function clearError(dom) {
  setError(dom, "");
}

/**
 * @param {ReturnType<import("./dom.js").getDom>} dom
 */
export function setSummaryEmpty(dom) {
  if (dom.summaryStopsEl) dom.summaryStopsEl.textContent = "-";
  if (dom.summaryCostEl) dom.summaryCostEl.textContent = "-";
  if (dom.summaryPenaltyEl) dom.summaryPenaltyEl.textContent = "-";
  if (dom.summaryViolationsEl) dom.summaryViolationsEl.textContent = "-";
  if (dom.summaryTimeEl) dom.summaryTimeEl.textContent = "-";
  if (dom.summaryModeEl) dom.summaryModeEl.textContent = "-";
  if (dom.summarySolverEl) dom.summarySolverEl.textContent = "-";
}

/**
 * @param {ReturnType<import("./dom.js").getDom>} dom
 */
export function setDetailsEmpty(dom) {
  if (dom.detailsEl) dom.detailsEl.textContent = "Solve a route to see cost breakdown and violations.";
}

/**
 * @param {unknown} solution
 */
function formatDetailsFromSolution(solution) {
  // @ts-ignore
  const breakdown = solution?.cost_breakdown || {};
  // @ts-ignore
  const violations = Array.isArray(solution?.violations) ? solution.violations : [];

  const lines = [];
  lines.push(`Solver: ${getSolverVersion(solution)}`);
  // @ts-ignore
  if (solution?.metadata?.seed !== undefined && solution?.metadata?.seed !== null) {
    // @ts-ignore
    lines.push(`Seed: ${String(solution.metadata.seed)}`);
  }
  // @ts-ignore
  if (solution?.metadata?.solve_time_ms !== undefined && solution?.metadata?.solve_time_ms !== null) {
    // @ts-ignore
    lines.push(`Solve time (solver metadata): ${String(solution.metadata.solve_time_ms)} ms`);
  }
  lines.push("");
  lines.push("Cost breakdown:");

  const keys = [
    "total_distance",
    "total_time",
    "time_window_penalty",
    "capacity_penalty",
    "priority_cost",
  ];

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(breakdown, key)) {
      lines.push(`- ${key}: ${formatNumber(breakdown[key])}`);
    }
  }

  for (const [key, value] of Object.entries(breakdown)) {
    if (keys.includes(key)) continue;
    lines.push(`- ${key}: ${formatNumber(value)}`);
  }

  lines.push("");
  lines.push(`Violations (${violations.length}):`);
  if (violations.length === 0) {
    lines.push("- none");
  } else {
    for (const v of violations.slice(0, 50)) {
      if (typeof v === "string") {
        lines.push(`- ${v}`);
      } else {
        lines.push(`- ${JSON.stringify(v)}`);
      }
    }
    if (violations.length > 50) {
      lines.push(`- ... ${violations.length - 50} more`);
    }
  }

  return lines.join("\n");
}

/**
 * @param {ReturnType<import("./dom.js").getDom>} dom
 * @param {unknown} solution
 */
export function setDetailsFromSolution(dom, solution) {
  if (!dom.detailsEl) {
    return;
  }
  dom.detailsEl.textContent = formatDetailsFromSolution(solution);
}

/**
 * @param {ReturnType<import("./dom.js").getDom>} dom
 * @param {{solution: any, mode: string, solveTimeMs: number}} params
 */
export function setSummaryFromSolution(dom, { solution, mode, solveTimeMs }) {
  const route = Array.isArray(solution?.route) ? solution.route : [];
  const stops = route.length;
  const cost = Number(solution?.cost || 0);
  const penalty = extractPenalty(solution);
  const violationsCount = Array.isArray(solution?.violations) ? solution.violations.length : 0;
  const solverVersion = getSolverVersion(solution);

  if (dom.summaryStopsEl) dom.summaryStopsEl.textContent = String(stops);
  if (dom.summaryCostEl) dom.summaryCostEl.textContent = Number.isFinite(cost) ? cost.toFixed(2) : "-";
  if (dom.summaryPenaltyEl)
    dom.summaryPenaltyEl.textContent = Number.isFinite(penalty) ? penalty.toFixed(2) : "-";
  if (dom.summaryViolationsEl) dom.summaryViolationsEl.textContent = String(violationsCount);
  if (dom.summaryTimeEl) dom.summaryTimeEl.textContent = `${Number(solveTimeMs || 0).toFixed(2)} ms`;
  if (dom.summaryModeEl) dom.summaryModeEl.textContent = String(mode || "-");
  if (dom.summarySolverEl) dom.summarySolverEl.textContent = solverVersion;
  if (dom.summaryMemoryEl) {
    // @ts-ignore
    if (typeof performance !== "undefined" && performance.memory) {
      // @ts-ignore
      const used = performance.memory.usedJSHeapSize / 1024 / 1024;
      dom.summaryMemoryEl.textContent = `~${used.toFixed(1)} MB (JS Heap)`;
    } else {
      dom.summaryMemoryEl.textContent = "N/A (Browser restricted)";
    }
  }
}

/**
 * @param {ReturnType<import("./dom.js").getDom>} dom
 * @param {boolean} isBusy
 */
export function setUiBusy(dom, isBusy) {
  const busy = Boolean(isBusy);
  if (dom.solveBtn) dom.solveBtn.disabled = busy;
  if (dom.solveParallelBtn) dom.solveParallelBtn.disabled = busy;
  if (dom.qualityBtn) dom.qualityBtn.disabled = busy;
  if (dom.loadExampleBtn) dom.loadExampleBtn.disabled = busy;
  if (dom.loadExample25Btn) dom.loadExample25Btn.disabled = busy;
  if (dom.loadExample60Btn) dom.loadExample60Btn.disabled = busy;
  if (dom.cancelBtn) dom.cancelBtn.disabled = !busy;
}


