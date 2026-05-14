// Unit tests for the incremental scan core. These exercise the diff
// algorithm directly (no worker, no fetchPool) so we can assert both the
// hit set AND the bounded work — the perf claim in the issue is "rescan
// after a single Mix submit completes in < 1 s on a 50K pool", and the
// way to keep that honest is to count the scalar muls per call.

import { describe, expect, it } from "vitest";

import {
  deriveOwnerSecret,
  generator,
  pointFromBytes,
  pointToBytes,
  scalarMul,
  SCALAR_ORDER,
  scalarToBytes,
} from "@lovejoin/sdk";

import {
  newScanState,
  resetScanState,
  runIncrementalScan,
  type ScanPoolEntry,
} from "../src/lib/scan-core.js";

const G = generator();

function randomScalar(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  // Reduce into the scalar field, avoiding 0 (deriveOwnerSecret rejects
  // it, and `scalarMul(0, _)` is the identity which we don't want).
  const r = (n % (SCALAR_ORDER - 1n)) + 1n;
  return r;
}

function randomSeed(): Uint8Array {
  const s = new Uint8Array(32);
  crypto.getRandomValues(s);
  return s;
}

function randomRef(): { txId: string; outputIndex: number } {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let hex = "";
  for (const b of buf) hex += b.toString(16).padStart(2, "0");
  return { txId: hex, outputIndex: 0 };
}

/** Build an owned box at `(a = [d]·G, b = [x·d]·G)` for the given owner secret. */
function makeOwnedEntry(secret: bigint): ScanPoolEntry {
  const d = randomScalar();
  const a = scalarMul(d, G);
  const b = scalarMul(secret, a);
  return { ref: randomRef(), a: pointToBytes(a), b: pointToBytes(b) };
}

/** Build a foreign box owned by some random secret — never matches the test seed. */
function makeForeignEntry(): ScanPoolEntry {
  const x = randomScalar();
  const d = randomScalar();
  const a = scalarMul(d, G);
  const b = scalarMul(x, a);
  return { ref: randomRef(), a: pointToBytes(a), b: pointToBytes(b) };
}

/** Re-randomize an existing entry as a Mix would: (a', b') = ([y]·a, [y]·b). */
function rerandomize(entry: ScanPoolEntry): ScanPoolEntry {
  const y = randomScalar();
  const aPt = scalarMul(y, pointFromBytes(entry.a));
  const bPt = scalarMul(y, pointFromBytes(entry.b));
  return { ref: randomRef(), a: pointToBytes(aPt), b: pointToBytes(bPt) };
}

