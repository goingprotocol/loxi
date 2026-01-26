// @ts-check

function makeWorkerPool(count) {
  const workers = [];
  for (let i = 0; i < count; i += 1) {
    workers.push(new Worker("./solver_worker.js", { type: "module" }));
  }
  return {
    workers,
    terminate() {
      workers.forEach((w) => w.terminate());
    },
  };
}

/**
 * @param {{
 *  problemJson: string,
 *  runs: number,
 *  workers: number,
 *  budgetMs: number,
 *  onProgress?: (p: {completed: number, requested: number, bestPenalty: number, bestCost: number, phase?: string}) => void,
 * }} params
 */
export function runBestOfInWorkers({ problemJson, runs, workers, budgetMs, onProgress }) {
  const pool = makeWorkerPool(workers);
  let deadlineMs = performance.now() + budgetMs;
  let cancelled = false;

  let started = false;
  let requested = 0;
  let completed = 0;

  /** @type {any|null} */
  let bestSolution = null;
  /** @type {{penalty: number, cost: number} | null} */
  let bestScore = null;

  let requestCounter = 0;
  const inFlight = new Map();

  let resolvePromise = null;
  let rejectPromise = null;

  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  function cleanup() {
    pool.terminate();
    inFlight.clear();
  }

  function canScheduleMore() {
    return requested < runs && performance.now() < deadlineMs;
  }

  function maybeFinish() {
    if (cancelled) {
      return true;
    }
    if (completed >= runs || (!canScheduleMore() && inFlight.size === 0)) {
      cleanup();
      if (resolvePromise) {
        resolvePromise({
          requested,
          completed,
          bestSolution,
          bestPenalty: bestScore ? bestScore.penalty : 0,
          bestCost: bestScore ? bestScore.cost : 0,
        });
      }
      return true;
    }
    return false;
  }

  function scheduleOn(worker, workerIndex) {
    if (cancelled || !canScheduleMore()) {
      return;
    }
    const requestId = requestCounter++;
    const seed = BigInt(Date.now()) ^ (BigInt(workerIndex + 1) << 48n) ^ BigInt(requestId);
    requested += 1;

    inFlight.set(requestId, { workerIndex });
    worker.postMessage({
      type: "solve",
      requestId,
      problemJson,
      seed: seed.toString(),
    });

    if (onProgress && bestScore) {
      onProgress({
        completed,
        requested,
        bestPenalty: bestScore.penalty,
        bestCost: bestScore.cost,
        phase: "running",
      });
    }
  }

  function scoreSolution(solution) {
    const breakdown = solution?.cost_breakdown || {};
    const timePenalty = Number(breakdown.time_window_penalty || 0);
    const capacityPenalty = Number(breakdown.capacity_penalty || 0);
    const penalty = timePenalty + capacityPenalty;
    const cost = Number(solution?.cost || 0);
    return { penalty, cost };
  }

  // Worker init + scheduling
  setTimeout(() => {
    started = true;
    if (cancelled) return;
    pool.workers.forEach((worker, workerIndex) => {
      scheduleOn(worker, workerIndex);
    });
  }, 1500);

  pool.workers.forEach((worker, workerIndex) => {
    worker.onmessage = (event) => {
      const msg = event.data || {};
      const requestId = msg.requestId;

      if (msg.type === "ready") {
        scheduleOn(worker, workerIndex);
        return;
      }

      if (msg.type === "result") {
        if (requestId !== undefined && requestId !== null) {
          inFlight.delete(requestId);
        }
        completed += 1;

        try {
          const solution = JSON.parse(String(msg.solutionJson || "{}"));
          const score = scoreSolution(solution);
          if (!bestScore || score.penalty < bestScore.penalty || (score.penalty === bestScore.penalty && score.cost < bestScore.cost)) {
            bestScore = score;
            bestSolution = solution;
          }
        } catch (_err) {
          // ignore parse errors
        }

        if (onProgress) {
          onProgress({
            completed,
            requested,
            bestPenalty: bestScore ? bestScore.penalty : 0,
            bestCost: bestScore ? bestScore.cost : 0,
            phase: "running",
          });
        }

        if (maybeFinish()) return;
        scheduleOn(worker, workerIndex);
        return;
      }

      if (msg.type === "error") {
        if (requestId !== undefined && requestId !== null) {
          inFlight.delete(requestId);
        }
        completed += 1;
        if (maybeFinish()) return;
        if (started) scheduleOn(worker, workerIndex);
      }
    };

    worker.postMessage({ type: "init" });
  });

  return {
    promise,
    cancel() {
      cancelled = true;
      cleanup();
      if (resolvePromise) {
        resolvePromise({
          requested,
          completed,
          bestSolution,
          bestPenalty: bestScore ? bestScore.penalty : 0,
          bestCost: bestScore ? bestScore.cost : 0,
        });
      }
    },
  };
}


