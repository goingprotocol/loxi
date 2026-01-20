// @ts-check

/**
 * @param {unknown} solution
 * @returns {string}
 */
export function getSolverVersion(solution) {
  // @ts-ignore
  const version = solution?.metadata?.solver_version;
  return version ? String(version) : "-";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function formatNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return String(value);
  }
  return num.toFixed(2);
}

/**
 * @param {unknown} solution
 * @returns {number}
 */
export function extractPenalty(solution) {
  // @ts-ignore
  const breakdown = solution?.cost_breakdown || {};
  const timePenalty = Number(breakdown.time_window_penalty || 0);
  const capacityPenalty = Number(breakdown.capacity_penalty || 0);
  return timePenalty + capacityPenalty;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
export function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function randomSeed() {
  const buffer = new Uint32Array(2);
  crypto.getRandomValues(buffer);
  return (BigInt(buffer[0]) << 32n) | BigInt(buffer[1]);
}

/**
 * @param {unknown[]} routeIds
 * @returns {{routeForMap: string[], duplicateCount: number}}
 */
export function normalizeRouteForMap(routeIds) {
  const routeForMap = [];
  let lastId = null;
  let duplicateCount = 0;

  for (const id of routeIds) {
    const str = String(id);
    if (str === lastId) {
      duplicateCount += 1;
      continue;
    }
    routeForMap.push(str);
    lastId = str;
  }

  return { routeForMap, duplicateCount };
}

/**
 * @param {number[]} values
 */
export function summarizeStats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const median = sorted[Math.floor(sorted.length / 2)];
  const p90 = sorted[Math.floor(sorted.length * 0.9) - 1] ?? max;
  const avg = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  return { min, max, median, p90, avg };
}


