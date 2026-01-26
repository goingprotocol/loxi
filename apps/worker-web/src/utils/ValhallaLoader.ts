export interface EmscriptenModule {
    onRuntimeInitialized: () => void;
    locateFile: (path: string) => string;
    print: (text: string) => void;
    printErr: (text: string) => void;
    ccall: (ident: string, returnType: string | null, argTypes: string[], args: any[]) => any;
    FS?: any;
    _init_valhalla?: (configPath: string) => void;
}

declare global {
    interface Window {
        valhallaModule?: EmscriptenModule;
        Module?: any;
        FS?: any;
    }
}

let loadingPromise: Promise<EmscriptenModule> | null = null;

export const loadValhalla = async (): Promise<EmscriptenModule> => {
    if (window.valhallaModule) {
        return window.valhallaModule;
    }

    if (loadingPromise) {
        return loadingPromise;
    }

    loadingPromise = new Promise<EmscriptenModule>((resolve, reject) => {
        console.log("🏋️ Initializing Valhalla Engine (Emscripten Environment)...");

        // 1. Prepare Standard window.Module
        const Module: any = {
            onRuntimeInitialized: () => {
                console.log("✅ Valhalla WASM core ready");

                // Capture helpers (already present in existing logic)
                const stringDecoder = Module.UTF8ToString ||
                    Module.Pointer_stringify ||
                    (Module.asm ? Module.asm.UTF8ToString : null) ||
                    (window as any)["UTF8ToString"];

                if (stringDecoder) Module.UTF8ToString = stringDecoder;

                const exceptionDecoder = Module.getExceptionMessage || (Module.asm ? Module.asm.getExceptionMessage : null);
                if (exceptionDecoder) Module.getExceptionMessage = exceptionDecoder;

                const _malloc = Module._malloc || (Module.asm ? Module.asm._malloc : null) || Module.malloc;
                if (_malloc) Module._malloc = _malloc;

                const stringToUTF8 = Module.stringToUTF8 || (window as any)["stringToUTF8"];
                if (stringToUTF8) Module.stringToUTF8 = stringToUTF8;

                const lengthBytesUTF8 = Module.lengthBytesUTF8 || (window as any)["lengthBytesUTF8"];
                if (lengthBytesUTF8) Module.lengthBytesUTF8 = lengthBytesUTF8;

                if (Module.FS) {
                    // Already captured
                } else if (window.FS) {
                    Module.FS = window.FS;
                } else if (Module["asm"] && Module["asm"]["FS"]) {
                    Module.FS = Module["asm"]["FS"];
                }

                window.valhallaModule = Module as EmscriptenModule;
                resolve(window.valhallaModule);
            },
            locateFile: (path: string) => `${window.location.origin}/artifacts/${path}`,
            print: (text: string) => console.log("[VALHALLA]", text),
            printErr: (text: string) => console.warn("[VALHALLA ERR]", text),
        };

        window.Module = Module;

        // 2. Prevent Duplicate Injection (Robust Check)
        const scriptId = "loxi-valhalla-script";
        const existingScript = document.getElementById(scriptId);
        if (existingScript) {
            console.log("♻️ Valhalla script already in DOM. Re-using or waiting...");
            // If the script is already there, we might just need to wait for Module.onRuntimeInitialized
            // but that already happened if resolved once. 
            // Better to just let the script load again if needed, or if window.Module is already set up.
        }

        console.log("💉 Injecting patched loxi_valhalla.js...");
        const script = document.createElement("script");
        script.id = scriptId;
        script.src = `${window.location.origin}/artifacts/loxi_valhalla.js`;
        script.async = true;
        script.onerror = () => {
            loadingPromise = null;
            const el = document.getElementById(scriptId);
            if (el) el.remove();
            reject(new Error("Failed to load loxi_valhalla.js script"));
        };
        document.body.appendChild(script);
    });

    return loadingPromise;
};
