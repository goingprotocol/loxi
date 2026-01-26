import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    noExternal: ['isomorphic-ws'],
    platform: 'browser',
    shims: true,
});
