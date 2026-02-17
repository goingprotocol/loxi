/**
 * Pure Valhalla C++ Test Loader
 * Tests if Valhalla WASM works without the Rust bridge
 */

declare global {
    var Module: any;
}

export async function testPureValhalla() {
    console.log('🧪 Testing Pure Valhalla C++ (No Rust Bridge)...');

    try {
        // Load the Emscripten JS via script tag
        const script = document.createElement('script');
        script.src = '/artifacts/valhalla_engine_pure.js';

        // Wait for script to load
        await new Promise((resolve, reject) => {
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });

        console.log('✅ Script loaded, waiting for Module to initialize...');

        // Wait for Module to be available
        let attempts = 0;
        while (!globalThis.Module && attempts < 100) {
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }

        if (!globalThis.Module) {
            throw new Error('Module not found after 10 seconds');
        }

        console.log('✅ Module found, waiting for runtime initialization...');

        // CRITICAL: Wait for Emscripten runtime to be fully initialized
        await new Promise<void>((resolve) => {
            if (globalThis.Module.calledRun) {
                // Already initialized
                resolve();
            } else {
                // Wait for onRuntimeInitialized callback
                const originalCallback = globalThis.Module.onRuntimeInitialized;
                globalThis.Module.onRuntimeInitialized = function () {
                    if (originalCallback) originalCallback();
                    resolve();
                };
            }
        });

        console.log('✅ Runtime initialized!');
        console.log('📦 Available functions:', Object.keys(globalThis.Module).filter(k => typeof globalThis.Module[k] === 'function'));

        // Now it's safe to call init_valhalla
        console.log('🔧 Calling init_valhalla...');
        const result = globalThis.Module.ccall(
            'init_valhalla',
            'number',
            ['string'],
            ['/artifacts/valhalla.json']
        );
        console.log('✅ init_valhalla result:', result);

        if (result === 0) {
            console.log('🎉 Pure Valhalla C++ is working!');
        } else {
            console.warn('⚠️ init_valhalla returned non-zero:', result);
        }

        return { success: true, module: globalThis.Module };
    } catch (error) {
        console.error('❌ Pure Valhalla test failed:', error);
        return { success: false, error };
    }
}

// Auto-run test
testPureValhalla();
