// Unit tests for pool/select.ts.
//
// `pickRandomNTuple` and `randomPermutation` are RNG-dependent — we drive
// them with deterministic counter RNGs so tests are reproducible. The
// "uniform without replacement" property is verified two ways: (1) every
// element is distinct; (2) `pickRandomNTuple(pool, n=pool.size)` returns
// a permutation of the pool.

import { describe, expect, it } from "vitest";

import {
  inversePermutation,
  pickRandomNTuple,
  randomPermutation,
} from "../../src/pool/select.js";
import type { PoolEntry } from "../../src/pool/identify.js";
import type { Utxo } from "../../src/chain/provider.js";

function makeEntry(idx: number): PoolEntry {
  const u: Utxo = {
    ref: { txId: idx.toString(16).padStart(64, "0"), outputIndex: 0 },
    address: "addr_test1zr6st458sf8czp2nayx9wqgqg9hd58lmqyguda3e7csdju8repagljh249nrlmgvxhfah6mvyq6sg2xkmgnzcjpsqzckqz3ahz5",
    lovelace: 10_000_000n,
    assets: {},
    inlineDatum: null,
    referenceScript: null,
  };
  // Distinct a/b per entry — content doesn't matter for selection tests.
  const a = new Uint8Array(48);
  const b = new Uint8Array(48);
  a[0] = idx & 0xff;
  b[0] = (idx >>> 1) & 0xff;
  return { ref: u.ref, a, b, utxo: u };
}

/** Counter RNG — deterministic, returns a sequence we can predict. */
function counterRng(): { rng: (n: number) => number; calls: number[] } {
  const calls: number[] = [];
  let i = 0;
  return {
    rng: (n: number) => {
      const v = i++ % n;
      calls.push(v);
      return v;
    },
    calls,
  };
}

describe("pool/select — pickRandomNTuple", () => {
  it("returns n distinct entries from the pool", () => {
    const pool = Array.from({ length: 10 }, (_, i) => makeEntry(i));
    const { rng } = counterRng();
    const picked = pickRandomNTuple({ pool, n: 4, rng });
    expect(picked).toHaveLength(4);
    const refs = new Set(picked.map((p) => p.ref.txId));
    expect(refs.size).toBe(4);
  });

  it("clamps n to the eligible pool size", () => {
    const pool = Array.from({ length: 3 }, (_, i) => makeEntry(i));
    const { rng } = counterRng();
    const picked = pickRandomNTuple({ pool, n: 10, rng });
    expect(picked).toHaveLength(3);
    expect(new Set(picked.map((p) => p.ref.txId)).size).toBe(3);
  });

  it("returns [] when pool is empty", () => {
    const { rng } = counterRng();
    expect(pickRandomNTuple({ pool: [], n: 5, rng })).toEqual([]);
  });

  it("excludes refs the caller flags", () => {
    const pool = Array.from({ length: 5 }, (_, i) => makeEntry(i));
    const blocked = pool[2]!.ref;
    const { rng } = counterRng();
    const picked = pickRandomNTuple({
      pool,
      n: 5,
      excludeRefs: [blocked],
      rng,
    });
    expect(picked).toHaveLength(4);
    expect(picked.map((p) => p.ref.txId)).not.toContain(blocked.txId);
  });

  it("rejects negative n", () => {
    expect(() => pickRandomNTuple({ pool: [], n: -1 })).toThrow();
  });

  it("returns a permutation when n equals the pool size", () => {
    const pool = Array.from({ length: 6 }, (_, i) => makeEntry(i));
    const { rng } = counterRng();
    const picked = pickRandomNTuple({ pool, n: 6, rng });
    const pickedRefs = new Set(picked.map((p) => p.ref.txId));
    const poolRefs = new Set(pool.map((p) => p.ref.txId));
    expect(pickedRefs).toEqual(poolRefs);
  });
});

describe("pool/select — randomPermutation", () => {
  it("returns a valid permutation of [0, n)", () => {
    const { rng } = counterRng();
    const p = randomPermutation(8, rng);
    expect(p).toHaveLength(8);
    expect(new Set(p)).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]));
  });

  it("returns [] for n == 0", () => {
    expect(randomPermutation(0)).toEqual([]);
  });

  it("rejects negative n", () => {
    expect(() => randomPermutation(-1)).toThrow();
  });
});

describe("pool/select — inversePermutation", () => {
  it("inverts identity to identity", () => {
    expect(inversePermutation([0, 1, 2, 3])).toEqual([0, 1, 2, 3]);
  });

  it("inverts a known permutation", () => {
    // p = [2, 0, 1] → input 0 → output 2, input 1 → output 0, input 2 → output 1.
    // inv[2] = 0, inv[0] = 1, inv[1] = 2 → [1, 2, 0].
    expect(inversePermutation([2, 0, 1])).toEqual([1, 2, 0]);
  });

  it("rejects out-of-range entries", () => {
    expect(() => inversePermutation([0, 5])).toThrow();
  });

  it("rejects duplicate entries", () => {
    expect(() => inversePermutation([0, 0])).toThrow();
  });
});