describe("runIncrementalScan", () => {
  it("first scan against an empty cache walks the full pool (cold-start parity)", () => {
    const seed = randomSeed();
    const owned = [0, 1, 2].map((i) => makeOwnedEntry(deriveOwnerSecret(seed, i)));
    const foreign = Array.from({ length: 40 }, () => makeForeignEntry());
    const entries = [...foreign, ...owned].sort(() => Math.random() - 0.5);

    const state = newScanState();
    const res = runIncrementalScan(state, { seed, entries, maxIndex: 64, minProbe: 8 });

    const ownedIndices = res.hits.map((h) => h.depositIndex).sort((a, b) => a - b);
    expect(ownedIndices).toEqual([0, 1, 2]);
    expect(res.nextDepositIndex).toBe(3);
    expect(res.poolSize).toBe(entries.length);
    // Cold-start decompressed every legitimate entry exactly once.
    expect(res.decompressed).toBe(entries.length);
    // Cached for subsequent scans.
    expect(state.decompCache.size).toBe(entries.length);
    expect(state.previousOwned.size).toBe(3);
  });

  it("survival pass: a no-op rescan does zero scalar muls", () => {
    const seed = randomSeed();
    const owned = [0, 1, 2].map((i) => makeOwnedEntry(deriveOwnerSecret(seed, i)));
    const foreign = Array.from({ length: 20 }, () => makeForeignEntry());
    const entries = [...foreign, ...owned];

    const state = newScanState();
    runIncrementalScan(state, { seed, entries, maxIndex: 64, minProbe: 8 });

    // Same pool, same seed: every previously-owned ref still in the
    // pool, no `appeared` entries, so the new-deposit pass walks zero
    // candidates per index.
    const res2 = runIncrementalScan(state, { seed, entries, maxIndex: 64, minProbe: 8 });
    expect(res2.hits.map((h) => h.depositIndex).sort()).toEqual([0, 1, 2]);
    expect(res2.decompressed).toBe(0); // nothing new to decompress
    expect(res2.scalarMuls).toBe(0); // no probes — survival pass is constant-time
  });

  it("Mix-consumed case: owned ref disappears, re-randomized form appears", () => {
    const seed = randomSeed();
    const x0 = deriveOwnerSecret(seed, 0);
    const x1 = deriveOwnerSecret(seed, 1);
    const owned0 = makeOwnedEntry(x0);
    const owned1 = makeOwnedEntry(x1);
    const foreign = Array.from({ length: 30 }, () => makeForeignEntry());
    const pool1 = [...foreign, owned0, owned1];

    const state = newScanState();
    const res1 = runIncrementalScan(state, {
      seed,
      entries: pool1,
      maxIndex: 64,
      minProbe: 8,
    });
    expect(res1.hits.map((h) => h.depositIndex).sort()).toEqual([0, 1]);

    // Simulate a Mix: owned0 is consumed and reappears at a new ref
    // with re-randomized (a', b'). owned1 survives untouched. A few
    // foreign boxes also get consumed/replaced as a typical Mix would
    // touch other parties' boxes too.
    const owned0Rerand = rerandomize(owned0);
    const newForeign = [makeForeignEntry(), makeForeignEntry()];
    const pool2 = [
      // drop owned0 and a couple of foreign refs
      ...foreign.slice(2),
      owned1,
      // and add the re-randomized owned + new foreign refs
      owned0Rerand,
      ...newForeign,
    ];

    const res2 = runIncrementalScan(state, {
      seed,
      entries: pool2,
      maxIndex: 64,
      minProbe: 8,
    });
    expect(res2.hits.map((h) => h.depositIndex).sort()).toEqual([0, 1]);
    // The hit for index 0 now points at the re-randomized entry.
    const hit0 = res2.hits.find((h) => h.depositIndex === 0)!;
    expect(pool2[hit0.entryIdx]!.ref).toEqual(owned0Rerand.ref);

    // Bounded work: appeared = {owned0Rerand, ...newForeign} = 3 entries.
    // Re-rand pass probes those 3 with x_0; new-deposit pass probes
    // them with each new index (8 misses past lastHit=1 → indices 2..9
    // = 8 probes × 3 appeared = 24). Plus the re-rand pass = 3.
    expect(res2.decompressed).toBe(3);
    expect(res2.scalarMuls).toBeLessThan(40);
  });

  it("Withdraw-consumed case: owned ref disappears with no replacement", () => {
    const seed = randomSeed();
    const owned = [0, 1, 2].map((i) => makeOwnedEntry(deriveOwnerSecret(seed, i)));
    const foreign = Array.from({ length: 20 }, () => makeForeignEntry());
    const pool1 = [...foreign, ...owned];

    const state = newScanState();
    runIncrementalScan(state, { seed, entries: pool1, maxIndex: 64, minProbe: 8 });

    // Withdraw consumes index 1 — its ref is just gone, no replacement
    // appears. Re-rand pass won't find it in `appeared` (which is
    // empty), so it disappears from the owned set. Indices 0 and 2
    // are unaffected.
    const pool2 = pool1.filter((e) => e.ref !== owned[1]!.ref);
    const res2 = runIncrementalScan(state, { seed, entries: pool2, maxIndex: 64, minProbe: 8 });

    expect(res2.hits.map((h) => h.depositIndex).sort()).toEqual([0, 2]);
    expect(res2.scalarMuls).toBe(0); // appeared = empty → re-rand pass is a no-op
    expect(res2.decompressed).toBe(0);
    // nextDepositIndex is monotonic — must NOT regress past index 3
    // just because index 1 went away. A future deposit at index 3
    // would be unfindable otherwise.
    expect(state.nextDepositIndex).toBeGreaterThanOrEqual(3);
  });

  it("new-deposit case: fresh deposit at the next index appears in `appeared`", () => {
    const seed = randomSeed();
    const owned = [0, 1].map((i) => makeOwnedEntry(deriveOwnerSecret(seed, i)));
    const foreign = Array.from({ length: 20 }, () => makeForeignEntry());
    const pool1 = [...foreign, ...owned];

    const state = newScanState();
    const res1 = runIncrementalScan(state, {
      seed,
      entries: pool1,
      maxIndex: 64,
      minProbe: 8,
    });
    expect(res1.nextDepositIndex).toBe(2);

    // User submits a fresh deposit at index 2.
    const newDeposit = makeOwnedEntry(deriveOwnerSecret(seed, 2));
    const pool2 = [...pool1, newDeposit];
    const res2 = runIncrementalScan(state, { seed, entries: pool2, maxIndex: 64, minProbe: 8 });

    expect(res2.hits.map((h) => h.depositIndex).sort()).toEqual([0, 1, 2]);
    expect(res2.nextDepositIndex).toBe(3);
    // Bounded: appeared = {newDeposit}, new-deposit loop scans indices
    // 2..10 (8 misses past lastHit=2) × 1 entry. Re-rand pass is empty.
    expect(res2.decompressed).toBe(1);
    expect(res2.scalarMuls).toBeLessThan(15);
  });

  it("seed change resets state automatically (defensive against stale cache)", () => {
    const seedA = randomSeed();
    const seedB = randomSeed();
    const ownedA = [0, 1].map((i) => makeOwnedEntry(deriveOwnerSecret(seedA, i)));
    const ownedB = [0, 1].map((i) => makeOwnedEntry(deriveOwnerSecret(seedB, i)));
    const entries = [...ownedA, ...ownedB];

    const state = newScanState();
    runIncrementalScan(state, { seed: seedA, entries, maxIndex: 32, minProbe: 8 });
    expect(state.previousOwned.size).toBe(2);

    const res = runIncrementalScan(state, { seed: seedB, entries, maxIndex: 32, minProbe: 8 });
    // Should return seed B's owned set, not seed A's.
    expect(res.hits.map((h) => h.depositIndex).sort()).toEqual([0, 1]);
    // And the hits must point to ownedB entries (not ownedA — a stale
    // cache could otherwise leak A's refs into B's result).
    const refs = res.hits.map((h) => entries[h.entryIdx]!.ref);
    for (const ref of refs) {
      expect(ownedB.some((e) => e.ref.txId === ref.txId)).toBe(true);
    }
  });

  it("appeared-set sweep evicts decompression entries that left the pool", () => {
    const seed = randomSeed();
    const foreign = Array.from({ length: 10 }, () => makeForeignEntry());
    const state = newScanState();
    runIncrementalScan(state, { seed, entries: foreign, maxIndex: 32, minProbe: 8 });
    expect(state.decompCache.size).toBe(10);

    // Half the foreign refs leave the pool; rest stay.
    const survivors = foreign.slice(5);
    runIncrementalScan(state, {
      seed,
      entries: survivors,
      maxIndex: 32,
      minProbe: 8,
    });
    expect(state.decompCache.size).toBe(5);
  });

  it("resetScanState wipes the scanner so the next call cold-starts", () => {
    const seed = randomSeed();
    const owned = [0].map((i) => makeOwnedEntry(deriveOwnerSecret(seed, i)));
    const foreign = Array.from({ length: 10 }, () => makeForeignEntry());
    const entries = [...foreign, ...owned];

    const state = newScanState();
    runIncrementalScan(state, { seed, entries, maxIndex: 32, minProbe: 8 });
    expect(state.decompCache.size).toBe(11);

    resetScanState(state);
    expect(state.decompCache.size).toBe(0);
    expect(state.previousOwned.size).toBe(0);
    expect(state.nextDepositIndex).toBe(0);

    const res = runIncrementalScan(state, { seed, entries, maxIndex: 32, minProbe: 8 });
    expect(res.decompressed).toBe(entries.length); // cold-start parity
    expect(res.hits.map((h) => h.depositIndex)).toEqual([0]);
  });

  it("malformed entries are silently skipped (hyperstructure recovery)", () => {
    const seed = randomSeed();
    const owned = makeOwnedEntry(deriveOwnerSecret(seed, 0));
    const garbage: ScanPoolEntry = {
      ref: randomRef(),
      a: new Uint8Array(48), // all zeros — not a valid G1 element
      b: new Uint8Array(48),
    };
    const state = newScanState();
    const res = runIncrementalScan(state, {
      seed,
      entries: [garbage, owned],
      maxIndex: 32,
      minProbe: 8,
    });
    expect(res.hits.map((h) => h.depositIndex)).toEqual([0]);
  });

  it("secret on each hit round-trips back through bigint", () => {
    const seed = randomSeed();
    const x = deriveOwnerSecret(seed, 0);
    const owned = makeOwnedEntry(x);
    const state = newScanState();
    const res = runIncrementalScan(state, {
      seed,
      entries: [owned],
      maxIndex: 32,
      minProbe: 8,
    });
    expect(res.hits).toHaveLength(1);
    const recovered = BigInt("0x" + res.hits[0]!.secretHex);
    expect(recovered).toBe(x);
    // And the hex matches what the SDK produces directly.
    const expectedHex = Array.from(scalarToBytes(x))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(res.hits[0]!.secretHex).toBe(expectedHex);
  });
});
