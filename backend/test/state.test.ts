// Indexer state model: forward apply + rollback unwind.

import { describe, expect, it } from "vitest";

import { encodeMixDatumDef } from "./helpers/datum.js";
import { IndexerState, ROLLBACK_BUFFER_BLOCKS, DeepRollbackError } from "../src/indexer/state.js";
import type { BlockDiff, ProducedUtxo } from "../src/indexer/types.js";
import type { LovejoinAddresses } from "../src/config.js";

const MIX_ADDR = "addr_test1mix";
const FEE_ADDR = "addr_test1fee";
const NFT_UNIT = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" + "6c6f76656a6f696e";
const ADDRESSES: LovejoinAddresses = {
  network: "preprod",
  protocol: { denom_lovelace: 10_000_000, max_fee_per_mix_lovelace: 800_000 },
  referenceNftPolicy: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  referenceNftAssetName: "6c6f76656a6f696e",
  referenceUtxoRef: "00".repeat(32) + "#0",
  referenceHolderScriptHash: "ab".repeat(28),
  mixLogicScriptHash: "cd".repeat(28),
  mixBoxScriptHash: "ef".repeat(28),
  feeScriptHash: "12".repeat(28),
  feeShardUtxos: [],
};

function makeState(): IndexerState {
  return new IndexerState(
    ADDRESSES,
    {
      mixBoxAddress: MIX_ADDR,
      feeContractAddress: FEE_ADDR,
      referenceNftUnit: NFT_UNIT,
    },
    BigInt(ADDRESSES.protocol.max_fee_per_mix_lovelace),
  );
}

function mixBoxOutput(
  txId: string,
  index: number,
  a: number,
  b: number,
  lovelace = 10_000_000n,
): ProducedUtxo {
  return {
    ref: { txId, outputIndex: index },
    address: MIX_ADDR,
    lovelace,
    inlineDatumHex: encodeMixDatumDef(makeG1(a), makeG1(b)),
    assets: {},
  };
}

function feeOutput(txId: string, index: number, lovelace: bigint): ProducedUtxo {
  return {
    ref: { txId, outputIndex: index },
    address: FEE_ADDR,
    lovelace,
    inlineDatumHex: "d87980", // unit datum
    assets: {},
  };
}

function referenceOutput(txId: string, index: number): ProducedUtxo {
  return {
    ref: { txId, outputIndex: index },
    address: "addr_test1ref",
    lovelace: 5_000_000n,
    inlineDatumHex: null,
    assets: { [NFT_UNIT]: 1n },
  };
}

function makeG1(seed: number): Uint8Array {
  // 48-byte test vector — first byte distinct so a != b; the indexer
  // doesn't validate group membership.
  const out = new Uint8Array(48);
  out[0] = 0x80 | (seed & 0x7f);
  out[1] = seed & 0xff;
  return out;
}

function txHash(seed: string): string {
  // 64 hex chars deterministically derived from seed.
  let s = "";
  for (let i = 0; i < 32; i++)
    s += ((seed.charCodeAt(i % seed.length) + i) % 256).toString(16).padStart(2, "0");
  return s;
}

function block(
  height: number,
  consumed: { txId: string; outputIndex: number }[],
  produced: ProducedUtxo[],
): BlockDiff {
  return {
    slot: height * 20,
    blockHash: txHash(`block-${height}`),
    height,
    txs: [{ consumed, produced }],
  };
}

function blockWithTxs(
  height: number,
  txs: { consumed: { txId: string; outputIndex: number }[]; produced: ProducedUtxo[] }[],
): BlockDiff {
  return {
    slot: height * 20,
    blockHash: txHash(`block-${height}`),
    height,
    txs,
  };
}

