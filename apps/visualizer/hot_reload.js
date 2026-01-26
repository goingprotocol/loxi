// @ts-check

/**
 * @param {{
 *  enabled: boolean,
 *  candidates: URL[],
 *  onChange: () => void,
 * }} params
 */
export function startHotReloadPolling({ enabled, candidates, onChange }) {
  if (!enabled) {
    return;
  }

  let lastSignature = null;

  async function poll() {
    try {
      let signature = null;
      for (const wasmUrl of candidates) {
        try {
          const response = await fetch(wasmUrl.href, { method: "HEAD", cache: "no-cache" });
          signature = response.headers.get("etag") || response.headers.get("last-modified");
          if (signature) break;
        } catch (_err) {
          // ignore
        }
      }

      if (lastSignature && signature && signature !== lastSignature) {
        onChange();
        return;
      }
      lastSignature = signature ?? lastSignature;
    } catch (error) {
      console.warn("Hot reload check failed:", error);
    }
    setTimeout(poll, 1000);
  }

  poll();
}


