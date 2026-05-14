// Unit tests for strategy/orchestrator.ts.
//
// We don't drive a real `buildMixTx` here — that path is exercised by the
// Preprod integration tests. The orchestrator's wave-by-wave logic is
// exercised against an injected stub: each "build" call returns a canned
// `MixResult` whose plan outputs use deterministic txids so the child
// slots can resolve their parent inputs without touching the chain.

import { describe, expect, it } from "vitest";

import {
  collectFanoutResults,
  materialiseSlotInputs,
  planFanoutTxs,
  submitFanout,
  submitFanoutBatch,
  type FanoutEvent,
  type UnsignedFanoutBatch,
} from "../../src/strategy/orchestrator.js";
import { planFanout, type FanoutSlot } from "../../src/strategy/fanout.js";
import type { LovejoinWallet } from "../../src/wallet/cip30.js";
import type { BuildMixArgs, MixOutputPlan, MixPlan, MixResult } from "../../src/tx/mix.js";
import type { LovejoinAddresses } from "../../src/tx/params.js";
import type { ChainProvider, Utxo, UtxoRef } from "../../src/chain/provider.js";
import type { PoolEntry } from "../../src/pool/identify.js";
import { buildScriptAddress } from "../../src/tx/address.js";
import { FEE_UNIT_DATUM_CBOR_HEX } from "../../src/tx/mix.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ADDRESSES: LovejoinAddresses = {
  network: "preprod",
  protocol: { denom_lovelace: 10_000_000, max_fee_per_mix_lovelace: 800_000 },
  referenceNftPolicy: "310d0d4ff25e73a4a0442eac873e68810e11c824aa0e858acc56f1df",
  referenceNftAssetName: "6c6f76656a6f696e",
  referenceUtxoRef: "b809b4e363067886174b57fd04101eb2e59f654220b6c11530c77b75f25ec945#0",
  referenceHolderScriptHash: "b58b5869a956266f5a55265829963064cabfeac4dab3c28f46dbc1cc",
  mixLogicScriptHash: "ca2d95fe9fe368e8ad1c89e2009a5ad292ff016e353144ea0ef829ff",
  mixBoxScriptHash: "ba176a7604f3e062a7ed315780801495ed0ffb0191c6f8e7d88362e2",
  feeScriptHash: "5efd8fdd7e4d35b04de427337220dcb30352136d739055b305dd2d66",
  feeShardUtxos: ["34a117d9699e8537529aa093943cdeda6f525fd167a74e6f1bd9229ef805a080#0"],
  referenceScriptUtxos: {
    mix_box: "b51692abb805409936944691abd324f2dcdd025749b9094dbd49939588c7e27f#0",
    mix_logic: "d65e2a074a45c6f24b42fe60924d8e35cb26412985d98480a4e96b5b89a2a727#0",
    fee_contract: "5d9a9e2c26aeffcddb0d0f6e4cc07b62df546a8615bd5bd2aca673561e3600b6#0",
  },
};

const MIX_BOX_ADDRESS = buildScriptAddress(ADDRESSES.mixBoxScriptHash, 0);
const FEE_ADDRESS = buildScriptAddress(ADDRESSES.feeScriptHash, 0);

const NULL_PROVIDER = {} as ChainProvider;
const zeroRng = (_n: number) => 0;

function makeEntry(idx: number): PoolEntry {
  const u: Utxo = {
    ref: { txId: idx.toString(16).padStart(64, "0"), outputIndex: 0 },
    address: MIX_BOX_ADDRESS,
    lovelace: 10_000_000n,
    assets: {},
    inlineDatum: null,
    referenceScript: null,
  };
  const a = new Uint8Array(48);
  const b = new Uint8Array(48);
  a[0] = (idx + 1) & 0xff;
  b[0] = (idx + 100) & 0xff;
  return { ref: u.ref, a, b, utxo: u };
}

/** Build a canned `MixResult` for the stubbed buildMixTx. The mix
 *  output (a', b') byte values encode `(slotId, position)` so the
 *  orchestrator's chain-from splice can be inspected. */
