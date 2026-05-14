// Unit tests for strategy/fanout.ts.
//
// Pure-logic tests: tree shape correctness across depths 2..4, no-reuse
// of pool refs within a single plan, exclude-set enforcement, descendant
// walk for rollback cascade, and helper math.

import { describe, expect, it } from "vitest";

import {
  FANOUT_MAX_DEPTH,
  FANOUT_N,
  fanoutBoxesTouched,
  fanoutDescendants,
  fanoutLinkageProbability,
  fanoutTotalMixes,
  getSlot,
  planFanout,
  type FanoutSlotId,
} from "../../src/strategy/fanout.js";
import type { PoolEntry } from "../../src/pool/identify.js";
import type { Utxo } from "../../src/chain/provider.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntry(idx: number): PoolEntry {
  const u: Utxo = {
    ref: { txId: idx.toString(16).padStart(64, "0"), outputIndex: 0 },
    address: "addr_test1zr_fixture",
    lovelace: 10_000_000n,
    assets: {},
    inlineDatum: null,
    referenceScript: null,
  };
  const a = new Uint8Array(48);
  const b = new Uint8Array(48);
  a[0] = idx & 0xff;
  a[1] = (idx >>> 8) & 0xff;
  b[0] = ((idx >>> 1) + 1) & 0xff;
  return { ref: u.ref, a, b, utxo: u };
}

/** Deterministic RNG — returns 0 for every draw. Combined with partial
 *  Fisher-Yates this yields a stable, prefix-of-pool sample. */
const zeroRng = (_n: number) => 0;

// ---------------------------------------------------------------------------
// Planner shape
// ---------------------------------------------------------------------------

