// Unit tests for tx/fee.ts.
//
// We isolate selection logic from chain access by passing in synthetic Utxo
// arrays. The injected RandomInt makes tests deterministic without weakening
// the production-default rejection-sampling RNG.

import { describe, expect, it } from "vitest";

import type { Utxo } from "../../src/chain/provider.js";
import {
  cryptoRandomInt,
  isFeeShardCandidate,
  listFeeShards,
  pickRandomShard,
  replenishOutputLovelace,
  shardCountSanity,
} from "../../src/tx/fee.js";

const FEE_ADDR = "addr_test1wpmlrr7a06nrtvzdusnfheygmjepf2zd45uuj4dnq4mfdvc6c5n78";

function utxo(opts: {
  txId: string;
  idx?: number;
  address?: string;
  lovelace?: bigint;
  inlineDatum?: string | null;
  assets?: Record<string, bigint>;
}): Utxo {
  return {
    ref: { txId: opts.txId, outputIndex: opts.idx ?? 0 },
    address: opts.address ?? FEE_ADDR,
    lovelace: opts.lovelace ?? 5_000_000n,
    assets: opts.assets ?? {},
    inlineDatum: opts.inlineDatum === undefined ? "d87980" : opts.inlineDatum,
    referenceScript: null,
  };
}

describe("tx/fee — isFeeShardCandidate", () => {
  it("accepts a unit-datum UTxO at the fee address", () => {
    expect(isFeeShardCandidate(utxo({ txId: "a".repeat(64) }), FEE_ADDR)).toBe(true);
  });

  it("rejects UTxOs at other addresses", () => {
    const u = utxo({ txId: "a".repeat(64), address: "addr_test1qsomethingelse" });
    expect(isFeeShardCandidate(u, FEE_ADDR)).toBe(false);
  });

  it("rejects UTxOs without an inline datum", () => {
    const u = utxo({ txId: "a".repeat(64), inlineDatum: null });
    expect(isFeeShardCandidate(u, FEE_ADDR)).toBe(false);
  });

  it("rejects UTxOs with a non-unit inline datum", () => {
    const u = utxo({ txId: "a".repeat(64), inlineDatum: "d87a80" }); // Constr 1 [], not unit
    expect(isFeeShardCandidate(u, FEE_ADDR)).toBe(false);
  });

  it("rejects UTxOs carrying native assets", () => {
    const u = utxo({
      txId: "a".repeat(64),
      assets: { ["abcd1234".padEnd(64, "0")]: 1n },
    });
    expect(isFeeShardCandidate(u, FEE_ADDR)).toBe(false);
  });

  it("accepts upper-case datum hex (case-insensitive)", () => {
    const u = utxo({ txId: "a".repeat(64), inlineDatum: "D87980" });
    expect(isFeeShardCandidate(u, FEE_ADDR)).toBe(true);
  });
});

describe("tx/fee — listFeeShards", () => {
  it("returns only legitimate shards", async () => {
    const all: Utxo[] = [
      utxo({ txId: "a".repeat(64), idx: 0 }),
      utxo({ txId: "b".repeat(64), idx: 0, inlineDatum: null }),
      utxo({ txId: "c".repeat(64), idx: 0, assets: { fff: 1n } }),
      utxo({ txId: "d".repeat(64), idx: 0 }),
    ];
    const provider = makeProvider(FEE_ADDR, all);
    const shards = await listFeeShards({ provider, feeScriptAddressBech32: FEE_ADDR });
    expect(shards.map((s) => s.ref.txId)).toEqual(["a".repeat(64), "d".repeat(64)]);
  });

  it("throws when no shards exist", async () => {
    const provider = makeProvider(FEE_ADDR, []);
    await expect(
      listFeeShards({ provider, feeScriptAddressBech32: FEE_ADDR }),
    ).rejects.toThrow(/no fee shards/);
  });
});