function stubMixResult(slotIdLabel: string, n: number, feeShardIn: Utxo | null): MixResult {
  const txId = stubTxId(slotIdLabel);
  const outputs: MixOutputPlan[] = [];
  for (let i = 0; i < n; i++) {
    const a = new Uint8Array(48);
    const b = new Uint8Array(48);
    a[0] = i;
    b[0] = i + 0x80;
    // Pad slot label into bytes 1..4 so collisions across slots are
    // impossible.
    for (let j = 0; j < Math.min(slotIdLabel.length, 4); j++) {
      a[j + 1] = slotIdLabel.charCodeAt(j);
      b[j + 1] = slotIdLabel.charCodeAt(j);
    }
    outputs.push({ a, b, inlineDatumHex: `d8799f5830${"00".repeat(48)}5830${"00".repeat(48)}ff` });
  }
  const txFee = 750_000n;
  const plan: MixPlan = {
    inputs: [],
    inputToOutput: outputs.map((_, i) => i),
    outputs,
    proofs: [],
    mixRedeemerCborHex: "d87a80",
    mixBoxAddressBech32: MIX_BOX_ADDRESS,
    feePayer: "shard",
    feeShardInput: feeShardIn,
    feeShardOutput: feeShardIn
      ? {
          addressBech32: FEE_ADDRESS,
          lovelace: feeShardIn.lovelace - txFee,
          inlineDatumHex: FEE_UNIT_DATUM_CBOR_HEX,
        }
      : null,
    payMixFeeRedeemerCborHex: feeShardIn ? "d87980" : null,
    referenceUtxoRef: {
      txId: "b809b4e363067886174b57fd04101eb2e59f654220b6c11530c77b75f25ec945",
      outputIndex: 0,
    },
    mixBoxRefScriptUtxoRef: {
      txId: "b51692abb805409936944691abd324f2dcdd025749b9094dbd49939588c7e27f",
      outputIndex: 0,
    },
    mixLogicRefScriptUtxoRef: {
      txId: "d65e2a074a45c6f24b42fe60924d8e35cb26412985d98480a4e96b5b89a2a727",
      outputIndex: 0,
    },
    feeContractRefScriptUtxoRef: {
      txId: "5d9a9e2c26aeffcddb0d0f6e4cc07b62df546a8615bd5bd2aca673561e3600b6",
      outputIndex: 0,
    },
    mixLogicRewardAddressBech32: "stake_test1_fixture",
    txFeeLovelace: txFee,
    n,
  };
  return {
    signedTxHex: "00",
    unsignedTxHex: "00",
    txId,
    plan,
    actualFeeLovelace: txFee,
  };
}

function stubTxId(label: string): string {
  // 32 hex bytes = 64 chars. We pad the label into the head.
  return (label + "_")
    .padEnd(64, "0")
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, "a");
}

function makeMeshUtxo(txHash: string, outputIndex: number, address: string, lovelace: bigint) {
  return {
    input: { txHash, outputIndex },
    output: {
      address,
      amount: [{ unit: "lovelace", quantity: lovelace.toString() }],
    },
  };
}

function feeShardUtxo(label: string, lovelace = 5_000_000n): Utxo {
  return {
    ref: { txId: stubTxId(label), outputIndex: 0 },
    address: FEE_ADDRESS,
    lovelace,
    assets: {},
    inlineDatum: FEE_UNIT_DATUM_CBOR_HEX,
    referenceScript: null,
  };
}

// ---------------------------------------------------------------------------
// materialiseSlotInputs
// ---------------------------------------------------------------------------

describe("materialiseSlotInputs", () => {
  it("returns root + 2 fresh pool entries for wave-0 slot-0", () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 20 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 2, rng: zeroRng });
    const w0s0 = plan.waves[0]!.slots[0]! as FanoutSlot;
    const inputs = materialiseSlotInputs({
      slot: w0s0,
      plan,
      parentResults: new Map(),
      denomLovelace: 10_000_000n,
      mixBoxAddressBech32: MIX_BOX_ADDRESS,
    });
    expect(inputs).toHaveLength(3);
    expect(inputs[0]!.ref.txId).toBe(root.ref.txId);
    expect(inputs[1]!.ref).not.toBe(root.ref);
    expect(inputs[2]!.ref).not.toBe(root.ref);
  });

  it("resolves a wave-1 slot's parent input from the parent's MixResult", () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 20 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 2, rng: zeroRng });
    const parentResult = stubMixResult("w0s0", 3, feeShardUtxo("w0s0fee"));
    const parents = new Map([["w0s0" as const, parentResult]]);
    const w1s1 = plan.waves[1]!.slots[1]!;
    const inputs = materialiseSlotInputs({
      slot: w1s1,
      plan,
      parentResults: parents,
      denomLovelace: 10_000_000n,
      mixBoxAddressBech32: MIX_BOX_ADDRESS,
    });
    expect(inputs).toHaveLength(3);
    // First input is the parent's output at position 1 (slot 1 % N = 1).
    expect(inputs[0]!.ref.txId).toBe(parentResult.txId);
    expect(inputs[0]!.ref.outputIndex).toBe(1);
    // a' / b' came from parent's plan outputs at position 1.
    expect(inputs[0]!.a).toEqual(parentResult.plan.outputs[1]!.a);
    expect(inputs[0]!.b).toEqual(parentResult.plan.outputs[1]!.b);
  });

  it("throws when a wave-1 slot's parent hasn't been submitted yet", () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 20 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 2, rng: zeroRng });
    const w1s0 = plan.waves[1]!.slots[0]!;
    expect(() =>
      materialiseSlotInputs({
        slot: w1s0,
        plan,
        parentResults: new Map(),
        denomLovelace: 10_000_000n,
        mixBoxAddressBech32: MIX_BOX_ADDRESS,
      }),
    ).toThrow(/parent w0s0 of slot w1s0 not submitted yet/);
  });
});

