// Fan-out Mix orchestrator — issue #137.
//
// Walks a `FanoutPlan` wave by wave, resolves each slot's three inputs
// from a mix of fresh pool entries and the previous wave's outputs, and
// drives `buildMixTx` through them. Yields a stream of `FanoutEvent`s so
// the caller (UI or CLI) can render progress in real time.
//
// ## Design
//
// The orchestrator is the part of the strategy that touches the chain.
// `planFanout` (pure) handed us the SHAPE of the tree; we materialise
// each slot's MixInput[] from the plan + the running map of
// parent → MixResult, then call buildMixTx.
//
// Why we can't fully prebuild every wave at plan time:
//
//   The chained-Mix path uses Mesh's `chainFrom.utxos` to splice
//   in-flight parent outputs into the evaluator. Each child wave's
//   MixInput needs a concrete UtxoRef (txId + outputIndex). The txId
//   is set by mesh's `complete()` after the build finishes, so we
//   cannot know wave-2's input refs until wave-1 has been built.
//
// So the orchestrator builds wave 1, captures every slot's MixResult,
// then materialises wave 2 from those results, and so on.
//
// ## Submission concurrency
//
// Within a wave the slots are independent (no slot consumes another
// slot's output — children only read parents from the PREVIOUS wave).
// They share a finite resource: the fee-shard pool. Submitting in
// parallel would race for shards. For now we submit one slot at a time
// within a wave, threading an exclude set through `pickRandomFeeShard`
// so two slots never claim the same shard. Parallel within-wave
// submission is a future optimisation gated by giveme.my's rate limit
// + the fee-shard contention model.
//
// ## Rollback / BranchDropped
//
// If a slot's `buildMixTx` throws, we don't auto-retry — the caller's
// `retry` option lives inside `buildMixTx` for the single-tx layer.
// The orchestrator surfaces the failure as a `slot-failed` event with
// the full list of descendant slots that are now invalid (their
// would-be parent never produced an output, so they can't be built).
// We skip those descendants for the rest of the run.
//
// The caller decides whether to re-plan from the surviving slots; this
// module does NOT attempt to rebuild parts of the tree. Issue #137:
// "No automatic rebuild — that's a caller policy."

import {
  buildMixTx,
  type BuildMixArgs,
  type MixFeePayer,
  type MixInput,
  type MixResult,
} from "../tx/mix.js";
import type { CollateralProvider } from "../tx/collateral.js";
import type { ChainProvider, Lovelace, Utxo, UtxoRef } from "../chain/provider.js";
import { type LovejoinAddresses } from "../tx/params.js";
import { buildScriptAddress } from "../tx/address.js";
import { type LovejoinWallet, networkIdFor } from "../wallet/cip30.js";
import type { Scalar } from "../crypto/index.js";
import type { RetryOptions } from "../tx/retry.js";
import {
  fanoutDescendants,
  type FanoutInputDescriptor,
  type FanoutPlan,
  type FanoutSlot,
  type FanoutSlotId,
} from "./fanout.js";

// ---------------------------------------------------------------------------
// Event types — yielded from submitFanout's async iterator
// ---------------------------------------------------------------------------

export type FanoutEvent =
  | { kind: "wave-started"; waveIndex: number; slotCount: number }
  | {
      kind: "slot-submitted";
      slotId: FanoutSlotId;
      waveIndex: number;
      txId: string;
      result: MixResult;
    }
  | {
      kind: "slot-failed";
      slotId: FanoutSlotId;
      waveIndex: number;
      error: Error;
      /** Descendants now unreachable because their parent never produced
       *  an output. Includes the failed slot itself at index 0. */
      droppedDescendants: FanoutSlotId[];
    }
  | {
      kind: "wave-completed";
      waveIndex: number;
      submitted: FanoutSlotId[];
      failed: FanoutSlotId[];
    }
  | { kind: "plan-completed"; submittedSlots: number; failedSlots: number };

// ---------------------------------------------------------------------------
// submitFanout — public API
// ---------------------------------------------------------------------------

