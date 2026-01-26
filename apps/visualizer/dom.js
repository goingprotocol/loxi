// @ts-check

export function getDom() {
  return {
    statusEl: /** @type {HTMLElement|null} */ (document.getElementById("status")),
    solveBtn: /** @type {HTMLButtonElement|null} */ (document.getElementById("solve-btn")),
    solveParallelBtn: /** @type {HTMLButtonElement|null} */ (
      document.getElementById("solve-parallel-btn")
    ),
    monitorBtn: /** @type {HTMLButtonElement|null} */ (document.getElementById("monitor-btn")),
    loadExampleBtn: /** @type {HTMLButtonElement|null} */ (document.getElementById("load-example-btn")),
    loadExample25Btn: /** @type {HTMLButtonElement|null} */ (
      document.getElementById("load-example-25-btn")
    ),
    loadExample60Btn: /** @type {HTMLButtonElement|null} */ (
      document.getElementById("load-example-60-btn")
    ),
    loadExample1000Btn: /** @type {HTMLButtonElement|null} */ (
      document.getElementById("load-example-1000-btn")
    ),
    cancelBtn: /** @type {HTMLButtonElement|null} */ (document.getElementById("cancel-btn")),
    clearBtn: /** @type {HTMLButtonElement|null} */ (document.getElementById("clear-btn")),
    qualityBtn: /** @type {HTMLButtonElement|null} */ (document.getElementById("quality-btn")),
    toggleLabelsBtn: /** @type {HTMLButtonElement|null} */ (document.getElementById("toggle-labels-btn")),
    solutionEl: /** @type {HTMLElement|null} */ (document.getElementById("solution-json")),
    qualityReportEl: /** @type {HTMLElement|null} */ (document.getElementById("quality-report")),
    errorsEl: /** @type {HTMLElement|null} */ (document.getElementById("errors")),
    detailsEl: /** @type {HTMLElement|null} */ (document.getElementById("details")),
    problemJsonEl: /** @type {HTMLTextAreaElement|null} */ (document.getElementById("problem-json")),
    mapEl: /** @type {HTMLElement|null} */ (document.getElementById("route-map")),
    parallelWorkersEl: /** @type {HTMLInputElement|null} */ (document.getElementById("parallel-workers")),
    parallelRunsEl: /** @type {HTMLInputElement|null} */ (document.getElementById("parallel-runs")),
    parallelBudgetMsEl: /** @type {HTMLInputElement|null} */ (
      document.getElementById("parallel-budget-ms")
    ),
    summaryStopsEl: /** @type {HTMLElement|null} */ (document.getElementById("summary-stops")),
    summaryCostEl: /** @type {HTMLElement|null} */ (document.getElementById("summary-cost")),
    summaryPenaltyEl: /** @type {HTMLElement|null} */ (document.getElementById("summary-penalty")),
    summaryViolationsEl: /** @type {HTMLElement|null} */ (document.getElementById("summary-violations")),
    summaryTimeEl: /** @type {HTMLElement|null} */ (document.getElementById("summary-time")),
    summaryModeEl: /** @type {HTMLElement|null} */ (document.getElementById("summary-mode")),
    summarySolverEl: /** @type {HTMLElement|null} */ (document.getElementById("summary-solver")),
    summaryMemoryEl: /** @type {HTMLElement|null} */ (document.getElementById("summary-memory")),
  };
}