// ---------------------------------------------------------------------------
// submitFanout end-to-end via a stubbed builder
// ---------------------------------------------------------------------------

describe("submitFanout", () => {
  it("yields wave-started + slot-submitted + wave-completed + plan-completed for a depth-2 plan", async () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 30 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 2, rng: zeroRng });

    const callLog: string[] = [];
    const buildMix = async (args: BuildMixArgs): Promise<MixResult> => {
      // The first input's ref encodes the slot — for wave-0 it's the
      // root's ref; for wave-1 it's the previous slot's output txid.
      // Synthesise a unique label from the call index.
      const label = `s${callLog.length}`;
      callLog.push(label);
      const feeIn = feeShardUtxo(`${label}_fee`, 5_000_000n);
      return stubMixResult(label, args.inputs.length, feeIn);
    };

    const events: FanoutEvent[] = [];
    for await (const evt of submitFanout({
      plan,
      network: "preprod",
      provider: NULL_PROVIDER,
      addresses: ADDRESSES,
      buildMix,
    })) {
      events.push(evt);
    }

    const kinds = events.map((e) => e.kind);
    // Two waves: 1 + 3 slot submissions.
    expect(kinds.filter((k) => k === "wave-started")).toHaveLength(2);
    expect(kinds.filter((k) => k === "slot-submitted")).toHaveLength(4);
    expect(kinds.filter((k) => k === "slot-failed")).toHaveLength(0);
    expect(kinds.filter((k) => k === "wave-completed")).toHaveLength(2);
    expect(kinds.filter((k) => k === "plan-completed")).toHaveLength(1);
    const planCompleted = events.at(-1)!;
    if (planCompleted.kind === "plan-completed") {
      expect(planCompleted.submittedSlots).toBe(4);
      expect(planCompleted.failedSlots).toBe(0);
    }
  });

  it("forwards previous-wave mix outputs as chainFrom.utxos to subsequent slots", async () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 30 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 2, rng: zeroRng });

    const chainFromBySlot: number[] = [];
    let n = 0;
    const buildMix = async (args: BuildMixArgs): Promise<MixResult> => {
      chainFromBySlot.push(args.chainFrom?.utxos?.length ?? 0);
      const label = `s${n++}`;
      return stubMixResult(label, args.inputs.length, feeShardUtxo(`${label}_fee`));
    };

    for await (const _evt of submitFanout({
      plan,
      network: "preprod",
      provider: NULL_PROVIDER,
      addresses: ADDRESSES,
      buildMix,
    })) {
      // drain
    }
    // First wave gets no in-flight chain-from input.
    expect(chainFromBySlot[0]).toBe(0);
    // Wave 1's first slot sees its direct parent's 3 mix outputs +
    // 1 fee-shard post-state from wave 0 → 4 chain-from entries.
    expect(chainFromBySlot[1]).toBeGreaterThanOrEqual(4);
  });

  it("chainFrom stays bounded by direct parent + fee-shard extras (not accumulated tree)", async () => {
    // Without per-slot pruning, a depth-3 run would grow chainFrom by 4
    // entries per submitted slot — wave-2 leaves would see 4 (wave-0) +
    // 12 (wave-1) + 8..32 (earlier wave-2 siblings) = 24..48 entries,
    // blowing past the backend's 32-entry additionalUtxoSet cap.
    //
    // With pruning, every slot sees only its direct parent's 4 outputs
    // + the current in-flight fee-shard set (≤13 at depth 3). Worst
    // case = 4 + 13 = 17 entries.
    const root = makeEntry(0);
    const pool = Array.from({ length: 100 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 3, rng: zeroRng });

    const chainFromBySlot: number[] = [];
    let n = 0;
    const buildMix = async (args: BuildMixArgs): Promise<MixResult> => {
      chainFromBySlot.push(args.chainFrom?.utxos?.length ?? 0);
      const label = `s${n++}`;
      return stubMixResult(label, args.inputs.length, feeShardUtxo(`${label}_fee`));
    };

    for await (const _evt of submitFanout({
      plan,
      network: "preprod",
      provider: NULL_PROVIDER,
      addresses: ADDRESSES,
      buildMix,
    })) {
      // drain
    }
    // 1 + 3 + 9 = 13 slot builds.
    expect(chainFromBySlot).toHaveLength(13);
    // No slot's chainFrom exceeds the backend's 32-entry cap. Tight
    // assertion: 20 leaves comfortable headroom and would catch any
    // regression where chainFrom starts accumulating again.
    for (const count of chainFromBySlot) {
      expect(count).toBeLessThanOrEqual(20);
    }
  });

  it("forwards args.feePayer to every slot's build (issue #147 wallet-funded fan-out)", async () => {
    // Default is "shard"; an explicit "wallet" must reach every leaf so
    // the wallet branch in mix.ts kicks in for the entire tree, not
    // just the root. Without this the orchestrator would silently
    // submit wallet-anonymous shard txs even when the user asked for
    // wallet-funded fan-out.
    const root = makeEntry(0);
    const pool = Array.from({ length: 30 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 2, rng: zeroRng });

    const seenFeePayer: string[] = [];
    let n = 0;
    const buildMix = async (args: BuildMixArgs): Promise<MixResult> => {
      seenFeePayer.push(args.feePayer ?? "(unset)");
      const label = `s${n++}`;
      return stubMixResult(label, args.inputs.length, feeShardUtxo(`${label}_fee`));
    };

    for await (const _evt of submitFanout({
      plan,
      network: "preprod",
      provider: NULL_PROVIDER,
      addresses: ADDRESSES,
      feePayer: "wallet",
      buildMix,
    })) {
      // drain
    }
    expect(seenFeePayer).toHaveLength(4); // 1 + 3 slots at depth 2.
    for (const fp of seenFeePayer) expect(fp).toBe("wallet");
  });

  it("defaults to feePayer=shard when args.feePayer is omitted", async () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 30 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 2, rng: zeroRng });

    const seenFeePayer: string[] = [];
    let n = 0;
    const buildMix = async (args: BuildMixArgs): Promise<MixResult> => {
      seenFeePayer.push(args.feePayer ?? "(unset)");
      const label = `s${n++}`;
      return stubMixResult(label, args.inputs.length, feeShardUtxo(`${label}_fee`));
    };

    for await (const _evt of submitFanout({
      plan,
      network: "preprod",
      provider: NULL_PROVIDER,
      addresses: ADDRESSES,
      buildMix,
    })) {
      // drain
    }
    for (const fp of seenFeePayer) expect(fp).toBe("shard");
  });

  it("excludes consumed fee shards from future picks via excludeFeeShardRefs", async () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 30 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 2, rng: zeroRng });

    const excludeByCall: ReadonlyArray<UtxoRef>[] = [];
    let n = 0;
    const buildMix = async (args: BuildMixArgs): Promise<MixResult> => {
      excludeByCall.push(args.excludeFeeShardRefs ?? []);
      const label = `s${n++}`;
      return stubMixResult(label, args.inputs.length, feeShardUtxo(`${label}_fee`));
    };

    for await (const _evt of submitFanout({
      plan,
      network: "preprod",
      provider: NULL_PROVIDER,
      addresses: ADDRESSES,
      buildMix,
    })) {
      // drain
    }
    // First call has no excludes.
    expect(excludeByCall[0]).toEqual([]);
    // Second call's excludes carry the first call's fee shard.
    expect(excludeByCall[1]!.length).toBeGreaterThanOrEqual(1);
  });

  it("marks descendants as dropped when a slot fails, and emits a single slot-failed per failure", async () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 30 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 2, rng: zeroRng });

    let n = 0;
    const buildMix = async (args: BuildMixArgs): Promise<MixResult> => {
      const label = `s${n++}`;
      if (label === "s0") {
        // Wave 0 fails → all 3 wave-1 slots are unreachable.
        throw new Error("simulated wave-0 failure");
      }
      return stubMixResult(label, args.inputs.length, feeShardUtxo(`${label}_fee`));
    };

    const events: FanoutEvent[] = [];
    for await (const evt of submitFanout({
      plan,
      network: "preprod",
      provider: NULL_PROVIDER,
      addresses: ADDRESSES,
      buildMix,
    })) {
      events.push(evt);
    }
    const failures = events.filter((e) => e.kind === "slot-failed");
    expect(failures).toHaveLength(1);
    if (failures[0]?.kind === "slot-failed") {
      expect(failures[0].slotId).toBe("w0s0");
      // Descendants = self + 3 wave-1 children.
      expect(failures[0].droppedDescendants).toEqual(["w0s0", "w1s0", "w1s1", "w1s2"]);
    }
    // No wave-1 slot-submitted events because all 3 were dropped.
    expect(events.filter((e) => e.kind === "slot-submitted")).toHaveLength(0);
  });

  it("partial failure: a single wave-1 slot failure does not affect siblings", async () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 50 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 3, rng: zeroRng });

    let n = 0;
    const buildMix = async (args: BuildMixArgs): Promise<MixResult> => {
      const label = `s${n++}`;
      if (label === "s2") {
        // 3rd call = wave-1 slot index 1 (call 0 = w0s0, calls 1..3 =
        // w1s0..w1s2). Fail it. Its 3 wave-2 descendants drop; siblings'
        // descendants still run.
        throw new Error("simulated w1s1 failure");
      }
      return stubMixResult(label, args.inputs.length, feeShardUtxo(`${label}_fee`));
    };

    const summary = await collectFanoutResults(
      submitFanout({
        plan,
        network: "preprod",
        provider: NULL_PROVIDER,
        addresses: ADDRESSES,
        buildMix,
      }),
    );

    expect(summary.failedSlots.size).toBe(1);
    expect(summary.failedSlots.has("w1s1")).toBe(true);
    // Dropped = w1s1 + its 3 wave-2 children.
    expect(summary.droppedSlots).toEqual(new Set(["w1s1", "w2s3", "w2s4", "w2s5"]));
    // Total submitted = (1 + 3 + 9) - 4 dropped = 9.
    expect(summary.submittedSlots.size).toBe(9);
    expect(summary.completed?.failedSlots).toBe(4);
    expect(summary.completed?.submittedSlots).toBe(9);
  });

  it("collects events from a clean depth-3 run into a typed summary", async () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 100 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 3, rng: zeroRng });
    let n = 0;
    const buildMix = async (args: BuildMixArgs): Promise<MixResult> => {
      const label = `s${n++}`;
      return stubMixResult(label, args.inputs.length, feeShardUtxo(`${label}_fee`));
    };
    const summary = await collectFanoutResults(
      submitFanout({
        plan,
        network: "preprod",
        provider: NULL_PROVIDER,
        addresses: ADDRESSES,
        buildMix,
      }),
    );
    expect(summary.failedSlots.size).toBe(0);
    expect(summary.droppedSlots.size).toBe(0);
    expect(summary.submittedSlots.size).toBe(13);
    expect(summary.completed).toEqual({ submittedSlots: 13, failedSlots: 0 });
  });

  it("threads ySecretsBySlot + permutationsBySlot through to buildMix", async () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 30 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 2, rng: zeroRng });
    const ySeen: ReadonlyArray<bigint>[] = [];
    const pSeen: ReadonlyArray<number>[] = [];
    let n = 0;
    const buildMix = async (args: BuildMixArgs): Promise<MixResult> => {
      if (args.ySecrets) ySeen.push([...args.ySecrets]);
      if (args.permutation) pSeen.push([...args.permutation]);
      const label = `s${n++}`;
      return stubMixResult(label, args.inputs.length, feeShardUtxo(`${label}_fee`));
    };
    const ySecretsBySlot = new Map<`w${number}s${number}`, bigint[]>([
      ["w0s0", [11n, 22n, 33n]],
      ["w1s0", [44n, 55n, 66n]],
    ]);
    const permutationsBySlot = new Map<`w${number}s${number}`, number[]>([
      ["w0s0", [2, 0, 1]],
      ["w1s2", [0, 1, 2]],
    ]);
    for await (const _evt of submitFanout({
      plan,
      network: "preprod",
      provider: NULL_PROVIDER,
      addresses: ADDRESSES,
      buildMix,
      ySecretsBySlot,
      permutationsBySlot,
    })) {
      // drain
    }
    // Exactly the slots we provided overrides for see them.
    expect(ySeen).toContainEqual([11n, 22n, 33n]);
    expect(ySeen).toContainEqual([44n, 55n, 66n]);
    expect(pSeen).toContainEqual([2, 0, 1]);
    expect(pSeen).toContainEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// planFanoutTxs + submitFanoutBatch — issue #149 batch-sign path