describe("IndexerState forward apply", () => {
  it("adds a deposited mix-box to the pool", () => {
    const s = makeState();
    s.applyForward(block(1, [], [mixBoxOutput(txHash("d1"), 0, 1, 2)]));
    expect(s.poolSize()).toBe(1);
    const got = s.poolGet({ txId: txHash("d1"), outputIndex: 0 });
    expect(got).not.toBeNull();
    expect(got?.generation).toBe(0);
    expect(got?.a).toMatch(/^[0-9a-f]{96}$/);
  });

  it("ignores produced UTxOs at unrelated addresses", () => {
    const s = makeState();
    s.applyForward(
      block(
        1,
        [],
        [
          {
            ref: { txId: txHash("u"), outputIndex: 0 },
            address: "addr_test1unrelated",
            lovelace: 5_000_000n,
            inlineDatumHex: null,
            assets: {},
          },
        ],
      ),
    );
    expect(s.poolSize()).toBe(0);
    expect(s.feeSnapshot().shards.length).toBe(0);
  });

  it("ignores mix-box outputs with malformed datum", () => {
    const s = makeState();
    const malformed: ProducedUtxo = {
      ref: { txId: txHash("m"), outputIndex: 0 },
      address: MIX_ADDR,
      lovelace: 10_000_000n,
      inlineDatumHex: "ff", // invalid CBOR
      assets: {},
    };
    s.applyForward(block(1, [], [malformed]));
    expect(s.poolSize()).toBe(0);
  });

  it("removes consumed boxes and adds new ones in the same block (Mix tx)", () => {
    const s = makeState();
    s.applyForward(block(1, [], [mixBoxOutput(txHash("d1"), 0, 1, 2)]));
    s.applyForward(block(2, [], [mixBoxOutput(txHash("d2"), 0, 3, 4)]));
    expect(s.poolSize()).toBe(2);

    // A Mix tx that consumes both and produces two new boxes.
    s.applyForward(
      block(
        3,
        [
          { txId: txHash("d1"), outputIndex: 0 },
          { txId: txHash("d2"), outputIndex: 0 },
        ],
        [mixBoxOutput(txHash("m1"), 0, 5, 6), mixBoxOutput(txHash("m1"), 1, 7, 8)],
      ),
    );
    expect(s.poolSize()).toBe(2);
    const out0 = s.poolGet({ txId: txHash("m1"), outputIndex: 0 });
    expect(out0?.generation).toBe(1); // max(0,0) + 1
  });

  it("collapses chained Mix txs in the same block (intermediate output never leaks into pool)", () => {
    // Setup: three confirmed deposits that the chained Mixes will consume.
    const s = makeState();
    s.applyForward(
      block(
        1,
        [],
        [
          mixBoxOutput(txHash("d1"), 0, 1, 2),
          mixBoxOutput(txHash("d2"), 0, 3, 4),
          mixBoxOutput(txHash("d3"), 0, 5, 6),
        ],
      ),
    );
    expect(s.poolSize()).toBe(3);

    // Two chained Mix txs in the same block:
    //   Tx0: consume d1, d2  → produce m0
    //   Tx1: consume m0, d3  → produce m1
    // m0 must not survive in the pool. A block-level flattened apply
    // (the old behaviour) saw consumed = [d1, d2, m0, d3] / produced =
    // [m0, m1] and tried to remove m0 before m0 was added — leaving
    // m0 in the pool as a phantom box.
    s.applyForward(
      blockWithTxs(2, [
        {
          consumed: [
            { txId: txHash("d1"), outputIndex: 0 },
            { txId: txHash("d2"), outputIndex: 0 },
          ],
          produced: [mixBoxOutput(txHash("m0"), 0, 7, 8)],
        },
        {
          consumed: [
            { txId: txHash("m0"), outputIndex: 0 },
            { txId: txHash("d3"), outputIndex: 0 },
          ],
          produced: [mixBoxOutput(txHash("m1"), 0, 9, 10)],
        },
      ]),
    );

    expect(s.poolSize()).toBe(1);
    expect(s.poolGet({ txId: txHash("m0"), outputIndex: 0 })).toBeNull();
    const survivor = s.poolGet({ txId: txHash("m1"), outputIndex: 0 });
    expect(survivor).not.toBeNull();
    // Generation chains: d3 was gen 0, m0 was gen 1, so m1 is gen 2.
    expect(survivor?.generation).toBe(2);
  });

  it("rolls back chained Mix txs in the same block to the pre-block state", () => {
    const s = makeState();
    s.applyForward(
      block(
        1,
        [],
        [
          mixBoxOutput(txHash("d1"), 0, 1, 2),
          mixBoxOutput(txHash("d2"), 0, 3, 4),
          mixBoxOutput(txHash("d3"), 0, 5, 6),
        ],
      ),
    );
    const tipBefore = s.tip!;
    s.applyForward(
      blockWithTxs(2, [
        {
          consumed: [
            { txId: txHash("d1"), outputIndex: 0 },
            { txId: txHash("d2"), outputIndex: 0 },
          ],
          produced: [mixBoxOutput(txHash("m0"), 0, 7, 8)],
        },
        {
          consumed: [
            { txId: txHash("m0"), outputIndex: 0 },
            { txId: txHash("d3"), outputIndex: 0 },
          ],
          produced: [mixBoxOutput(txHash("m1"), 0, 9, 10)],
        },
      ]),
    );

    s.applyRollback(tipBefore);
    expect(s.poolSize()).toBe(3);
    expect(s.poolGet({ txId: txHash("d1"), outputIndex: 0 })).not.toBeNull();
    expect(s.poolGet({ txId: txHash("d2"), outputIndex: 0 })).not.toBeNull();
    expect(s.poolGet({ txId: txHash("d3"), outputIndex: 0 })).not.toBeNull();
    expect(s.poolGet({ txId: txHash("m0"), outputIndex: 0 })).toBeNull();
    expect(s.poolGet({ txId: txHash("m1"), outputIndex: 0 })).toBeNull();
  });

  it("tracks fee shards: add, decrement, add new", () => {
    const s = makeState();
    s.applyForward(block(1, [], [feeOutput(txHash("f1"), 0, 5_000_000n)]));
    s.applyForward(block(2, [], [feeOutput(txHash("f2"), 0, 3_000_000n)]));
    expect(s.feeSnapshot().shards).toHaveLength(2);
    expect(s.feeSnapshot().totalLovelace).toBe(8_000_000n);

    // PayMixFee: consume f1, produce f1' with lower balance.
    s.applyForward(
      block(3, [{ txId: txHash("f1"), outputIndex: 0 }], [feeOutput(txHash("p1"), 0, 4_500_000n)]),
    );
    expect(s.feeSnapshot().shards).toHaveLength(2);
    expect(s.feeSnapshot().totalLovelace).toBe(7_500_000n);
    expect(s.feeSnapshot().estimatedMixesAvailable).toBe(Math.floor(7_500_000 / 800_000));
  });

  it("registers reference UTxO when the NFT-bearing output appears", () => {
    const s = makeState();
    s.applyForward(block(1, [], [referenceOutput(txHash("r1"), 0)]));
    expect(s.snapshot().referenceUtxoOk).toBe(true);
    expect(s.referenceUtxoRef()).toEqual({ txId: txHash("r1"), outputIndex: 0 });
  });

  it("raises alarm if reference UTxO is consumed without re-creation", () => {
    const s = makeState();
    s.applyForward(block(1, [], [referenceOutput(txHash("r1"), 0)]));
    expect(s.alarm()).toBeNull();
    s.applyForward(block(2, [{ txId: txHash("r1"), outputIndex: 0 }], []));
    expect(s.alarm()).toMatch(/reference UTxO/);
    expect(s.snapshot().referenceUtxoOk).toBe(false);
  });

  it("clears alarm if NFT reappears in the same diff (rollback case)", () => {
    const s = makeState();
    s.applyForward(block(1, [], [referenceOutput(txHash("r1"), 0)]));
    s.applyForward(
      block(2, [{ txId: txHash("r1"), outputIndex: 0 }], [referenceOutput(txHash("r2"), 0)]),
    );
    expect(s.alarm()).toBeNull();
    expect(s.referenceUtxoRef()).toEqual({ txId: txHash("r2"), outputIndex: 0 });
  });
});