describe("planFanout — tree shape", () => {
  it("rejects depth < 2", () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 10 }, (_, i) => makeEntry(i + 1));
    expect(() => planFanout({ rootBox: root, pool, depth: 1, rng: zeroRng })).toThrow(
      /depth must be in \[2, 4\]/,
    );
  });

  it("rejects depth > FANOUT_MAX_DEPTH", () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 200 }, (_, i) => makeEntry(i + 1));
    expect(() =>
      planFanout({ rootBox: root, pool, depth: FANOUT_MAX_DEPTH + 1, rng: zeroRng }),
    ).toThrow(/depth must be in \[2, 4\]/);
  });

  it("rejects non-integer depth", () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 10 }, (_, i) => makeEntry(i + 1));
    expect(() => planFanout({ rootBox: root, pool, depth: 2.5, rng: zeroRng })).toThrow(
      /depth must be an integer/,
    );
  });

  it.each([
    [2, 4, 8, 9],
    [3, 13, 26, 27],
    [4, 40, 80, 81],
  ])(
    "depth=%i has correct slot counts, fresh draws and box counts",
    (depth, expectedTotalMixes, expectedFresh, expectedBoxesTouched) => {
      const root = makeEntry(0);
      // Pool must be large enough for the deepest test.
      const pool = Array.from({ length: 200 }, (_, i) => makeEntry(i + 1));
      const plan = planFanout({ rootBox: root, pool, depth, rng: zeroRng });

      expect(plan.depth).toBe(depth);
      expect(plan.n).toBe(FANOUT_N);
      expect(plan.waves).toHaveLength(depth);

      let total = 0;
      for (let k = 0; k < depth; k++) {
        const expected = Math.pow(FANOUT_N, k);
        expect(plan.waves[k]!.slots).toHaveLength(expected);
        total += expected;
      }
      expect(total).toBe(expectedTotalMixes);
      expect(plan.totalMixes).toBe(expectedTotalMixes);
      // boxesTouched is 3^depth (each leaf slot touches N=3 boxes; the
      // tree's effective "anonymity set" is 3^depth).
      expect(plan.boxesTouched).toBe(expectedBoxesTouched);
      // fresh draws = 2 × per-wave-slot-count, summed.
      expect(plan.poolRefsUsed).toHaveLength(expectedFresh);
    },
  );

  it("wave 0 slot 0 has root + 2 fresh", () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 10 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 2, rng: zeroRng });
    const w0s0 = plan.waves[0]!.slots[0]!;
    expect(w0s0.id).toBe("w0s0");
    expect(w0s0.inputs).toHaveLength(FANOUT_N);
    expect(w0s0.inputs[0]!.kind).toBe("root");
    expect(w0s0.inputs[1]!.kind).toBe("pool");
    expect(w0s0.inputs[2]!.kind).toBe("pool");
  });

  it("wave 1 slot s parents to wave 0 slot floor(s/N), output position s % N", () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 20 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 2, rng: zeroRng });
    for (let s = 0; s < FANOUT_N; s++) {
      const slot = plan.waves[1]!.slots[s]!;
      const parent = slot.inputs[0]!;
      expect(parent.kind).toBe("parent");
      if (parent.kind === "parent") {
        expect(parent.parentSlotId).toBe("w0s0");
        expect(parent.parentOutputPosition).toBe(s);
      }
    }
  });

  it("wave 2 slot mapping: 9 slots in 3 sibling-groups of 3", () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 100 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 3, rng: zeroRng });
    expect(plan.waves[2]!.slots).toHaveLength(9);
    // Verify each wave-2 slot is parented to the right wave-1 slot.
    for (let s = 0; s < 9; s++) {
      const slot = plan.waves[2]!.slots[s]!;
      const expectedParent: FanoutSlotId = `w1s${Math.floor(s / FANOUT_N)}`;
      const parent = slot.inputs[0]!;
      expect(parent.kind).toBe("parent");
      if (parent.kind === "parent") {
        expect(parent.parentSlotId).toBe(expectedParent);
        expect(parent.parentOutputPosition).toBe(s % FANOUT_N);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Pool sampling
// ---------------------------------------------------------------------------

describe("planFanout — pool sampling", () => {
  it("no pool ref is reused across slots in a single plan", () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 200 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 4, rng: zeroRng });
    const seen = new Set<string>();
    for (const wave of plan.waves) {
      for (const slot of wave.slots) {
        for (const inp of slot.inputs) {
          if (inp.kind !== "pool") continue;
          const key = `${inp.entry.ref.txId}#${inp.entry.ref.outputIndex}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      }
    }
    // 27 + 81 + 27 + 9 + 3 ... wait: for depth 4, fresh = 2 + 6 + 18 + 54 = 80
    expect(seen.size).toBe(80);
  });

  it("pool refs used never include the root box", () => {
    const root = makeEntry(0);
    const pool = [root, ...Array.from({ length: 50 }, (_, i) => makeEntry(i + 1))];
    const plan = planFanout({ rootBox: root, pool, depth: 3, rng: zeroRng });
    const rootKey = `${root.ref.txId}#${root.ref.outputIndex}`;
    for (const r of plan.poolRefsUsed) {
      const k = `${r.txId}#${r.outputIndex}`;
      expect(k).not.toBe(rootKey);
    }
  });

  it("respects excludeRefs from the caller", () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 50 }, (_, i) => makeEntry(i + 1));
    const excluded = [pool[5]!.ref, pool[10]!.ref, pool[15]!.ref];
    const plan = planFanout({
      rootBox: root,
      pool,
      depth: 2,
      excludeRefs: excluded,
      rng: zeroRng,
    });
    const usedKeys = new Set(plan.poolRefsUsed.map((r) => `${r.txId}#${r.outputIndex}`));
    for (const e of excluded) {
      expect(usedKeys.has(`${e.txId}#${e.outputIndex}`)).toBe(false);
    }
  });

  it("throws when the eligible pool can't supply enough fresh boxes", () => {
    const root = makeEntry(0);
    // For depth=3 we need 26 fresh boxes (2 + 6 + 18). Give it 10.
    const pool = Array.from({ length: 10 }, (_, i) => makeEntry(i + 1));
    expect(() => planFanout({ rootBox: root, pool, depth: 3, rng: zeroRng })).toThrow(
      /pool has 10 fresh boxes after exclusions, need 26/,
    );
  });

  it("treats excludeRefs as part of the unavailable set when checking pool size", () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 9 }, (_, i) => makeEntry(i + 1));
    // 9 entries, but exclude 2 → 7 effective. depth=2 needs 8 fresh boxes (2 + 6).
    const excluded = [pool[0]!.ref, pool[1]!.ref];
    expect(() =>
      planFanout({ rootBox: root, pool, depth: 2, excludeRefs: excluded, rng: zeroRng }),
    ).toThrow(/pool has 7 fresh boxes after exclusions, need 8/);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("getSlot", () => {
  it("returns the slot at the given id", () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 50 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 3, rng: zeroRng });
    expect(getSlot(plan, "w0s0").id).toBe("w0s0");
    expect(getSlot(plan, "w2s8").id).toBe("w2s8");
  });

  it("throws on out-of-range ids", () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 50 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 2, rng: zeroRng });
    expect(() => getSlot(plan, "w5s0")).toThrow(/wave 5 out of range/);
    expect(() => getSlot(plan, "w1s9")).toThrow(/slot 9 out of range/);
  });
});

describe("fanoutDescendants", () => {
  it("rolls up the full subtree of a slot in BFS order", () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 100 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 3, rng: zeroRng });
    // Root slot drops the entire tree.
    const dropped = fanoutDescendants(plan, "w0s0");
    // All 1 + 3 + 9 = 13 slots.
    expect(dropped).toHaveLength(13);
    expect(dropped[0]).toBe("w0s0");
    // BFS: wave 1 children before wave 2 children.
    const w1Children = dropped.slice(1, 4);
    expect(w1Children).toEqual(["w1s0", "w1s1", "w1s2"]);
  });

  it("a wave-1 slot drops only its 3 wave-2 children", () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 100 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 3, rng: zeroRng });
    // w1s1's wave-2 children are w2s3, w2s4, w2s5 (slot index 3,4,5 since
    // parent index = floor(s/3) → s ∈ {3,4,5} maps to parent 1).
    const dropped = fanoutDescendants(plan, "w1s1");
    expect(dropped).toEqual(["w1s1", "w2s3", "w2s4", "w2s5"]);
  });

  it("a leaf slot drops only itself", () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 100 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 3, rng: zeroRng });
    expect(fanoutDescendants(plan, "w2s5")).toEqual(["w2s5"]);
  });
});