// ---------------------------------------------------------------------------

function stubUnsignedMixResult(slotIdLabel: string, n: number, feeShardIn: Utxo | null): MixResult {
  // Same as stubMixResult but with empty signedTxHex + a distinguishable
  // unsigned CBOR. Mirrors what buildMixTx returns when buildOnly is true.
  const base = stubMixResult(slotIdLabel, n, feeShardIn);
  return {
    signedTxHex: "",
    unsignedTxHex: `un_${slotIdLabel}_${n}`,
    txId: base.txId,
    plan: base.plan,
    actualFeeLovelace: base.actualFeeLovelace,
  };
}

describe("planFanoutTxs", () => {
  it("builds every slot in submission order without invoking the wallet", async () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 30 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 2, rng: zeroRng });

    let buildCalls = 0;
    const buildMix = async (args: BuildMixArgs): Promise<MixResult> => {
      // Every leaf must arrive in buildOnly mode — that's the whole
      // point of the planner step. A regression that forgets to flip
      // it would silently sign N times instead of zero.
      expect(args.buildOnly).toBe(true);
      const label = `s${buildCalls++}`;
      return stubUnsignedMixResult(label, args.inputs.length, feeShardUtxo(`${label}_fee`));
    };

    const batch = await planFanoutTxs({
      plan,
      network: "preprod",
      provider: NULL_PROVIDER,
      addresses: ADDRESSES,
      feePayer: "wallet",
      buildMix,
    });
    expect(batch.slots).toHaveLength(4); // 1 + 3 at depth 2
    expect(batch.failed).toHaveLength(0);
    expect(batch.slots.map((s) => s.slotId)).toEqual(["w0s0", "w1s0", "w1s1", "w1s2"]);
    expect(batch.slots.every((s) => s.unsignedTxHex.startsWith("un_"))).toBe(true);
    expect(batch.plan).toBe(plan);
  });

  it("threads walletUtxosOverride across leaves in wallet mode (issue #149 fix)", async () => {
    // Regression for the "Input utxo is spent more than once" rejection
    // Eternl returned on the first batch run. In wallet-funded mode,
    // mesh's coin-selection picks a wallet UTxO PER LEAF. Without
    // chaining, every leaf builds against the same pre-mempool snapshot
    // and mesh picks the same UTxO → all four txs in a depth-2 batch
    // reference the same input → wallet rejects. The orchestrator's
    // planFanoutTxs is responsible for chaining: subtract consumed
    // inputs, add change outputs, pass the rolling set to the next
    // leaf via `walletUtxosOverride`.
    const root = makeEntry(0);
    const pool = Array.from({ length: 30 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 2, rng: zeroRng });

    const startingUtxos = [
      makeMeshUtxo("aa" + "00".repeat(31), 0, "addr1stub", 100_000_000n),
      makeMeshUtxo("bb" + "00".repeat(31), 0, "addr1stub", 50_000_000n),
    ];
    let getUtxosCalls = 0;
    const wallet = {
      getUsedAddresses: async () => [],
      getChangeAddress: () => "addr1stub",
      getUtxos: async () => {
        getUtxosCalls += 1;
        return startingUtxos;
      },
      getCollateral: async () => [],
      signTx: async () => "",
      submitTx: async () => "",
    } as unknown as LovejoinWallet;

    let buildIdx = 0;
    const overridesSeen: ReadonlyArray<unknown>[] = [];
    const buildMix = async (args: BuildMixArgs): Promise<MixResult> => {
      overridesSeen.push(args.walletUtxosOverride ?? []);
      const label = `b${buildIdx}`;
      const out = stubUnsignedMixResult(label, args.inputs.length, feeShardUtxo(`${label}_fee`));
      buildIdx += 1;
      return out;
    };
    // Stubbed chain function rolls one entry off per call to simulate
    // "first leaf consumed the head, change recycled at the tail".
    // Verifies that planFanoutTxs actually USES the returned list as
    // the next leaf's override.
    const chainStub = (current: ReadonlyArray<unknown>) => {
      const next = current.slice(1) as ReadonlyArray<{ input: object; output: object }>;
      next.push(
        makeMeshUtxo(buildIdx.toString(16).padStart(64, "f"), 1, "addr1stub", 1_000_000n) as never,
      );
      return next as never;
    };

    await planFanoutTxs({
      plan,
      network: "preprod",
      provider: NULL_PROVIDER,
      addresses: ADDRESSES,
      feePayer: "wallet",
      wallet,
      buildMix,
      chainWalletUtxos: chainStub,
    });

    // wallet.getUtxos is called exactly once at planFanoutTxs entry —
    // every subsequent leaf reads from the override, NOT the wallet.
    expect(getUtxosCalls).toBe(1);
    expect(overridesSeen).toHaveLength(4);
    // First leaf sees the pristine wallet set (2 entries).
    expect((overridesSeen[0] as unknown[]).length).toBe(2);
    // Each subsequent leaf sees the stub's rolled-forward set: head
    // dropped, change appended → still length 2 but with a different
    // first-entry txHash.
    expect((overridesSeen[1] as unknown[]).length).toBe(2);
    expect((overridesSeen[2] as unknown[]).length).toBe(2);
    expect((overridesSeen[3] as unknown[]).length).toBe(2);
    // And critically, no two leaves see the same first-entry — that's
    // the property the wallet checks at signTxs time.
    const firstEntryTxHashes = overridesSeen.map(
      (arr) => (arr[0] as { input: { txHash: string } }).input.txHash,
    );
    expect(new Set(firstEntryTxHashes).size).toBe(4);
  });

  it("does not fetch wallet utxos in shard mode (no chaining needed)", async () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 30 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 2, rng: zeroRng });

    let getUtxosCalls = 0;
    const wallet = {
      getUsedAddresses: async () => [],
      getChangeAddress: () => "addr1stub",
      getUtxos: async () => {
        getUtxosCalls += 1;
        return [];
      },
      getCollateral: async () => [],
      signTx: async () => "",
      submitTx: async () => "",
    } as unknown as LovejoinWallet;

    const buildMix = async (args: BuildMixArgs): Promise<MixResult> => {
      expect(args.walletUtxosOverride).toBeUndefined();
      return stubUnsignedMixResult("s", args.inputs.length, feeShardUtxo("fee"));
    };

    await planFanoutTxs({
      plan,
      network: "preprod",
      provider: NULL_PROVIDER,
      addresses: ADDRESSES,
      feePayer: "shard",
      wallet,
      buildMix,
    });

    expect(getUtxosCalls).toBe(0);
  });

  it("records build-time failures and cascades descendants", async () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 30 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 2, rng: zeroRng });

    let n = 0;
    const buildMix = async (args: BuildMixArgs): Promise<MixResult> => {
      const label = `s${n++}`;
      if (label === "s0") throw new Error("simulated wave-0 build failure");
      return stubUnsignedMixResult(label, args.inputs.length, feeShardUtxo(`${label}_fee`));
    };

    const batch = await planFanoutTxs({
      plan,
      network: "preprod",
      provider: NULL_PROVIDER,
      addresses: ADDRESSES,
      feePayer: "wallet",
      buildMix,
    });
    expect(batch.slots).toHaveLength(0); // wave-0 failed; wave-1 cascaded.
    expect(batch.failed).toHaveLength(1);
    expect(batch.failed[0]!.slotId).toBe("w0s0");
    expect(batch.failed[0]!.droppedDescendants).toEqual(["w0s0", "w1s0", "w1s1", "w1s2"]);
  });
});

