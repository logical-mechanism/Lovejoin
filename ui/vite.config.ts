import { createRequire } from "node:module";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const require = createRequire(import.meta.url);

// libsodium-wrappers-sumo's ESM build does a relative `./libsodium-sumo.mjs`
// import that doesn't exist next to it under pnpm's strict layout — the file
// lives in the sibling `libsodium-sumo` package, which doesn't expose the
// raw .mjs path through its `exports` field. We resolve the entry the
// package *does* publish (the default `.` export points at the same .mjs
// file in ESM mode) and use that absolute path as the alias target.
const libsodiumSumoMjs = require.resolve("libsodium-sumo");

// mesh's @sidan-lab/sidan-csl-rs-browser ships a Wasm bundle the SDK loads at
// runtime. Vite's default loader doesn't handle the "ESM integration proposal
// for Wasm" form, so we add vite-plugin-wasm + vite-plugin-top-level-await
// (the latter is required because the wasm init is awaited at the module top
// level). nodePolyfills covers the few node builtins mesh's deps reach for
// in browser code (events, crypto, stream, util). All four plugins are dev
// dependencies and only affect the bundler.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    wasm(),
    topLevelAwait(),
    nodePolyfills({
      include: ["buffer", "events", "crypto", "stream", "util", "process"],
      // Buffer is exposed via ui/src/lib/polyfill.ts. Disabling globals
      // here keeps the plugin from injecting magic imports into every
      // file that mentions `Buffer`, which broke Rollup resolution under
      // pnpm's strict layout (the injected shim path is unreachable from
      // sibling workspaces like offchain/dist).
      globals: { Buffer: false, global: true, process: true },
    }),
  ],
  resolve: {
    alias: [
      {
        find: /^\.\/libsodium-sumo\.mjs$/,
        replacement: libsodiumSumoMjs,
      },
    ],
  },
  server: {
    port: 5173,
  },
  optimizeDeps: {
    // Pre-bundling chokes on the wasm + top-level-await combo unless we ask
    // it to skip the mesh + csl packages — they're loaded lazily anyway.
    exclude: [
      "@meshsdk/core",
      "@meshsdk/core-cst",
      "@sidan-lab/sidan-csl-rs-browser",
    ],
  },
});