export interface SubmitFanoutArgs {
  plan: FanoutPlan;
  network: "preprod" | "preview" | "test" | "mainnet";
  provider: ChainProvider;
  addresses: LovejoinAddresses;
  /**
   * Optional CIP-30 wallet. Only used as a collateral fallback if the
   * configured GivemeMyProvider has no entry for the network; the Mix
   * itself never holds a wallet input in shard mode.
   */
  wallet?: LovejoinWallet;
  /**
   * Collateral provider — defaults to the GivemeMyProvider pinned in
   * `tx/known-collateral-hosts.ts` for `args.network`. Pass an explicit
   * provider for local dev / debugging only.
   */
  collateralProvider?: CollateralProvider;
  /**
   * Refs to exclude from fee-shard picking. The orchestrator merges this
   * with the rolling in-flight set so callers can also pass mempool refs
   * from other users' pending txs.
   */
  excludeFeeShardRefs?: ReadonlyArray<UtxoRef>;
  /**
   * Extra fee-shard UTxOs to consider during picking. The orchestrator
   * appends each submitted slot's post-state shard to this set as the
   * run progresses, so wave N+1 can re-spend wave N's outputs without
   * waiting for confirmation.
   */
  feeShardExtras?: ReadonlyArray<Utxo>;
  /**
   * Extra UTxOs to forward as `chainFrom.utxos` on EVERY slot's build.
   * The orchestrator splices in the in-flight parent outputs
   * automatically; this is just the "external" set (e.g. the in-flight
   * Deposit that created the root box).
   */
  chainFromUtxos?: ReadonlyArray<Utxo>;
  /**
   * Mode the SDK uses to pay the per-tx fee for every slot. Default:
   * `"shard"`. The fan-out strategy specifically requires shard mode
   * because the protocol's wallet-anonymity property is what we're
   * amplifying — `"wallet"` would publish the submitter's identity on
   * every leaf and undo the entire effort. Passed through unchanged
   * mostly so tests can stub it.
   */
  feePayer?: MixFeePayer;
  /** Forwarded to every slot's `buildMixTx` call. Default: no retry. */
  retry?: RetryOptions;
  /**
   * Optional deterministic-secret list for tests. Indexed by `slot.id`.
   * Each value is the 3 `y_i` scalars planMixTx will use for THAT slot.
   * Missing entries fall through to the SDK's default (WebCrypto-drawn).
   */
  ySecretsBySlot?: ReadonlyMap<FanoutSlotId, ReadonlyArray<Scalar>>;
  /**
   * Optional deterministic-permutation list for tests. Indexed by
   * `slot.id`. Each value is the permutation planMixTx will use.
   */
  permutationsBySlot?: ReadonlyMap<FanoutSlotId, ReadonlyArray<number>>;
  /**
   * Internal-use seam: a replacement for `buildMixTx`. Production callers
   * leave this undefined; tests inject a stub that returns canned
   * MixResults so the orchestrator's wave-by-wave logic can be tested
   * without a chain provider.
   *
   * @internal
   */
  buildMix?: typeof buildMixTx;
}

/**
 * Run a fan-out Mix plan against the chain, yielding events as each
 * slot lands or fails.
 *
 * Usage:
 * ```ts
 * for await (const evt of submitFanout({ plan, provider, addresses, ... })) {
 *   switch (evt.kind) {
 *     case "slot-submitted": console.log("submitted", evt.slotId, evt.txId); break;
 *     case "slot-failed": console.warn("failed", evt.slotId, evt.error); break;
 *   }
 * }
 * ```
 */