describe("submitFanoutBatch", () => {
  function buildStubBatch(plan: ReturnType<typeof planFanout>): UnsignedFanoutBatch {
    return {
      plan,
      slots: plan.waves.flatMap((wave, waveIndex) =>
        wave.slots.map((slot) => {
          const result = stubUnsignedMixResult(slot.id, 3, feeShardUtxo(`${slot.id}_fee`));
          return {
            slotId: slot.id,
            waveIndex,
            unsignedTxHex: result.unsignedTxHex,
            txId: result.txId,
            plan: result.plan,
            actualFeeLovelace: result.actualFeeLovelace,
          };
        }),
      ),
      failed: [],
    };
  }

  function makeStubWallet(
    opts: {
      signedCbors?: (unsigned: string[]) => string[];
      rejectSign?: Error;
    } = {},
  ): { wallet: LovejoinWallet; signCallCount: () => number; signedSeen: () => string[][] } {
    const seen: string[][] = [];
    const wallet = {
      getUsedAddresses: async () => [],
      getChangeAddress: () => "",
      getUtxos: async () => [],
      getCollateral: async () => [],
      signTx: async () => {
        throw new Error("signTx must not be called in batch path");
      },
      signTxs: async (unsignedTxs: string[]) => {
        seen.push(unsignedTxs);
        if (opts.rejectSign) throw opts.rejectSign;
        const fn = opts.signedCbors ?? ((arr) => arr.map((u) => `signed:${u}`));
        return fn(unsignedTxs);
      },
      submitTx: async () => {
        throw new Error("wallet.submitTx must not be called — submitFanoutBatch uses provider");
      },
    } as LovejoinWallet;
    return {
      wallet,
      signCallCount: () => seen.length,
      signedSeen: () => seen,
    };
  }

  it("issues exactly one signTxs prompt for the whole tree and submits via the chain provider", async () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 30 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 2, rng: zeroRng });
    const batch = buildStubBatch(plan);

    const submitted: string[] = [];
    const provider = {
      submitTx: async (signed: string) => {
        submitted.push(signed);
        return signed.replace(/^signed:un_/, "txid_") + "_chain";
      },
    } as unknown as ChainProvider;

    const stub = makeStubWallet();
    const events: FanoutEvent[] = [];
    for await (const evt of submitFanoutBatch({ batch, wallet: stub.wallet, provider })) {
      events.push(evt);
    }

    expect(stub.signCallCount()).toBe(1);
    expect(stub.signedSeen()[0]).toHaveLength(4); // one CBOR per slot
    expect(submitted).toHaveLength(4);
    // Submission order matches batch order (wave-major).
    expect(submitted).toEqual(batch.slots.map((s) => `signed:${s.unsignedTxHex}`));

    const submittedEvts = events.filter((e) => e.kind === "slot-submitted");
    expect(submittedEvts).toHaveLength(4);
    expect(events.filter((e) => e.kind === "slot-failed")).toHaveLength(0);
    expect(events.filter((e) => e.kind === "wave-started")).toHaveLength(2);
    expect(events.filter((e) => e.kind === "wave-completed")).toHaveLength(2);
    const completed = events.at(-1)!;
    if (completed.kind === "plan-completed") {
      expect(completed.submittedSlots).toBe(4);
      expect(completed.failedSlots).toBe(0);
    }
  });

  it("throws when the wallet does not implement signTxs", async () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 30 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 2, rng: zeroRng });
    const batch = buildStubBatch(plan);
    const noBatchWallet = {
      getUsedAddresses: async () => [],
      getChangeAddress: () => "",
      getUtxos: async () => [],
      getCollateral: async () => [],
      signTx: async () => "",
      submitTx: async () => "",
    } as LovejoinWallet;
    const provider = { submitTx: async () => "" } as unknown as ChainProvider;

    await expect(async () => {
      const iter = submitFanoutBatch({ batch, wallet: noBatchWallet, provider });
      for await (const _evt of iter) void _evt;
    }).rejects.toThrow(/does not implement CIP-103 signTxs/);
  });

  it("on submit failure cascades the slot's descendants and continues submitting siblings", async () => {
    const root = makeEntry(0);
    const pool = Array.from({ length: 50 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 3, rng: zeroRng });
    const batch = buildStubBatch(plan);

    // Reject the submission for w1s1 — its three wave-2 descendants
    // should cascade dropped; the other two wave-1 siblings + their
    // descendants must still submit.
    const provider = {
      submitTx: async (signed: string) => {
        if (signed.includes("w1s1")) throw new Error("submitTx refused");
        return `chain_${signed}`;
      },
    } as unknown as ChainProvider;
    const stub = makeStubWallet();

    const events: FanoutEvent[] = [];
    for await (const evt of submitFanoutBatch({ batch, wallet: stub.wallet, provider })) {
      events.push(evt);
    }

    const submitted = events.filter((e) => e.kind === "slot-submitted");
    const failed = events.filter((e) => e.kind === "slot-failed");
    // 1 + 2 (siblings of w1s1) + 6 (their depth-2 descendants) = 9
    expect(submitted).toHaveLength(9);
    expect(failed).toHaveLength(1);
    if (failed[0]?.kind === "slot-failed") {
      expect(failed[0].slotId).toBe("w1s1");
      // Cascade = w1s1 + its 3 wave-2 children.
      expect(failed[0].droppedDescendants).toEqual(["w1s1", "w2s3", "w2s4", "w2s5"]);
    }
  });

  it("replays planner-time failures in the same wave-relative order as submitFanout", async () => {
    // A build-time failure at depth-2 (wave 0) must surface BEFORE any
    // depth-2 wave-completed event so the UI's reducer sees the same
    // sequencing whether the user is on the per-leaf or batch path.
    const root = makeEntry(0);
    const pool = Array.from({ length: 30 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 2, rng: zeroRng });
    const batch: UnsignedFanoutBatch = {
      plan,
      slots: [],
      failed: [
        {
          slotId: "w0s0",
          waveIndex: 0,
          error: new Error("simulated build failure"),
          droppedDescendants: ["w0s0", "w1s0", "w1s1", "w1s2"],
        },
      ],
    };
    const stub = makeStubWallet();
    const provider = { submitTx: async () => "" } as unknown as ChainProvider;
    const events: FanoutEvent[] = [];
    for await (const evt of submitFanoutBatch({ batch, wallet: stub.wallet, provider })) {
      events.push(evt);
    }
    // signTxs got an empty array — no slot bodies survived.
    expect(stub.signCallCount()).toBe(0);
    const failed = events.filter((e) => e.kind === "slot-failed");
    expect(failed).toHaveLength(1);
    if (failed[0]?.kind === "slot-failed") expect(failed[0].slotId).toBe("w0s0");
    const completed = events.at(-1)!;
    if (completed.kind === "plan-completed") {
      expect(completed.submittedSlots).toBe(0);
      expect(completed.failedSlots).toBe(4);
    }
  });

  it("propagates a signTxs rejection (user-declined batch) up to the caller", async () => {
    // Whole-tree rejection in CIP-103 is clean: the wallet returns
    // before any tx is submitted. Caller catches the throw and shows
    // an error toast; partial recovery is the caller's policy.
    const root = makeEntry(0);
    const pool = Array.from({ length: 30 }, (_, i) => makeEntry(i + 1));
    const plan = planFanout({ rootBox: root, pool, depth: 2, rng: zeroRng });
    const batch = buildStubBatch(plan);
    const stub = makeStubWallet({ rejectSign: new Error("user declined") });
    const provider = {
      submitTx: async () => {
        throw new Error("must not submit on signTxs failure");
      },
    } as unknown as ChainProvider;
    await expect(async () => {
      for await (const _evt of submitFanoutBatch({
        batch,
        wallet: stub.wallet,
        provider,
      })) {
        void _evt;
      }
    }).rejects.toThrow(/user declined/);
  });
});
