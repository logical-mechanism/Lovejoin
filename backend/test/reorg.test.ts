// Reorg recovery test.
//
// Spec exit criterion: "Recovery test demonstrates 500-block rollback
// recovery". We seed an IndexerState with a known anchor, apply 500
// blocks of mixed deposit / mix / fee / reference activity, capture a
// reference snapshot for comparison, then roll back to the anchor and
// re-apply the same 500 blocks. The post-rollback / post-replay state
// must be byte-identical to the original.
//
// We also verify that a deep rollback (older than the 2k buffer) raises
// the typed error so the supervisor can react.

import { describe, expect, it } from "vitest";

import { IndexerState, ROLLBACK_BUFFER_BLOCKS, DeepRollbackError } from "../src/indexer/state.js";
import type { BlockDiff, ProducedUtxo } from "../src/indexer/types.js";
import { utxoKey } from "../src/indexer/types.js";
import type { LovejoinAddresses } from "../src/config.js";
import { encodeMixDatumDef } from "./helpers/datum.js";

const MIX_ADDR = "addr_test1mix";
const FEE_ADDR = "addr_test1fee";
const NFT_POLICY = "deadbeef".repeat(7);
const NFT_NAME = "6c6f76656a6f696e";
const NFT_UNIT = NFT_POLICY + NFT_NAME;

const ADDRESSES: LovejoinAddresses = {
  network: "preprod",
  protocol: { denom_lovelace: 10_000_000, max_fee_per_mix_lovelace: 800_000 },
  referenceNftPolicy: NFT_POLICY,
  referenceNftAssetName: NFT_NAME,
  referenceUtxoRef: "00".repeat(32) + "#0",
  referenceHolderScriptHash: "ab".repeat(28),
  mixLogicScriptHash: "cd".repeat(28),
  mixBoxScriptHash: "ef".repeat(28),
  feeScriptHash: "12".repeat(28),
  feeShardUtxos: [],
};

const FILTER = {
  mixBoxAddress: MIX_ADDR,
  feeContractAddress: FEE_ADDR,
  referenceNftUnit: NFT_UNIT,
};
const MAX_FEE = BigInt(ADDRESSES.protocol.max_fee_per_mix_lovelace);

function bytes48(seed: number): Uint8Array {
  const out = new Uint8Array(48);
  for (let i = 0; i < 48; i++) out[i] = (seed * 7 + i) & 0xff;
  return out;
}

function txHashFor(seed: number): string {
  // Encode the seed at byte 0..3, leaving 28 zero bytes — guaranteed
  // collision-free up to 2^31 unique values, far above what the
  // scenarios use.
  const seedHex = (seed >>> 0).toString(16).padStart(8, "0");
  return seedHex + "00".repeat(28);
}

function mixBoxOutput(seed: number, txIdSeed: number, idx: number): ProducedUtxo {
  return {
    ref: { txId: txHashFor(txIdSeed), outputIndex: idx },
    address: MIX_ADDR,
    lovelace: 10_000_000n,
    inlineDatumHex: encodeMixDatumDef(bytes48(seed * 2 + 1), bytes48(seed * 2 + 2)),
    assets: {},
  };
}

function feeOutput(txIdSeed: number, lovelace: bigint, idx = 0): ProducedUtxo {
  return {
    ref: { txId: txHashFor(txIdSeed), outputIndex: idx },
    address: FEE_ADDR,
    lovelace,
    inlineDatumHex: "d87980",
    assets: {},
  };
}

function referenceOutput(txIdSeed: number): ProducedUtxo {
  return {
    ref: { txId: txHashFor(txIdSeed), outputIndex: 0 },
    address: "addr_test1ref",
    lovelace: 5_000_000n,
    inlineDatumHex: null,
    assets: { [NFT_UNIT]: 1n },
  };
}

/**
 * Generate a sequence of 500 blocks. Each block carries one of:
 * deposit, mix (consume + produce), fee Replenish, fee PayMixFee, or
 * a quiet block. The pattern cycles deterministically so the state at
 * the end is fully reproducible.
 */