export async function* submitFanout(args: SubmitFanoutArgs): AsyncIterable<FanoutEvent> {
  const build = args.buildMix ?? buildMixTx;
  const denomLovelace = readDenomLovelace(args);
  const mixBoxAddressBech32 = buildScriptAddress(
    args.addresses.mixBoxScriptHash,
    networkIdFor(args.network),
  );

  // Slot-id → MixResult for every slot that has successfully landed (or
  // at least been submitted). Used to materialise child slots' inputs.
  const submitted = new Map<FanoutSlotId, MixResult>();
  // Slots that won't run because a parent failed.
  const dropped = new Set<FanoutSlotId>();
  // Fee-shard book-keeping. Refs consumed by THIS run's slots; per-run
  // post-state shards we'd like the picker to consider for future
  // slots; merged with the caller's seed sets on each `build` call.
  const inFlightShardRefs = new Set<string>();
  for (const r of args.excludeFeeShardRefs ?? []) inFlightShardRefs.add(refKey(r));
  const inFlightShardExtras: Utxo[] = [...(args.feeShardExtras ?? [])];
  // Mix-output UTxOs from THIS run's slots, plus caller-seeded extras
  // (typically the in-flight Deposit that created the root box).
  const inFlightChainFromUtxos: Utxo[] = [...(args.chainFromUtxos ?? [])];

  let submittedCount = 0;
  let failedCount = 0;

  for (let k = 0; k < args.plan.waves.length; k++) {
    const wave = args.plan.waves[k]!;
    yield { kind: "wave-started", waveIndex: k, slotCount: wave.slots.length };

    const submittedThisWave: FanoutSlotId[] = [];
    const failedThisWave: FanoutSlotId[] = [];

    for (const slot of wave.slots) {
      if (dropped.has(slot.id)) {
        // Parent failed; nothing to do. Cascade event was already
        // emitted when the parent failed.
        continue;
      }

      let inputs: MixInput[];
      try {
        inputs = materialiseSlotInputs({
          slot,
          plan: args.plan,
          parentResults: submitted,
          denomLovelace,
          mixBoxAddressBech32,
        });
      } catch (err) {
        // Materialise failure is a programmer error in this module,
        // not a chain failure. Surface it loudly and skip the slot.
        const droppedList = fanoutDescendants(args.plan, slot.id);
        for (const id of droppedList) dropped.add(id);
        failedCount += droppedList.length;
        failedThisWave.push(slot.id);
        yield {
          kind: "slot-failed",
          slotId: slot.id,
          waveIndex: k,
          error: err instanceof Error ? err : new Error(String(err)),
          droppedDescendants: droppedList,
        };
        continue;
      }

      const slotExclude: UtxoRef[] = [];
      for (const key of inFlightShardRefs) slotExclude.push(parseRefKey(key));

      const ySecrets = args.ySecretsBySlot?.get(slot.id);
      const permutation = args.permutationsBySlot?.get(slot.id);

      const buildArgs: BuildMixArgs = {
        network: args.network,
        inputs,
        ...(args.wallet ? { wallet: args.wallet } : {}),
        provider: args.provider,
        addresses: args.addresses,
        feePayer: args.feePayer ?? "shard",
        ...(slotExclude.length > 0 ? { excludeFeeShardRefs: slotExclude } : {}),
        ...(inFlightShardExtras.length > 0 ? { feeShardExtras: inFlightShardExtras } : {}),
        ...(args.collateralProvider ? { collateralProvider: args.collateralProvider } : {}),
        ...(args.retry ? { retry: args.retry } : {}),
        ...(inFlightChainFromUtxos.length > 0
          ? {
              chainFrom: {
                utxos: inFlightChainFromUtxos,
                chainDepth: k + 1,
              },
            }
          : {}),
        ...(ySecrets ? { ySecrets: ySecrets.slice() } : {}),
        ...(permutation ? { permutation: permutation.slice() } : {}),
      };

      let result: MixResult;
      try {
        result = await build(buildArgs);
      } catch (err) {
        const droppedList = fanoutDescendants(args.plan, slot.id);
        for (const id of droppedList) dropped.add(id);
        failedCount += droppedList.length;
        failedThisWave.push(slot.id);
        yield {
          kind: "slot-failed",
          slotId: slot.id,
          waveIndex: k,
          error: err instanceof Error ? err : new Error(String(err)),
          droppedDescendants: droppedList,
        };
        continue;
      }

      submitted.set(slot.id, result);
      submittedCount += 1;
      submittedThisWave.push(slot.id);

      // Update in-flight tracker:
      //   * Mix-output UTxOs go onto chainFromUtxos so the NEXT wave's
      //     evaluator + collateral host can resolve them.
      //   * Fee-shard input goes onto the in-flight ref set so the
      //     picker doesn't pick the same shard for another slot in this
      //     wave / future waves.
      //   * Fee-shard POST-STATE goes onto feeShardExtras so a future
      //     slot can re-spend it.
      const txIdLower = result.txId.toLowerCase();
      for (let i = 0; i < result.plan.outputs.length; i++) {
        const out = result.plan.outputs[i]!;
        inFlightChainFromUtxos.push({
          ref: { txId: txIdLower, outputIndex: i },
          address: result.plan.mixBoxAddressBech32,
          lovelace: denomLovelace,
          assets: {},
          inlineDatum: out.inlineDatumHex,
          referenceScript: null,
        });
      }
      if (result.plan.feePayer === "shard" && result.plan.feeShardInput) {
        inFlightShardRefs.add(refKey(result.plan.feeShardInput.ref));
      }
      const postShardOutput = result.plan.feeShardOutput;
      if (postShardOutput && result.plan.feePayer === "shard" && result.plan.feeShardInput) {
        const shardRef = { txId: txIdLower, outputIndex: result.plan.n };
        const realFee =
          result.actualFeeLovelace ?? result.plan.txFeeLovelace ?? postShardOutput.lovelace;
        const realisticLovelace = result.plan.feeShardInput.lovelace - realFee;
        const postShardUtxo: Utxo = {
          ref: shardRef,
          address: postShardOutput.addressBech32,
          lovelace: realisticLovelace,
          assets: {},
          inlineDatum: postShardOutput.inlineDatumHex,
          referenceScript: null,
        };
        // Forward in both registers so a future slot CAN pick this
        // shard (extras) AND the evaluator can resolve it once picked
        // (chainFrom).
        inFlightShardExtras.push(postShardUtxo);
        inFlightChainFromUtxos.push(postShardUtxo);
      }

      yield {
        kind: "slot-submitted",
        slotId: slot.id,
        waveIndex: k,
        txId: result.txId,
        result,
      };
    }

    yield {
      kind: "wave-completed",
      waveIndex: k,
      submitted: submittedThisWave,
      failed: failedThisWave,
    };
  }

  yield {
    kind: "plan-completed",
    submittedSlots: submittedCount,
    failedSlots: failedCount,
  };
}