describe("tx/fee — pickRandomShard", () => {
  const shards: Utxo[] = [
    utxo({ txId: "1".repeat(64), idx: 0 }),
    utxo({ txId: "2".repeat(64), idx: 0 }),
    utxo({ txId: "3".repeat(64), idx: 0 }),
  ];

  it("delegates to the injected RNG", () => {
    const picked = pickRandomShard({ shards, rng: () => 1 });
    expect(picked.ref.txId).toBe("2".repeat(64));
  });

  it("excludes refs the caller already used", () => {
    const exclude = [{ txId: "1".repeat(64), outputIndex: 0 }];
    const picked = pickRandomShard({ shards, excludeRefs: exclude, rng: () => 0 });
    // After excluding "1...", index 0 of the eligible list is "2...".
    expect(picked.ref.txId).toBe("2".repeat(64));
  });

  it("falls back to the full set if excludeRefs eliminates everything", () => {
    const exclude = shards.map((s) => s.ref);
    const picked = pickRandomShard({ shards, excludeRefs: exclude, rng: () => 0 });
    expect(picked.ref.txId).toBe("1".repeat(64));
  });

  it("throws on an empty shard list", () => {
    expect(() => pickRandomShard({ shards: [] })).toThrow(/empty/);
  });

  it("uniform sample over many draws", () => {
    // 30k draws across 3 shards: each bucket should land in [9000, 11000].
    const counts = [0, 0, 0];
    for (let i = 0; i < 30_000; i++) {
      const picked = pickRandomShard({ shards });
      const idx = shards.findIndex((s) => s.ref.txId === picked.ref.txId);
      counts[idx]! += 1;
    }
    for (const c of counts) {
      expect(c).toBeGreaterThan(9_000);
      expect(c).toBeLessThan(11_000);
    }
  });
});

describe("tx/fee — cryptoRandomInt", () => {
  it("returns values in [0, n)", () => {
    for (let n = 1; n <= 16; n++) {
      for (let i = 0; i < 100; i++) {
        const v = cryptoRandomInt(n);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(n);
      }
    }
  });

  it("rejects bad inputs", () => {
    expect(() => cryptoRandomInt(0)).toThrow();
    expect(() => cryptoRandomInt(-1)).toThrow();
    expect(() => cryptoRandomInt(1.5)).toThrow();
    expect(() => cryptoRandomInt(2 ** 31)).toThrow();
  });
});

describe("tx/fee — replenishOutputLovelace", () => {
  const params = { maxFeePerMixLovelace: 800_000n };

  it("adds rounds × max_fee to the existing shard balance", () => {
    const shard = utxo({ txId: "x".repeat(64), lovelace: 5_000_000n });
    const out = replenishOutputLovelace({ shard, rounds: 30, params });
    expect(out).toBe(5_000_000n + 30n * 800_000n);
  });

  it("rejects non-positive rounds", () => {
    const shard = utxo({ txId: "x".repeat(64) });
    expect(() => replenishOutputLovelace({ shard, rounds: 0, params })).toThrow(/positive/);
    expect(() => replenishOutputLovelace({ shard, rounds: -1, params })).toThrow(/positive/);
  });

  it("enforces minRounds when set", () => {
    const shard = utxo({ txId: "x".repeat(64) });
    expect(() =>
      replenishOutputLovelace({ shard, rounds: 3, params, minRounds: 5 }),
    ).toThrow(/below minRounds/);
  });
});

describe("tx/fee — shardCountSanity", () => {
  it("reports healthy when actual >= bootstrapped", () => {
    const shards = [utxo({ txId: "a".repeat(64) })];
    const addresses = { feeShardUtxos: ["x".repeat(64) + "#0"] };
    expect(shardCountSanity({ shards, addresses })).toEqual({
      actual: 1,
      bootstrapped: 1,
      healthy: true,
    });
  });

  it("reports unhealthy when shards have been depleted", () => {
    const addresses = { feeShardUtxos: ["x#0", "y#0"] };
    expect(shardCountSanity({ shards: [], addresses }).healthy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeProvider(addr: string, utxos: Utxo[]) {
  return {
    submitTx: async () => "deadbeef",
    getUtxos: async (a: string) => (a === addr ? utxos : []),
    getUtxoByRef: async () => null,
    awaitConfirmation: async () => undefined,
    getReferenceUtxo: async () => {
      throw new Error("not implemented in fakeProvider");
    },
    getProtocolParameters: async () => ({} as never),
  };
}
