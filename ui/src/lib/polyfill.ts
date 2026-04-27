// Browser polyfills for the Lovejoin SDK.
//
// The SDK + mesh use `Buffer` (e.g. `Buffer.from` to wrap byte arrays before
// CBOR encoding in offchain/src/tx/{deposit,withdraw}.ts). Vite does not
// polyfill node globals — we expose `Buffer` via the `buffer` package so the
// SDK runs unchanged in the browser. Imported once for side effects from
// main.tsx before any SDK code loads.
//
// Why not vite-plugin-node-polyfills: a single global is all we need; pulling
// in a polyfill plugin would ship process/stream/crypto shims we don't use.

import { Buffer as BufferImpl } from "buffer";

declare global {
  interface Window {
    Buffer: typeof BufferImpl;
  }
}

if (typeof window !== "undefined" && !window.Buffer) {
  window.Buffer = BufferImpl;
}

if (typeof globalThis !== "undefined" && !(globalThis as { Buffer?: unknown }).Buffer) {
  (globalThis as { Buffer: typeof BufferImpl }).Buffer = BufferImpl;
}
