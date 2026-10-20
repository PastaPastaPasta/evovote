import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { withCsp } from './src/csp';

/** The Content-Security-Policy meta, on built pages only (src/csp.ts). */
const contentSecurityPolicy: Plugin = {
  name: 'evovote-csp',
  apply: 'build',
  transformIndexHtml: { order: 'post', handler: (html) => withCsp(html) },
};

export default defineConfig({
  // Relative base so the same build works on GitHub Pages project paths
  // (https://<user>.github.io/evovote/) and any other static host.
  base: './',
  plugins: [react(), contentSecurityPolicy],
  optimizeDeps: {
    // The SDK is a single large ESM file with inlined compressed WASM;
    // esbuild pre-bundling only slows dev startup down.
    exclude: ['@dashevo/evo-sdk', '@dashevo/wasm-sdk'],
  },
  build: {
    target: 'es2022',
    // The WASM SDK chunk is ~12.6 MB (5.0.0-rc.4) by design; silence the
    // default 500 kB nag but still warn if it balloons further.
    chunkSizeWarningLimit: 14000,
  },
});
