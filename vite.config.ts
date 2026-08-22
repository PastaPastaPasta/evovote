import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative base so the same build works on GitHub Pages project paths
  // (https://<user>.github.io/evovote/) and any other static host.
  base: './',
  plugins: [react()],
  optimizeDeps: {
    // The SDK is a single large ESM file with inlined compressed WASM;
    // esbuild pre-bundling only slows dev startup down.
    exclude: ['@dashevo/evo-sdk', '@dashevo/wasm-sdk'],
  },
  build: {
    target: 'es2022',
    // The WASM SDK chunk is ~9 MB by design; silence the default 500 kB nag.
    chunkSizeWarningLimit: 12000,
  },
});
