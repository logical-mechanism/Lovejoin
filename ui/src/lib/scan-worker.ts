// Off-main-thread vault scan.
//
// PR #150 moved the BLS scalar-mul loop here so the main thread no
// longer freezes during unlock. This module then evolved to keep state
// across messages — the decompression cache and the previous scan's
// owned set live at module scope so each message after the first only
// pays for the pool diff (see `scan-core.ts` for the algorithm). On a
// healthy session that turns post-tx rescans from "5-15 s of
// 'Loading your boxes…'" into "well under a second, no spinner".
//
// Wire shape:
//
//   main → worker  { type: "scan", seed, entries, maxIndex, minProbe }
//   main → worker  { type: "reset" }                — drop all caches
//   worker → main  { hits, nextDepositIndex, poolSize, decompressed, scalarMuls }
//
// The "reset" message is sent by the main thread when the user re-locks
// the vault and the worker is being kept alive (cheaper than spinning a
// new worker; the BLS WASM init isn't free). The worker also detects
// seed changes via a fingerprint check inside `runIncrementalScan` and
// resets itself, but the explicit message is kept for callers that want
// to be sure.
//
// We pass entries as flat-byte tuples rather than the SDK's `PoolEntry`
// shape so the message stays structured-clone-friendly (no bigints in
// the wire path). Owner secret is shipped back as a 32-byte hex so the
// main thread can rehydrate the Scalar via `BigInt("0x" + hex)`.

// IMPORTANT: deep-import the leaf submodules instead of `@lovejoin/sdk`'s
// barrel. The barrel re-exports the tx-builder / chain-provider layers
// which transitively pull in mesh + sidan-csl's Wasm. Vite's worker
// bundler ships without the wasm plugin chain the main app uses, so
// importing the barrel from here crashes the production build with
// "ESM integration proposal for Wasm is not supported". The crypto +
// wallet seed modules are pure noble-curves + WebCrypto, no mesh, so
// the worker bundles cleanly. `scan-core.ts` is a sibling module that
// imports from the same two leaf paths, so it inherits the same
// guarantee.
import { newScanState, resetScanState, runIncrementalScan } from "./scan-core.js";
import type { ScanInput, ScanResponse } from "./scan-core.js";

interface ScanRequest extends ScanInput {
  type: "scan";
}

interface ResetRequest {
  type: "reset";
}

type WorkerRequest = ScanRequest | ResetRequest;

const state = newScanState();

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  if (req.type === "reset") {
    resetScanState(state);
    return;
  }
  const response: ScanResponse = runIncrementalScan(state, {
    seed: req.seed,
    entries: req.entries,
    maxIndex: req.maxIndex,
    minProbe: req.minProbe,
  });
  (self as unknown as Worker).postMessage(response);
};

// Surfaced so the main-side TypeScript can import the request/response
// shapes without re-declaring them. The worker module's runtime entry
// point is the `onmessage` handler above; these exports are
// erased-at-runtime types only.
export type { ScanRequest, ResetRequest, WorkerRequest };
export type { ScanResponse, ScanHit, ScanInput } from "./scan-core.js";
