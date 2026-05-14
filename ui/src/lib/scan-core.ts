// Incremental vault-scan core, shared by `scan-worker.ts` (off-thread)
// and `vault.ts`'s inline fallback. The algorithm is the same in both
// callers; only the surrounding lifecycle differs.
//
// Why incremental: PR #150 moved the scan off the main thread so the
// tab no longer freezes during unlock, but every triggered rescan
// (tab-focus 60 s timer, post-tx 12 s rescan, manual button) still ran
// the full O(maxIndex × poolSize) BLS scalar-mul loop. On a healthy
// session — 5-10 txs, 50K-entry pool, ~100 owned indices — that's
// 5-10 wait-for-app stretches even though the actual pool diff per
// rescan is < 100 entries.
//
// The strategy here:
//
//   * Cache decompressed (a, b) points across rescans, keyed by
//     `txId#outputIndex`. Pool entries that survive across rescans skip
//     `pointFromBytes` entirely (~25 µs each → ~2.5 s saved on a 50K
//     pool).
//
//   * Diff the pool. `appeared = pool_new \ pool_old` is the only set
//     we ever probe with deposit secrets — boxes already known to be
//     owned just get their entryIdx updated, withdrawn boxes drop off,
//     and re-randomized boxes are searched for in `appeared` using the
//     same secret as before (the math: own (a, b) → still own (a',
//     b') = ([y]·a, [y]·b) for the same x).
//
//   * `nextDepositIndex` is monotonic across the scanner's lifetime.
//     Each new-deposit pass starts there instead of from 0, so the
//     "stop after minProbe consecutive misses" heuristic doesn't have
//     to re-walk every index the user already used.
//
// Cold-start equivalence: with empty caches every entry is in
// `appeared` and the new-deposit pass starts at 0, so the first scan
// after `reset()` does exactly the work the old full scan did. The
// "first unlock unchanged" verification bullet hangs on this.
//
// Cache invalidation: `runIncrementalScan` automatically resets when
// the seed fingerprint changes (different vault unlocked into the same
// scanner), and `resetScanState` is exposed for callers that own the
// state directly.

import { deriveOwnerSecret } from "@lovejoin/sdk/wallet/seed";
import {
  pointEqual,
  pointFromBytes,
  scalarMul,
  scalarToBytes,
  type G1Point,
} from "@lovejoin/sdk/crypto/bls";

/** Wire shape for a pool entry — opaque ref + the two compressed G1 points. */
export interface ScanPoolEntry {
  ref: { txId: string; outputIndex: number };
  a: Uint8Array;
  b: Uint8Array;
}

export interface ScanInput {
  seed: Uint8Array;
  entries: ReadonlyArray<ScanPoolEntry>;
  maxIndex: number;
  /** Misses past the last hit before the new-deposit loop bails. */
  minProbe: number;
}

export interface ScanHit {
  /** Index into the request's `entries` array. */
  entryIdx: number;
  depositIndex: number;
  /** 64-hex master secret for `depositIndex`. Same value across hits
   *  that share a `depositIndex` so the caller can dedupe by index. */
  secretHex: string;
}

export interface ScanResponse {
  hits: ReadonlyArray<ScanHit>;
  /** Highest depositIndex with a hit, +1. 0 when nothing was found. */
  nextDepositIndex: number;
  poolSize: number;
  /** Diagnostic — number of `pointFromBytes` calls this scan did. */
  decompressed: number;
  /** Diagnostic — number of `scalarMul` calls this scan did. */
  scalarMuls: number;
}

interface DecodedPoint {
  aPt: G1Point;
  bPt: G1Point;
}

interface OwnedRecord {
  depositIndex: number;
  secretHex: string;
}

/**
 * Persistent state for the incremental scanner. Mutated in place by
 * `runIncrementalScan`. Each scanner instance (worker module load or
 * `VaultScanner` inline fallback) owns one of these.
 */