describe("IndexerState rollback", () => {
  it("unwinds a single block", () => {
    const s = makeState();
    s.applyForward(block(1, [], [mixBoxOutput(txHash("d1"), 0, 1, 2)]));
    const tip1 = s.tip!;
    s.applyForward(block(2, [], [mixBoxOutput(txHash("d2"), 0, 3, 4)]));
    expect(s.poolSize()).toBe(2);
    s.applyRollback(tip1);
    expect(s.poolSize()).toBe(1);
    expect(s.tip).toEqual(tip1);
  });

  it("unwinds 500 blocks", () => {
    const s = makeState();
    s.applyForward(block(0, [], [])); // genesis-ish anchor
    const anchor = s.tip!;
    for (let h = 1; h <= 500; h++) {
      s.applyForward(
        block(h, [], [mixBoxOutput(txHash(`d-${h}`), 0, (h % 200) + 1, ((h + 100) % 200) + 1)]),
      );
    }
    expect(s.poolSize()).toBe(500);
    s.applyRollback(anchor);
    expect(s.poolSize()).toBe(0);
    expect(s.tip).toEqual(anchor);
  });

  it("restores fee shards on rollback of a PayMixFee", () => {
    const s = makeState();
    s.applyForward(block(1, [], [feeOutput(txHash("f1"), 0, 5_000_000n)]));
    const tip1 = s.tip!;
    s.applyForward(
      block(2, [{ txId: txHash("f1"), outputIndex: 0 }], [feeOutput(txHash("p1"), 0, 4_200_000n)]),
    );
    expect(s.feeSnapshot().totalLovelace).toBe(4_200_000n);
    s.applyRollback(tip1);
    expect(s.feeSnapshot().totalLovelace).toBe(5_000_000n);
    expect(s.feeSnapshot().shards.map((sh) => sh.txHash)).toEqual([txHash("f1")]);
  });

  it("restores reference UTxO on rollback after consumption", () => {
    const s = makeState();
    s.applyForward(block(1, [], [referenceOutput(txHash("r1"), 0)]));
    const tip1 = s.tip!;
    s.applyForward(block(2, [{ txId: txHash("r1"), outputIndex: 0 }], []));
    expect(s.referenceUtxoRef()).toBeNull();
    s.applyRollback(tip1);
    expect(s.referenceUtxoRef()).toEqual({ txId: txHash("r1"), outputIndex: 0 });
    expect(s.alarm()).toBeNull();
  });

  it("throws DeepRollbackError when target is older than buffer", () => {
    const s = makeState();
    // Apply a few blocks so the tip is set.
    for (let h = 0; h < 10; h++) s.applyForward(block(h, [], []));
    // Now apply ROLLBACK_BUFFER_BLOCKS more. The first 10 are evicted.
    for (let h = 10; h < 10 + ROLLBACK_BUFFER_BLOCKS + 5; h++) {
      s.applyForward(block(h, [], []));
    }
    // Trying to rollback to height 0 should fail.
    const ancient = {
      slot: 0,
      blockHash: txHash("block-0"),
      height: 0,
    };
    expect(() => s.applyRollback(ancient)).toThrow(DeepRollbackError);
  });

  it("buffer never exceeds ROLLBACK_BUFFER_BLOCKS", () => {
    const s = makeState();
    for (let h = 0; h < ROLLBACK_BUFFER_BLOCKS + 100; h++) {
      s.applyForward(block(h, [], []));
    }
    expect(s.bufferDepth()).toBe(ROLLBACK_BUFFER_BLOCKS);
  });
});