describe("helper math", () => {
  it.each([
    [1, 1 / 3],
    [2, 1 / 9],
    [3, 1 / 27],
    [4, 1 / 81],
  ])("fanoutLinkageProbability(%i) = %f (default n=3)", (k, expected) => {
    expect(fanoutLinkageProbability(k)).toBeCloseTo(expected, 10);
  });

  it.each([
    [1, 1],
    [2, 4],
    [3, 13],
    [4, 40],
  ])("fanoutTotalMixes(%i) = (3^%i - 1) / 2 = %i (default n=3)", (k, expected) => {
    expect(fanoutTotalMixes(k)).toBe(expected);
  });

  it.each([
    [1, 3],
    [2, 9],
    [3, 27],
    [4, 81],
  ])("fanoutBoxesTouched(%i) = 3^%i = %i (default n=3)", (k, expected) => {
    expect(fanoutBoxesTouched(k)).toBe(expected);
  });

  // Wallet-mode fan-out at n=4 (issue #149 follow-up): pool size,
  // linkage, and tx count all bump with the wider branching factor.
  it.each([
    [2, 1 / 16],
    [3, 1 / 64],
    [4, 1 / 256],
  ])("fanoutLinkageProbability(%i, 4) = %f", (k, expected) => {
    expect(fanoutLinkageProbability(k, 4)).toBeCloseTo(expected, 10);
  });

  it.each([
    [2, 5], // (16 - 1) / 3
    [3, 21], // (64 - 1) / 3
    [4, 85], // (256 - 1) / 3
  ])("fanoutTotalMixes(%i, 4) = %i", (k, expected) => {
    expect(fanoutTotalMixes(k, 4)).toBe(expected);
  });

  it.each([
    [2, 16],
    [3, 64],
    [4, 256],
  ])("fanoutBoxesTouched(%i, 4) = %i", (k, expected) => {
    expect(fanoutBoxesTouched(k, 4)).toBe(expected);
  });
});

describe("planFanout — n=4 (wallet-mode width)", () => {
  it("emits 4-input slots and the n=4 tree shape at depth 2", () => {
    // Each slot consumes (parent or root) + 3 fresh = 4 inputs total.
    // Wave 0: 1 slot × 3 fresh = 3 fresh. Wave 1: 4 slots × 3 fresh = 12 fresh.
    // Pool requirement = 15; total mixes = 5; boxes touched = 16.
    const root = makeEntry(0);
    const pool = Array.from({ length: 50 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 2, n: 4, rng: zeroRng });
    expect(plan.n).toBe(4);
    expect(plan.totalMixes).toBe(5);
    expect(plan.boxesTouched).toBe(16);
    expect(plan.poolRefsUsed).toHaveLength(15);
    expect(plan.waves).toHaveLength(2);
    expect(plan.waves[0]!.slots).toHaveLength(1);
    expect(plan.waves[1]!.slots).toHaveLength(4);
    for (const wave of plan.waves) {
      for (const slot of wave.slots) {
        expect(slot.inputs).toHaveLength(4);
      }
    }
    // Wave 1's slot 3's parent must be w0s0, output position 3.
    const w1s3 = plan.waves[1]!.slots[3]!;
    const parent = w1s3.inputs.find((i) => i.kind === "parent");
    expect(parent?.kind).toBe("parent");
    if (parent?.kind === "parent") {
      expect(parent.parentSlotId).toBe("w0s0");
      expect(parent.parentOutputPosition).toBe(3);
    }
  });

  it("rejects n outside [2, FANOUT_MAX_N]", () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 50 }, (_, i) => makeEntry(i + 1));
    expect(() => planFanout({ rootBox: root, pool, depth: 2, n: 1, rng: zeroRng })).toThrow(
      /n must be an integer in/,
    );
    expect(() => planFanout({ rootBox: root, pool, depth: 2, n: 5, rng: zeroRng })).toThrow(
      /n must be an integer in/,
    );
  });

  it("falls back to n=3 (FANOUT_N) when n is omitted", () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 50 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 2, rng: zeroRng });
    expect(plan.n).toBe(FANOUT_N);
    for (const wave of plan.waves) {
      for (const slot of wave.slots) {
        expect(slot.inputs).toHaveLength(FANOUT_N);
      }
    }
  });
});