export interface ScanCoreState {
  seedFingerprint: string | null;
  decompCache: Map<string, DecodedPoint>;
  previousOwned: Map<string, OwnedRecord>;
  previousPoolRefs: Set<string>;
  /** Highest depositIndex ever observed + 1; only ever grows. */
  nextDepositIndex: number;
}

export function newScanState(): ScanCoreState {
  return {
    seedFingerprint: null,
    decompCache: new Map(),
    previousOwned: new Map(),
    previousPoolRefs: new Set(),
    nextDepositIndex: 0,
  };
}

export function resetScanState(state: ScanCoreState): void {
  state.seedFingerprint = null;
  state.decompCache.clear();
  state.previousOwned.clear();
  state.previousPoolRefs.clear();
  state.nextDepositIndex = 0;
}

function refKey(r: { txId: string; outputIndex: number }): string {
  return `${r.txId.toLowerCase()}#${r.outputIndex}`;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function fingerprintSeed(seed: Uint8Array): string {
  // First 16 bytes are enough to detect "different vault unlocked": the
  // seed is a blake2b output (or argon2id output), so any mismatch in
  // the first 128 bits effectively means "different seed".
  let s = "";
  const limit = Math.min(16, seed.length);
  for (let i = 0; i < limit; i++) s += seed[i]!.toString(16).padStart(2, "0");
  return s;
}

/**
 * Run one incremental scan. Mutates `state` so the next call can reuse
 * the decompression + ownership caches.
 *
 * Three phases per call:
 *
 *   1. **Survival.** For every previously-owned ref still in the pool,
 *      copy the hit verbatim (no scalar mul, no decompress).
 *
 *   2. **Re-randomization.** For each previously-owned ref that
 *      disappeared, derive its secret and probe `appeared` for the
 *      re-randomized form. A Mix that consumed an owned box always
 *      replaces it with a same-secret box at a new ref in `appeared`.
 *
 *   3. **New deposits.** Walk `[nextDepositIndex .. maxIndex)` against
 *      `appeared` only. New deposits — by definition — only ever land
 *      at refs not seen before, so probing the survivor set is wasted
 *      work. Stops after `minProbe` consecutive misses past the last
 *      hit, with a `minProbe * 2` safety floor on the very first scan
 *      so a brand-new vault doesn't bail at index 7.
 */
export function runIncrementalScan(state: ScanCoreState, input: ScanInput): ScanResponse {
  const { seed, entries, maxIndex, minProbe } = input;

  const fp = fingerprintSeed(seed);
  if (state.seedFingerprint !== fp) {
    resetScanState(state);
    state.seedFingerprint = fp;
  }

  // Build the new pool's ref index. Map serves as both "is this ref in
  // the new pool?" (Set semantics) and "which entry slot is it?" (so we
  // can produce the right entryIdx for survival hits).
  const newPoolRefs = new Set<string>();
  const refToEntryIdx = new Map<string, number>();
  for (let idx = 0; idx < entries.length; idx++) {
    const k = refKey(entries[idx]!.ref);
    newPoolRefs.add(k);
    refToEntryIdx.set(k, idx);
  }

  // Evict cache entries that are no longer in the new pool. The
  // decompressed points themselves are GC-collectible once the Map
  // releases its reference.
  for (const k of state.decompCache.keys()) {
    if (!newPoolRefs.has(k)) state.decompCache.delete(k);
  }

  // Decompress everything that wasn't already cached. The result set —
  // "appeared" — is the only set we ever search for new owned boxes.
  // Pool entries with malformed (a, b) bytes get silently dropped, same
  // as the old full-scan path.
  const appeared: Array<{ entryIdx: number; key: string; decoded: DecodedPoint }> = [];
  let decompressed = 0;
  for (let idx = 0; idx < entries.length; idx++) {
    const e = entries[idx]!;
    const k = refKey(e.ref);
    if (state.decompCache.has(k)) continue;
    let dp: DecodedPoint;
    try {
      dp = { aPt: pointFromBytes(e.a), bPt: pointFromBytes(e.b) };
    } catch {
      continue;
    }
    decompressed++;
    state.decompCache.set(k, dp);
    appeared.push({ entryIdx: idx, key: k, decoded: dp });
  }

  let scalarMuls = 0;
  const hits: ScanHit[] = [];
  const newOwned = new Map<string, OwnedRecord>();

  // Phase 1: survival. Boxes whose refs are still in the pool keep
  // their (depositIndex, secretHex) verbatim — same secret still owns
  // the same box.
  for (const [k, info] of state.previousOwned) {
    if (!newPoolRefs.has(k)) continue;
    const entryIdx = refToEntryIdx.get(k);
    if (entryIdx === undefined) continue;
    hits.push({ entryIdx, depositIndex: info.depositIndex, secretHex: info.secretHex });
    newOwned.set(k, info);
  }

  // Phase 2: re-randomization. For each owned depositIndex whose ref
  // disappeared from the pool, search `appeared` with that index's
  // secret. A Mix that re-randomized our box puts the new ref there;
  // a Withdraw means the box is gone for good and we just drop it.
  // Group by depositIndex so we re-derive each scalar once (one
  // depositIndex can map to multiple owned refs in pathological
  // duplicate-deposit cases).
  const disappearedIndices = new Set<number>();
  for (const [k, info] of state.previousOwned) {
    if (!newPoolRefs.has(k)) disappearedIndices.add(info.depositIndex);
  }
  for (const depositIndex of disappearedIndices) {
    const x = deriveOwnerSecret(seed, depositIndex);
    let secretHex: string | null = null;
    for (const a of appeared) {
      scalarMuls++;
      if (pointEqual(scalarMul(x, a.decoded.aPt), a.decoded.bPt)) {
        if (secretHex === null) secretHex = bytesToHex(scalarToBytes(x));
        hits.push({ entryIdx: a.entryIdx, depositIndex, secretHex });
        newOwned.set(a.key, { depositIndex, secretHex });
      }
    }
  }

  // Phase 3: new deposits. Walk forward from `nextDepositIndex`. We
  // probe `appeared` only — a fresh deposit always lands as a new
  // pool entry, never as a survivor. The break condition mirrors the
  // old full-scan logic: bail after `minProbe` consecutive misses past
  // the last hit, with a `minProbe * 2` safety floor when the very
  // first scan finds nothing yet (so a fresh vault still probes
  // through index 16 before giving up).
  const startIndex = state.nextDepositIndex;
  let lastHit = startIndex - 1;
  for (let i = startIndex; i < maxIndex; i++) {
    const x = deriveOwnerSecret(seed, i);
    let matchedAny = false;
    let secretHex: string | null = null;
    for (const a of appeared) {
      scalarMuls++;
      if (pointEqual(scalarMul(x, a.decoded.aPt), a.decoded.bPt)) {
        if (secretHex === null) secretHex = bytesToHex(scalarToBytes(x));
        hits.push({ entryIdx: a.entryIdx, depositIndex: i, secretHex });
        newOwned.set(a.key, { depositIndex: i, secretHex });
        matchedAny = true;
      }
    }
    if (matchedAny) lastHit = i;
    if (i - lastHit >= minProbe && (lastHit >= 0 || i >= minProbe * 2)) break;
  }

  const nextDepositIndex = Math.max(0, lastHit + 1);

  // Persist for next call. `nextDepositIndex` only ever grows: a Mix
  // or Withdraw that drops a high-index box must not reset the probe
  // cursor, or a future deposit at the next-fresh index would never
  // be found.
  state.previousPoolRefs = newPoolRefs;
  state.previousOwned = newOwned;
  state.nextDepositIndex = Math.max(state.nextDepositIndex, nextDepositIndex);

  return {
    hits,
    nextDepositIndex,
    poolSize: entries.length,
    decompressed,
    scalarMuls,
  };
}