describe("IndexerState.primeFrom (cold-start prime path, issue #87)", () => {
  it("seeds pool / fee shards / reference UTxO from a snapshot", () => {
    const s = makeState();
    const tip = { slot: 1234, blockHash: txHash("primed-block"), height: 56 };
    s.primeFrom({
      tip,
      mixBoxUtxos: [mixBoxOutput(txHash("p1"), 0, 11, 22), mixBoxOutput(txHash("p2"), 0, 33, 44)],
      feeShardUtxos: [feeOutput(txHash("ps1"), 0, 7_000_000n)],
      referenceUtxo: referenceOutput(txHash("pref"), 0),
    });
    expect(s.tip).toEqual(tip);
    expect(s.poolSize()).toBe(2);
    expect(s.feeSnapshot().shards).toHaveLength(1);
    expect(s.feeSnapshot().totalLovelace).toBe(7_000_000n);
    expect(s.referenceUtxoRef()).toEqual({ txId: txHash("pref"), outputIndex: 0 });
    expect(s.alarm()).toBeNull();
    // Generation is dropped by prime — privacy budget restarts from 0.
    const got = s.poolGet({ txId: txHash("p1"), outputIndex: 0 });
    expect(got?.generation).toBe(0);
  });

  it("clears prior state and rollback buffer on prime", () => {
    const s = makeState();
    // Build up some history.
    s.applyForward(block(1, [], [mixBoxOutput(txHash("d1"), 0, 1, 2)]));
    s.applyForward(block(2, [], [feeOutput(txHash("f1"), 0, 3_000_000n)]));
    expect(s.poolSize()).toBe(1);
    expect(s.bufferDepth()).toBe(2);
    // Prime to a totally different snapshot.
    const tip = { slot: 5000, blockHash: txHash("primed-replace"), height: 250 };
    s.primeFrom({
      tip,
      mixBoxUtxos: [mixBoxOutput(txHash("new"), 0, 99, 88)],
      feeShardUtxos: [],
      referenceUtxo: referenceOutput(txHash("newref"), 0),
    });
    expect(s.tip).toEqual(tip);
    expect(s.poolSize()).toBe(1);
    expect(s.poolGet({ txId: txHash("d1"), outputIndex: 0 })).toBeNull();
    expect(s.poolGet({ txId: txHash("new"), outputIndex: 0 })).not.toBeNull();
    expect(s.feeSnapshot().shards).toHaveLength(0);
    // Buffer is empty after prime — any rollback to a pre-prime point
    // must surface DeepRollbackError so the runtime triggers a fresh
    // reprime instead of trying to unwind diffs that don't exist.
    expect(s.bufferDepth()).toBe(0);
  });

  it("raises alarm when the reference NFT is missing from the snapshot", () => {
    const s = makeState();
    s.primeFrom({
      tip: { slot: 100, blockHash: txHash("nrf"), height: 5 },
      mixBoxUtxos: [],
      feeShardUtxos: [],
      referenceUtxo: null,
    });
    expect(s.alarm()).toMatch(/reference NFT not observable/);
    expect(s.snapshot().referenceUtxoOk).toBe(false);
  });

  it("clears a prior alarm when a fresh prime supplies the reference UTxO", () => {
    const s = makeState();
    // First prime with no reference: alarm raised.
    s.primeFrom({
      tip: { slot: 100, blockHash: txHash("nrf2"), height: 5 },
      mixBoxUtxos: [],
      feeShardUtxos: [],
      referenceUtxo: null,
    });
    expect(s.alarm()).not.toBeNull();
    // Second prime brings the reference back: alarm clears.
    s.primeFrom({
      tip: { slot: 200, blockHash: txHash("nrf3"), height: 10 },
      mixBoxUtxos: [],
      feeShardUtxos: [],
      referenceUtxo: referenceOutput(txHash("backref"), 0),
    });
    expect(s.alarm()).toBeNull();
    expect(s.referenceUtxoRef()).toEqual({ txId: txHash("backref"), outputIndex: 0 });
  });

  it("any rollback to a pre-prime tip throws DeepRollbackError", () => {
    const s = makeState();
    s.primeFrom({
      tip: { slot: 1000, blockHash: txHash("primed-rb"), height: 50 },
      mixBoxUtxos: [],
      feeShardUtxos: [],
      referenceUtxo: referenceOutput(txHash("rbref"), 0),
    });
    // Add some forward blocks so the buffer has something to unwind.
    for (let h = 51; h < 55; h++) s.applyForward(block(h, [], []));
    // Rollback to before the prime tip cannot be served from the buffer.
    expect(() => s.applyRollback({ slot: 500, blockHash: txHash("ancient"), height: 25 })).toThrow(
      DeepRollbackError,
    );
  });
});
