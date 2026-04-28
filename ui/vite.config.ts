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

// esbuild plugin that mirrors the Rollup `resolve.alias` below for the
// broken `./libsodium-sumo.mjs` relative import. Vite's dev pre-bundle
// uses esbuild directly and doesn't read Vite's resolve config, so we
// install the same redirect at the esbuild layer too.
const libsodiumEsbuildShim = {
  name: "lovejoin-libsodium-shim",
  setup(build: import("esbuild").PluginBuild) {
    build.onResolve({ filter: /^\.\/libsodium-sumo\.mjs$/ }, () => ({
      path: libsodiumSumoMjs,
    }));
  },
};

// mesh's @sidan-lab/sidan-csl-rs-browser ships a Wasm bundle the SDK loads at
// runtime. Vite's default loader doesn't handle the "ESM integration proposal
// for Wasm" form, so we add vite-plugin-wasm + vite-plugin-top-level-await
// (the latter is required because the wasm init is awaited at the module top
// level). nodePolyfills covers the few node builtins mesh's deps reach for
// in browser code (events, crypto, stream, util). All four plugins are dev
// dependencies and only affect the bundler.
export default defineConfig({
  // Read .env from the workspace root, not ui/. Keeps the project to a
  // single source of truth (workspace .env) for both UI runtime config
  // (VITE_*) and backend / CLI / Makefile config. Vite still only
  // exposes VITE_* keys to client code — the non-VITE entries in the
  // shared file are ignored by the bundler.
  envDir: "..",
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
    // Only the package that actually trips the wasm + top-level-await
    // combo is excluded. Earlier we also excluded @meshsdk/core +
    // @meshsdk/core-cst, but that left their transitive @cardano-sdk
    // deps un-optimized too — and @cardano-sdk/util does
    // `import { bech32 } from "bech32"` against a CJS-only `bech32`
    // package, which Vite's native ESM resolver rejects ("does not
    // provide an export named 'bech32'"). Letting esbuild pre-bundle
    // the mesh stack handles the CJS↔ESM named-export interop.
    exclude: ["@sidan-lab/sidan-csl-rs-browser"],
    esbuildOptions: {
      plugins: [libsodiumEsbuildShim as unknown as import("esbuild").Plugin],
    },
  },
});

