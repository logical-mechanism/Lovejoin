// Off-main-thread vault scan.
//
// scanPool's inner loop is `maxIndex × |pool|` BLS12-381 G1 scalar muls.
// On a ~50K-box pool with ~100 owned indices that's ~5M scalar muls and
// several seconds of synchronous CPU even with the decompression cache
// from the previous perf pass. Yielding every 4 indices helped the
// browser stay painted but the wall-clock didn't change — the user still
// waited, and on large vaults Chrome eventually pops the "Wait for app"
// dialog.
//
// This worker runs the same loop off the main thread. Vite (`?worker` /
// the URL+import.meta.url pattern) bundles it as a separate module-graph
// entry, the BLS WASM initialises inside the worker, and the main thread
// stays interactive throughout. The user keeps seeing the
// "Loading your boxes…" hint instead of a frozen tab.
//
// Wire shape:
//
//   main → worker  { seed, entries: { ref, a, b }[], maxIndex, minProbe }
//   worker → main  { ownedIndices: { entryIdx, depositIndex, secret }[],
//                    poolSize, nextDepositIndex }
//
// We pass entries as flat-byte tuples rather than the SDK's `PoolEntry`
// shape so the message stays structured-clone-friendly (no bigints in
// the wire path). Owner secret is shipped back as a 32-byte hex so the
// main thread can rehydrate the Scalar via the SDK's existing
// `bytesToScalar` path.

// IMPORTANT: deep-import the leaf submodules instead of `@lovejoin/sdk`'s
// barrel. The barrel re-exports the tx-builder / chain-provider layers
// which transitively pull in mesh + sidan-csl's Wasm. Vite's worker
// bundler ships without the wasm plugin chain the main app uses, so
// importing the barrel from here crashes the production build with
// "ESM integration proposal for Wasm is not supported". The crypto +
// wallet seed modules are pure blst-ts + WebCrypto, no mesh, so the
// worker bundles cleanly.
import { deriveOwnerSecret } from "@lovejoin/sdk/wallet/seed";
import { pointEqual, pointFromBytes, scalarMul, scalarToBytes } from "@lovejoin/sdk/crypto/bls";

interface ScanRequest {
  seed: Uint8Array;
  /**
   * Pool entries to scan. `ref` is opaque to the worker (passed through
   * verbatim on the response) so we don't have to ship the full
   * `PoolEntry` shape across `postMessage`.
   */
  entries: ReadonlyArray<{
    ref: { txId: string; outputIndex: number };
    a: Uint8Array;
    b: Uint8Array;
  }>;
  maxIndex: number;
  minProbe: number;
}

interface ScanHit {
  /** Index into the request's `entries` array — the main thread looks
   *  up the actual `PoolEntry` from this. */
  entryIdx: number;
  depositIndex: number;
  /** 64-hex master secret for `depositIndex` (consistent across hits
   *  for the same `depositIndex`; the main thread dedupes by index). */
  secretHex: string;
}

interface ScanResponse {
  hits: ReadonlyArray<ScanHit>;
  /** Highest depositIndex with a hit, +1 — what the next deposit should
   *  claim. -1 + 1 = 0 when nothing was found. */
  nextDepositIndex: number;
  poolSize: number;
}

self.onmessage = (event: MessageEvent<ScanRequest>) => {
  const { seed, entries, maxIndex, minProbe } = event.data;

  // Decompress (a, b) once per entry. Malformed entries are skipped —
  // they can't be ours since validation at spend time would reject
  // them anyway.
  const decoded: Array<{
    entryIdx: number;
    aPt: ReturnType<typeof pointFromBytes>;
    bPt: ReturnType<typeof pointFromBytes>;
  }> = [];
  for (let idx = 0; idx < entries.length; idx++) {
    const e = entries[idx]!;
    try {
      decoded.push({ entryIdx: idx, aPt: pointFromBytes(e.a), bPt: pointFromBytes(e.b) });
    } catch {
      // skip
    }
  }

  const hits: ScanHit[] = [];
  let lastHit = -1;
  for (let i = 0; i < maxIndex; i++) {
    const x = deriveOwnerSecret(seed, i);
    let matchedAny = false;
    let cachedSecretHex: string | null = null;
    for (const d of decoded) {
      if (pointEqual(scalarMul(x, d.aPt), d.bPt)) {
        if (cachedSecretHex === null) {
          cachedSecretHex = bytesToHex(scalarToBytes(x));
        }
        hits.push({
          entryIdx: d.entryIdx,
          depositIndex: i,
          secretHex: cachedSecretHex,
        });
        matchedAny = true;
      }
    }
    if (matchedAny) lastHit = i;
    if (i - lastHit >= minProbe && lastHit >= 0) break;
    if (i - lastHit >= minProbe && lastHit < 0 && i >= minProbe * 2) break;
  }

  const response: ScanResponse = {
    hits,
    nextDepositIndex: lastHit + 1,
    poolSize: entries.length,
  };
  (self as unknown as Worker).postMessage(response);
};

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

// Surfaced so the main-side TypeScript can import the request/response
// shapes without re-declaring them. The worker module's runtime entry
// point is the `onmessage` handler above; these exports are
// erased-at-runtime types only.
export type { ScanRequest, ScanResponse, ScanHit };
