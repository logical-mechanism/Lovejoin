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
    consumed,
    produced,
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
