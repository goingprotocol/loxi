
import { loadValhalla } from './ValhallaLoader';

/**
 * Calls the Valhalla WASM bridge to generate a matrix or other response.
 * @param jsonInput The JSON string input for Valhalla (e.g. { sources: [...], targets: [...] })
 * @returns The JSON string response from Valhalla, or an error JSON string.
 */
export const callValhallaBridge = async (jsonInput: string): Promise<string> => {
    try {
        let module = (window as any).valhallaModule;
        if (!module) {
            console.warn("⚠️ Valhalla Module not found in window, attempting to load...");
            module = await loadValhalla();
        }
        if (!module) throw new Error("Valhalla module NOT loaded");

        const parsed = JSON.parse(jsonInput);

        // 🧱 SANITIZATION: Valhalla matrix is picky about structure
        if (parsed.locations && !parsed.sources) {
            parsed.sources = parsed.locations;
            parsed.targets = parsed.locations;
            delete parsed.locations; // Matrix service prefers sources/targets
        }

        if (!parsed.costing) parsed.costing = "auto";

        const finalInput = JSON.stringify(parsed);
        console.log("📏 Valhalla Bridge Input:", finalInput.slice(0, 500) + "...");

        // @ts-ignore
        const res = module.ccall("valhalla_matrix", "string", ["string"], [finalInput]);

        if (!res || res === "") {
            throw new Error("Empty response from WASM engine");
        }

        if (res.includes("Valhalla not initialized")) {
            console.error("⛔ CRITICAL: Valhalla actor is NULL.");
            return JSON.stringify({ error: "VALHALLA_NOT_INITIALIZED", message: "Motor Valhalla no inicializado." });
        }

        // Validate JSON response
        try {
            const parsedRes = JSON.parse(res);
            if (parsedRes.error) {
                console.warn("⚠️ Valhalla Bridge returned internal error:", parsedRes.error);
            }
            return res;
        } catch (jsonErr) {
            console.error("❌ Invalid JSON from WASM:", res);
            return JSON.stringify({ error: "INVALID_WASM_JSON", raw: res });
        }

    } catch (e: any) {
        console.error("❌ Valhalla Bridge Crash:", e);
        return JSON.stringify({ error: String(e) });
    }
};
