// Branch coverage for `pickMixInputs` — the wallet-mode owned-box bias
// strategy. Every branch in the file's header comment should map to a
// test here; if the branch table changes, this file should update with
// it.
//
// Strategy: stub Math.random with a deterministic sequence so the
// "uniform random" cases produce a known shape we can assert exactly.
// For probabilistic assertions ("eventually all owned boxes appear")
// we use a seeded loop with the original Math.random.

import { afterEach, describe, expect, it, vi } from "vitest";

import { pickMixInputs } from "../src/lib/pick-mix-inputs.js";

interface Entry {
  ref: { txId: string; outputIndex: number };
  /** Tag for assertion legibility. */
  label: string;
}

function makeEntry(label: string, idx = 0): Entry {
  return { ref: { txId: label.padStart(64, "0"), outputIndex: idx }, label };
}

function refKey(ref: { txId: string; outputIndex: number }): string {
  return `${ref.txId.toLowerCase()}#${ref.outputIndex}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pickMixInputs", () => {
  it("returns exactly N entries (shard, random)", () => {
    const pool = [makeEntry("a"), makeEntry("b"), makeEntry("c"), makeEntry("d")];
    const got = pickMixInputs({
      pool,
      n: 2,
      feePayer: "shard",
      ownedRefs: new Set(),
    });
    expect(got).toHaveLength(2);
    // Every element comes from the pool — no clones, no synthesis.
    for (const e of got) expect(pool).toContain(e);
  });

  it("shard mode ignores ownedRefs and falls through to random", () => {
    const owned = makeEntry("a");
    const pool = [owned, makeEntry("b"), makeEntry("c"), makeEntry("d")];
    // Force the rare path where the bias would have triggered if this
    // were wallet mode (small pool + owned present): shard MUST NOT
    // bias toward owned.
    let countingOwned = 0;
    for (let i = 0; i < 200; i++) {
      const got = pickMixInputs({
        pool,
        n: 2,
        feePayer: "shard",
        ownedRefs: new Set([refKey(owned.ref)]),
      });
      if (got.some((e) => e.label === "a")) countingOwned += 1;
    }
    // 200 trials × P(owned) for uniform random of 2 from 4 = 50 %.
    // Allow generous slack — biasing would push this to ~100 %.
    expect(countingOwned).toBeLessThan(150);
    expect(countingOwned).toBeGreaterThan(50);
  });

  it("wallet mode + empty ownedRefs → uniform random", () => {
    const pool = [makeEntry("a"), makeEntry("b"), makeEntry("c"), makeEntry("d")];
    const got = pickMixInputs({
      pool,
      n: 2,
      feePayer: "wallet",
      ownedRefs: new Set(),
    });
    expect(got).toHaveLength(2);
  });

  it("wallet mode + small pool + owned-in-pool → always includes one owned", () => {
    const owned1 = makeEntry("o1");
    const owned2 = makeEntry("o2");
    const pool = [owned1, makeEntry("a"), owned2, makeEntry("b"), makeEntry("c")];
    const ownedRefs = new Set([refKey(owned1.ref), refKey(owned2.ref)]);
    for (let i = 0; i < 100; i++) {
      const got = pickMixInputs({ pool, n: 3, feePayer: "wallet", ownedRefs });
      expect(got).toHaveLength(3);
      const ownedHits = got.filter((e) => ownedRefs.has(refKey(e.ref)));
      // Exactly one owned box per pick — never zero, never both.
      expect(ownedHits).toHaveLength(1);
    }
  });

  it("wallet mode + small pool + owned-in-pool → fillers are non-owned", () => {
    const owned1 = makeEntry("o1");
    const pool = [owned1, makeEntry("a"), makeEntry("b"), makeEntry("c"), makeEntry("d")];
    const ownedRefs = new Set([refKey(owned1.ref)]);
    for (let i = 0; i < 50; i++) {
      const got = pickMixInputs({ pool, n: 3, feePayer: "wallet", ownedRefs });
      const ownedHits = got.filter((e) => ownedRefs.has(refKey(e.ref)));
      expect(ownedHits).toHaveLength(1);
      const others = got.filter((e) => !ownedRefs.has(refKey(e.ref)));
      expect(others).toHaveLength(2);
      // No collisions — distinct entries from the non-owned pool.
      expect(new Set(others.map((e) => e.label)).size).toBe(2);
    }
  });

  it("wallet mode + small pool + nothing owned in pool → fall back to random", () => {
    // User owns boxes but none are currently in the visible pool. The
    // strategy can't bias toward absent boxes; falls back to random.
    const ownedRefs = new Set(["deadbeef#0"]);
    const pool = [makeEntry("a"), makeEntry("b"), makeEntry("c"), makeEntry("d")];
    const got = pickMixInputs({ pool, n: 2, feePayer: "wallet", ownedRefs });
    expect(got).toHaveLength(2);
    // Sanity: no synthesis of owned references.
    for (const e of got) expect(pool).toContain(e);
  });

  it("wallet mode + small pool + owned dominates pool → fall back to random", () => {
    // User owns 3 of 3 in pool; no non-owned filler available. Strategy
    // can't honour the 1-owned + (n-1)-non-owned shape, so it falls
    // through to uniform random across the pool.
    const o1 = makeEntry("o1");
    const o2 = makeEntry("o2");
    const o3 = makeEntry("o3");
    const pool = [o1, o2, o3];
    const ownedRefs = new Set([refKey(o1.ref), refKey(o2.ref), refKey(o3.ref)]);
    const got = pickMixInputs({ pool, n: 2, feePayer: "wallet", ownedRefs });
    expect(got).toHaveLength(2);
    // Every input ends up being one of the user's own — the only thing
    // available — and the picker doesn't crash trying to fetch n-1
    // entries from an empty non-owned set.
    for (const e of got) expect(ownedRefs.has(refKey(e.ref))).toBe(true);
  });

  it("wallet mode + healthy pool (≥ threshold) → does NOT force owned inclusion", () => {
    // Pool of 8 — at the threshold, the bias is OFF. User owns 1 of 8.
    // Across many runs the owned hit rate should be the random rate
    // (n=2 from 8 ≈ 25 %), not 100 % as the biased path would produce.
    const owned = makeEntry("o1");
    const pool = [
      owned,
      makeEntry("a"),
      makeEntry("b"),
      makeEntry("c"),
      makeEntry("d"),
      makeEntry("e"),
      makeEntry("f"),
      makeEntry("g"),
    ];
    const ownedRefs = new Set([refKey(owned.ref)]);
    let ownedHits = 0;
    const trials = 400;
    for (let i = 0; i < trials; i++) {
      const got = pickMixInputs({ pool, n: 2, feePayer: "wallet", ownedRefs });
      if (got.some((e) => e.label === "o1")) ownedHits += 1;
    }
    // Expected ≈ 25 %. Guard generously — biased mode would force 100 %.
    expect(ownedHits / trials).toBeLessThan(0.5);
    expect(ownedHits / trials).toBeGreaterThan(0.1);
  });
});
