// @ts-check

/**
 * @param {ReturnType<import("./dom.js").getDom>} dom
 */
export function parseProblem(dom) {
  const rawProblem = (dom.problemJsonEl?.value || "").trim();
  if (!rawProblem) {
    throw new Error("Problem JSON is empty. Load an example or paste one.");
  }
  try {
    return JSON.parse(rawProblem);
  } catch (error) {
    // @ts-ignore
    throw new Error(`Invalid JSON: ${error.message}`);
  }
}

/**
 * @param {any} problem
 */
export function validateProblemMvp(problem) {
  if (!problem || typeof problem !== "object") {
    throw new Error("Problem must be a JSON object.");
  }
  if (!Array.isArray(problem.stops)) {
    throw new Error('Problem is missing "stops" array.');
  }
  if (problem.stops.length === 0) {
    throw new Error("Problem has 0 stops.");
  }
  if (problem.stops.length > 200) {
    throw new Error(`Problem has ${problem.stops.length} stops. MVP demo limit is 200.`);
  }

  for (const [i, stop] of problem.stops.entries()) {
    if (!stop || typeof stop !== "object") {
      throw new Error(`Stop #${i + 1} is not an object.`);
    }
    if (!stop.id) {
      throw new Error(`Stop #${i + 1} is missing "id".`);
    }
    const loc = stop.location;
    if (!loc || typeof loc !== "object") {
      throw new Error(`Stop "${stop.id}" is missing "location".`);
    }
    if (!Number.isFinite(Number(loc.lat)) || !Number.isFinite(Number(loc.lon))) {
      throw new Error(`Stop "${stop.id}" has invalid location (lat/lon must be numbers).`);
    }
  }

  if (!problem.vehicle || typeof problem.vehicle !== "object") {
    throw new Error('Problem is missing "vehicle" object.');
  }
  return true;
}

/**
 * @param {ReturnType<import("./dom.js").getDom>} dom
 * @param {(msg: string) => void} setStatus
 * @param {string} examplePath
 */
export async function loadExample(dom, setStatus, examplePath) {
  setStatus("Loading example...");
  const problemResponse = await fetch(examplePath, { cache: "no-cache" });
  const problem = await problemResponse.json();
  if (dom.problemJsonEl) dom.problemJsonEl.value = JSON.stringify(problem, null, 2);
  setStatus("Example loaded");
  return problem;
}