// ---------------------------------------------------------------------------
// materialiseSlotInputs — slot descriptor → concrete MixInput list
// ---------------------------------------------------------------------------

export interface MaterialiseArgs {
  slot: FanoutSlot;
  plan: FanoutPlan;
  /** Slot id → MixResult for every previously-submitted slot. */
  parentResults: ReadonlyMap<FanoutSlotId, MixResult>;
  denomLovelace: Lovelace;
  /** Bech32 mix-box address — used to synthesize child input UTxOs. */
  mixBoxAddressBech32: string;
}

/**
 * Resolve a slot's `FanoutInputDescriptor[]` into a `MixInput[]` the SDK
 * can hand to `planMixTx`. Throws if a descriptor refers to a parent
 * slot that hasn't been submitted yet — that's a bug in the orchestrator
 * loop ordering, not a runtime condition.
 *
 * Exported for unit-tests + advanced callers that want to inspect a
 * slot's resolved inputs before submission (e.g. for a dry-run UI).
 */
export function materialiseSlotInputs(args: MaterialiseArgs): MixInput[] {
  return args.slot.inputs.map((desc) => materialiseOneInput(desc, args));
}

function materialiseOneInput(desc: FanoutInputDescriptor, ctx: MaterialiseArgs): MixInput {
  switch (desc.kind) {
    case "root":
    case "pool": {
      const entry = desc.entry;
      return { ref: entry.ref, a: entry.a, b: entry.b, utxo: entry.utxo };
    }
    case "parent": {
      const parent = ctx.parentResults.get(desc.parentSlotId);
      if (!parent) {
        throw new Error(
          `materialiseSlotInputs: parent ${desc.parentSlotId} of slot ${ctx.slot.id} not submitted yet`,
        );
      }
      const out = parent.plan.outputs[desc.parentOutputPosition];
      if (!out) {
        throw new Error(
          `materialiseSlotInputs: parent ${desc.parentSlotId} has no output at position ${desc.parentOutputPosition}`,
        );
      }
      const txIdLower = parent.txId.toLowerCase();
      const ref: UtxoRef = { txId: txIdLower, outputIndex: desc.parentOutputPosition };
      const utxo: Utxo = {
        ref,
        address: parent.plan.mixBoxAddressBech32 || ctx.mixBoxAddressBech32,
        lovelace: ctx.denomLovelace,
        assets: {},
        inlineDatum: out.inlineDatumHex,
        referenceScript: null,
      };
      return { ref, a: out.a, b: out.b, utxo };
    }
    default: {
      // Exhaustiveness check.
      const exhaustive: never = desc;
      throw new Error(
        `materialiseSlotInputs: unknown descriptor kind ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function readDenomLovelace(args: SubmitFanoutArgs): Lovelace {
  // Read the protocol denom from the addresses bundle. We intentionally
  // don't take this from the chain provider's `fetchProtocolParams` —
  // that's an extra RPC per fan-out and the addresses bundle is
  // authoritative for off-chain code.
  const raw = args.addresses.protocol?.denom_lovelace;
  if (raw === undefined || raw === null) {
    throw new Error("submitFanout: addresses.protocol.denom_lovelace is missing");
  }
  return BigInt(raw);
}

function refKey(ref: UtxoRef): string {
  return `${ref.txId.toLowerCase()}#${ref.outputIndex}`;
}

function parseRefKey(key: string): UtxoRef {
  const hash = key.indexOf("#");
  if (hash <= 0) throw new Error(`parseRefKey: malformed key "${key}"`);
  const idx = Number(key.slice(hash + 1));
  if (!Number.isInteger(idx) || idx < 0) {
    throw new Error(`parseRefKey: bad output index in "${key}"`);
  }
  return { txId: key.slice(0, hash), outputIndex: idx };
}

// ---------------------------------------------------------------------------
// Convenience: collect events into a typed summary
// ---------------------------------------------------------------------------

export interface FanoutRunSummary {
  submittedSlots: Map<FanoutSlotId, MixResult>;
  failedSlots: Map<FanoutSlotId, Error>;
  /** All slots cascaded as dropped (incl. failed ones). */
  droppedSlots: Set<FanoutSlotId>;
  /** Most recent `plan-completed` event, or null if the iterator was
   *  abandoned before completion. */
  completed: { submittedSlots: number; failedSlots: number } | null;
}

/**
 * Drain a fan-out event iterator into a tally. The UI can call this
 * when it wants the final state without rendering progress mid-stream;
 * more typical UI use is the streaming form.
 */
export async function collectFanoutResults(
  events: AsyncIterable<FanoutEvent>,
): Promise<FanoutRunSummary> {
  const submittedSlots = new Map<FanoutSlotId, MixResult>();
  const failedSlots = new Map<FanoutSlotId, Error>();
  const droppedSlots = new Set<FanoutSlotId>();
  let completed: FanoutRunSummary["completed"] = null;
  for await (const evt of events) {
    switch (evt.kind) {
      case "slot-submitted":
        submittedSlots.set(evt.slotId, evt.result);
        break;
      case "slot-failed":
        failedSlots.set(evt.slotId, evt.error);
        for (const id of evt.droppedDescendants) droppedSlots.add(id);
        break;
      case "plan-completed":
        completed = { submittedSlots: evt.submittedSlots, failedSlots: evt.failedSlots };
        break;
      // wave-started / wave-completed are informational; no state change.
    }
  }
  return { submittedSlots, failedSlots, droppedSlots, completed };
}