function generateScenario(seedOffset: number): BlockDiff[] {
  const blocks: BlockDiff[] = [];
  // Anchor block: produce one fee shard + the reference UTxO so the
  // later mixes have something to spend / consume.
  blocks.push({
    slot: seedOffset,
    blockHash: txHashFor(10_000 + seedOffset),
    height: seedOffset + 1,
    consumed: [],
    produced: [feeOutput(20_000 + seedOffset, 50_000_000n), referenceOutput(30_000 + seedOffset)],
  });
  let lastFeeSeed = 20_000 + seedOffset;
  let feeBalance = 50_000_000n;
  let depositCount = 0;
  // Track recent deposits so we can mix them.
  const liveBoxes: { txIdSeed: number; idx: number }[] = [];

  for (let i = 0; i < 500; i++) {
    const slot = (seedOffset + i + 1) * 20;
    const height = seedOffset + i + 2;
    const blockHash = txHashFor(40_000 + seedOffset + i);
    const op = i % 5;
    if (op === 0 || op === 1 || liveBoxes.length < 2) {
      // Deposit
      const seed = 1_000_000 + i + seedOffset;
      const txIdSeed = 50_000 + seedOffset + i;
      blocks.push({
        slot,
        blockHash,
        height,
        consumed: [],
        produced: [mixBoxOutput(seed, txIdSeed, 0)],
      });
      liveBoxes.push({ txIdSeed, idx: 0 });
      depositCount += 1;
    } else if (op === 2 && liveBoxes.length >= 2) {
      // Mix two existing boxes → two new boxes
      const a = liveBoxes.shift()!;
      const b = liveBoxes.shift()!;
      const txIdSeed = 60_000 + seedOffset + i;
      const seedA = 2_000_000 + i + seedOffset;
      const seedB = 2_000_001 + i + seedOffset;
      blocks.push({
        slot,
        blockHash,
        height,
        consumed: [
          { txId: txHashFor(a.txIdSeed), outputIndex: a.idx },
          { txId: txHashFor(b.txIdSeed), outputIndex: b.idx },
        ],
        produced: [mixBoxOutput(seedA, txIdSeed, 0), mixBoxOutput(seedB, txIdSeed, 1)],
      });
      liveBoxes.push({ txIdSeed, idx: 0 }, { txIdSeed, idx: 1 });
    } else if (op === 3) {
      // Replenish: spend fee shard, produce richer one
      const newSeed = 70_000 + seedOffset + i;
      feeBalance += 1_000_000n;
      blocks.push({
        slot,
        blockHash,
        height,
        consumed: [{ txId: txHashFor(lastFeeSeed), outputIndex: 0 }],
        produced: [feeOutput(newSeed, feeBalance)],
      });
      lastFeeSeed = newSeed;
    } else {
      // PayMixFee: spend fee shard, produce slightly poorer one
      const newSeed = 80_000 + seedOffset + i;
      const cost = 200_000n;
      feeBalance -= cost;
      blocks.push({
        slot,
        blockHash,
        height,
        consumed: [{ txId: txHashFor(lastFeeSeed), outputIndex: 0 }],
        produced: [feeOutput(newSeed, feeBalance)],
      });
      lastFeeSeed = newSeed;
    }
  }
  // Sanity: scenario should produce a non-empty pool + a fee shard.
  if (depositCount === 0) throw new Error("scenario: no deposits emitted");
  return blocks;
}

function fingerprint(state: IndexerState): {
  poolSize: number;
  poolKeys: string[];
  feeKeys: string[];
  feeTotal: string;
  referenceUtxoOk: boolean;
  alarm: string | null;
  tip: string | null;
} {
  return {
    poolSize: state.poolSize(),
    poolKeys: state
      .pool_()
      .map((b) => `${b.txHash}#${b.outputIndex}|${b.a}|${b.b}|${b.generation}`)
      .sort(),
    feeKeys: state
      .feeSnapshot()
      .shards.map((s) => `${utxoKey({ txId: s.txHash, outputIndex: s.outputIndex })}|${s.lovelace}`)
      .sort(),
    feeTotal: state.feeSnapshot().totalLovelace.toString(),
    referenceUtxoOk: state.snapshot().referenceUtxoOk,
    alarm: state.alarm(),
    tip: state.tip ? `${state.tip.height}|${state.tip.blockHash}` : null,
  };
}

describe("reorg: 500-block rollback recovery", () => {
  it("restores byte-identical state after rollback + replay", () => {
    const scenario = generateScenario(0);
    expect(scenario.length).toBe(501); // anchor + 500 blocks

    const state = new IndexerState(ADDRESSES, FILTER, MAX_FEE);
    state.applyForward(scenario[0]!);
    const anchorTip = state.tip!;

    // Apply all 500 simulated blocks.
    for (let i = 1; i < scenario.length; i++) {
      state.applyForward(scenario[i]!);
    }
    const before = fingerprint(state);
    expect(before.poolSize).toBeGreaterThan(0);

    // Roll back to the anchor.
    state.applyRollback(anchorTip);
    expect(state.tip).toEqual(anchorTip);
    // After rollback we should only have the anchor's contributions:
    // 1 fee shard + 1 reference UTxO. No pool entries.
    expect(state.poolSize()).toBe(0);
    expect(state.feeSnapshot().shards).toHaveLength(1);
    expect(state.snapshot().referenceUtxoOk).toBe(true);

    // Replay the same 500 blocks and verify the fingerprint matches.
    for (let i = 1; i < scenario.length; i++) {
      state.applyForward(scenario[i]!);
    }
    const after = fingerprint(state);
    expect(after).toEqual(before);
  });

  it(`raises DeepRollbackError when target is older than ${ROLLBACK_BUFFER_BLOCKS}-block buffer`, () => {
    const state = new IndexerState(ADDRESSES, FILTER, MAX_FEE);
    // Apply enough blocks to evict the earliest from the buffer.
    for (let h = 0; h < ROLLBACK_BUFFER_BLOCKS + 100; h++) {
      state.applyForward({
        slot: h * 20,
        blockHash: txHashFor(h),
        height: h + 1,
        consumed: [],
        produced: [],
      });
    }
    const ancient = { slot: 0, blockHash: txHashFor(0), height: 1 };
    expect(() => state.applyRollback(ancient)).toThrow(DeepRollbackError);
  });
});
