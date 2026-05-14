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
  type MixPlan,
  type MixResult,
} from "../tx/mix.js";
import type { CollateralProvider } from "../tx/collateral.js";
import type { ChainProvider, Lovelace, Utxo, UtxoRef } from "../chain/provider.js";
import { type LovejoinAddresses } from "../tx/params.js";
import { buildScriptAddress } from "../tx/address.js";
import { type LovejoinWallet, networkIdFor, normalizeWalletUtxos } from "../wallet/cip30.js";
import type { Scalar } from "../crypto/index.js";
import type { RetryOptions } from "../tx/retry.js";
import type { UTxO as MeshUtxo } from "@meshsdk/core";
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
  /**
   * Internal-use seam (planFanoutTxs only): override the wallet-UTxO
   * chaining function. Production leaves this undefined and the real
   * `chainWalletUtxosAfterBuild` (which parses the unsigned CBOR via
   * @meshsdk/core-cst) is used. Tests inject a stub that returns the
   * rolling list verbatim, bypassing the CBOR parser so they can
   * exercise the override-threading logic with synthetic CBOR.
   *
   * @internal
   */
  chainWalletUtxos?: (
    current: ReadonlyArray<MeshUtxo>,
    unsignedTxHex: string,
    changeAddressBech32: string,
  ) => ChainWalletUtxosResult;
}

/**
 * Output of {@link chainWalletUtxosAfterBuild}. The orchestrator needs
 * three pieces of info from each leaf's just-built unsigned CBOR:
 *
 *   * `rolling` — the wallet's spendable set with this leaf's consumed
 *     input(s) removed and its change output(s) added. Fed to the next
 *     leaf as `walletUtxosOverride`.
 *   * `inFlightChange` — this leaf's change outputs in flat `Utxo`
 *     shape. The orchestrator merges them into subsequent leaves'
 *     `chainFrom.utxos` so ogmios's evaluator can resolve a wallet
 *     input that came from a previous leaf in the same batch — without
 *     this the evaluator falls back to populate-time placeholder ex
 *     units and the chain rejects the tx with a script-budget
 *     validation error.
 *   * `consumedKeys` — refKeys of every input this tx spent. The
 *     orchestrator subtracts them from the in-flight wallet-change map
 *     so a wallet utxo that's already been spent doesn't get re-added
 *     to a later leaf's chainFrom.
 */
export interface ChainWalletUtxosResult {
  rolling: MeshUtxo[];
  inFlightChange: Utxo[];
  consumedKeys: Set<string>;
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
  // External chainFrom utxos the caller seeded (e.g. an in-flight
  // Deposit that created the root box). Forwarded on every slot's
  // build; doesn't grow as the run progresses.
  const externalChainFromUtxos: Utxo[] = [...(args.chainFromUtxos ?? [])];
  // Slot-id → that slot's 3 mix outputs + 1 fee shard, ready to splice
  // into a CHILD slot's chainFrom. Indexed by parent slot id so a
  // child only forwards its DIRECT parent's outputs instead of the
  // whole accumulated tree (which blows past the backend's 32-entry
  // additionalUtxoSet cap at depth >= 3).
  const parentOutputsBySlot = new Map<FanoutSlotId, Utxo[]>();

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

      // Per-slot chainFrom = external caller seeds + this slot's direct
      // parent's full output set + every in-flight post-state fee shard
      // (so the picker can use feeShardExtras and the evaluator can
      // resolve whichever shard it picks). We intentionally do NOT
      // include sibling or grand-parent mix outputs — only the direct
      // parent's mix outputs are referenceable by this slot, and the
      // backend's /evaluate caps additionalUtxoSet at 32 entries.
      //
      // Bound: 4 (parent outputs) + ≤13 (total fan-out fee shards) +
      // |external| ≤ ~20 even at depth 4 — comfortably under 32.
      const parentSlotId = slot.inputs.find((i) => i.kind === "parent");
      const parentChainFrom: Utxo[] =
        parentSlotId && parentSlotId.kind === "parent"
          ? (parentOutputsBySlot.get(parentSlotId.parentSlotId) ?? [])
          : [];
      const slotChainFromUtxos = [
        ...externalChainFromUtxos,
        ...parentChainFrom,
        ...inFlightShardExtras,
      ];

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
        ...(slotChainFromUtxos.length > 0
          ? {
              chainFrom: {
                utxos: slotChainFromUtxos,
                chainDepth: k + 1,
              },
            }
          : {}),
        ...(ySecrets ? { ySecrets: ySecrets.slice() } : {}),
        ...(permutation ? { permutation: permutation.slice() } : {}),
      };

      let result: MixResult;
      const slotStartMs = Date.now();
      try {
        result = await build(buildArgs);
        const elapsedMs = Date.now() - slotStartMs;
        // Per-slot wall-clock so users can spot where a fan-out hangs.
        // mix.ts and collateral.ts already log their internal stages
        // (`shard-mode fee discovery`, `POST /collateral/`, etc.); the
        // total here lets you cross-reference. A slot taking >5 s on
        // a healthy network points at either a backend `/evaluate`
        // stall or a collateral-host retry backoff (1s, 2s, 4s, 8s).
        console.log(
          `[lovejoin/fanout] slot ${slot.id} (wave ${k + 1}, chainFrom=${slotChainFromUtxos.length}) ` +
            `submitted in ${elapsedMs}ms — tx ${result.txId.slice(0, 12)}…`,
        );
      } catch (err) {
        const elapsedMs = Date.now() - slotStartMs;
        console.warn(
          `[lovejoin/fanout] slot ${slot.id} (wave ${k + 1}) failed after ${elapsedMs}ms`,
        );
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
      //   * Mix outputs go into parentOutputsBySlot, keyed by THIS
      //     slot's id, so only this slot's direct child slots inherit
      //     them via chainFrom — not unrelated cousins or descendants.
      //   * Fee-shard input ref goes into inFlightShardRefs (exclude
      //     set) so no later slot picks the same shard.
      //   * Fee-shard POST-STATE goes into inFlightShardExtras (picker
      //     candidates), and is folded into every slot's chainFrom
      //     since the picker may select it from any wave.
      const txIdLower = result.txId.toLowerCase();
      const thisSlotOutputs: Utxo[] = [];
      for (let i = 0; i < result.plan.outputs.length; i++) {
        const out = result.plan.outputs[i]!;
        thisSlotOutputs.push({
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
        // Pickable by future slots + resolvable by their evaluator.
        // Folded into chainFrom for every slot (small set; ≤13 at
        // depth 4). Intentionally NOT pushed into parentOutputsBySlot
        // — the shard already shows up in inFlightShardExtras, which
        // every slot's chainFrom merges in, so adding it here would
        // duplicate the entry in the additionalUtxoSet payload.
        inFlightShardExtras.push(postShardUtxo);
      }
      parentOutputsBySlot.set(slot.id, thisSlotOutputs);

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

// ---------------------------------------------------------------------------
// Batch-sign path — issue #149.
//
// Wallet-funded fan-out via the per-leaf `submitFanout` pops one CIP-30
// signTx prompt per slot (4 at depth 2, 13 at depth 3) which makes the
// flow user-hostile even when the chained-tx path itself works fine.
// CIP-103 lets the wallet sign an array of unsigned txs in one prompt;
// this two-step API splits the existing `submitFanout` loop into:
//
//   1. `planFanoutTxs` — runs the wave-by-wave build loop with
//      `buildOnly: true` so each leaf returns just an unsigned tx CBOR
//      + the derived txId. No wallet calls, no submission. Internally
//      delegates to `submitFanout` with a wrapped buildMix that flips
//      buildOnly on; reuses the wave coordination + fee-shard tracking
//      logic verbatim.
//   2. `submitFanoutBatch` — accepts the batch from (1), calls
//      `wallet.signTxs(...)` ONCE for the whole array, then submits
//      each signed CBOR in order, yielding the same FanoutEvent stream
//      as submitFanout so the UI can reuse its progress reducer.
//
// Wallets without CIP-103 fall back to per-leaf `submitFanout`. The
// UI gate lives in `useFanoutSubmit`; the SDK exposes both paths so
// non-UI callers (CLI, tests) can pick either.
// ---------------------------------------------------------------------------

/** A single fan-out slot's build output, ready for batch-signing. */
export interface UnsignedFanoutSlot {
  slotId: FanoutSlotId;
  waveIndex: number;
  /** Unsigned tx CBOR ready to be handed to `wallet.signTxs(...)`. */
  unsignedTxHex: string;
  /** Tx id derived from the unsigned body hash. Matches the value the
   *  chain will assign post-submission (witnesses don't affect it). */
  txId: string;
  plan: MixPlan;
  actualFeeLovelace: Lovelace | null;
}

/** A built-but-unsigned fan-out tree, output of {@link planFanoutTxs}. */
export interface UnsignedFanoutBatch {
  /** The original plan — surfaced so `submitFanoutBatch` can cascade
   *  failed-slot descendants the same way `submitFanout` does. */
  plan: FanoutPlan;
  /**
   * Built slots in submission order (wave-major, plan-order within a
   * wave). Pass `.map(s => s.unsignedTxHex)` directly to
   * `wallet.signTxs(...)`.
   */
  slots: ReadonlyArray<UnsignedFanoutSlot>;
  /**
   * Slots whose `buildOnly` pass failed (e.g. fee-shard pick exhausted,
   * evaluator error). Their descendants are already excluded from
   * `slots` per the orchestrator's cascade rule. The UI can render
   * these alongside the run summary in the same shape as the per-leaf
   * path's slot-failed events.
   */
  failed: ReadonlyArray<{
    slotId: FanoutSlotId;
    waveIndex: number;
    error: Error;
    droppedDescendants: FanoutSlotId[];
  }>;
}

/**
 * Build every Mix tx for a fan-out plan without signing or submitting.
 * Wraps the standard `submitFanout` wave loop and forces every slot's
 * `buildMixTx` call into `buildOnly: true` mode so the wallet is never
 * touched.
 *
 * Use this together with {@link submitFanoutBatch} to drive CIP-103
 * multi-tx signing — one wallet prompt for the whole tree instead of N.
 *
 * Caller responsibilities:
 *   * `args.feePayer` should be `"wallet"` for the batch path to be
 *     meaningful — shard-mode is already wallet-anonymous and never
 *     prompts the wallet, so batch-signing it is a no-op. Defaults to
 *     `"shard"` to match `submitFanout` for shape compatibility, but
 *     callers in the wallet-funded fan-out path pass `"wallet"`.
 *   * Pass the same `wallet` here as you will pass to
 *     `submitFanoutBatch`. The wallet here is consumed by
 *     `WalletProvider.prepareCollateral` for each leaf (a query, not a
 *     signature).
 */
export async function planFanoutTxs(args: SubmitFanoutArgs): Promise<UnsignedFanoutBatch> {
  // Wrap the caller's buildMix (or the default) so every slot's build
  // pass runs in `buildOnly` mode. This re-uses every coordination
  // detail of submitFanout — fee-shard exclusion, in-flight chainFrom
  // splicing, parent → child input resolution — without copy-pasting
  // the wave loop.
  const underlyingBuild = args.buildMix ?? buildMixTx;
  const feePayer: MixFeePayer = args.feePayer ?? "shard";

  // Wallet-UTxO chaining (fixes the "Input utxo is spent more than once"
  // signTxs rejection on Eternl). In wallet-funded mode every leaf's
  // build calls `wallet.getUtxos()`, but inside `planFanoutTxs` no leaf
  // ever gets submitted, so every call returns the same pre-mempool
  // snapshot and mesh picks the SAME wallet input for every leaf. We
  // pre-fetch once here, subtract consumed inputs + add change outputs
  // after each build, and pass the rolling list to subsequent builds
  // via `walletUtxosOverride`. The per-leaf `submitFanout` path doesn't
  // need this because the wallet sees each submit and updates its own
  // mempool view between calls.
  const initialWalletUtxos: MeshUtxo[] = [];
  let changeAddress: string | null = null;
  if (feePayer === "wallet" && args.wallet) {
    const fetched = await args.wallet.getUtxos();
    initialWalletUtxos.push(...normalizeWalletUtxos(fetched));
    changeAddress = await args.wallet.getChangeAddress();
  }
  let rollingWalletUtxos: MeshUtxo[] = initialWalletUtxos.slice();
  // In-flight wallet change UTxOs (this batch's prior-leaf outputs that
  // aren't on chain yet). Keyed by refKey so the next leaf's consumed
  // inputs can remove them from the map without a linear scan, and the
  // values are spliced into the next leaf's `chainFrom.utxos` so
  // ogmios's evaluator can resolve them — without that the evaluator
  // returns no exec budgets, redeemers ship with the populate-time
  // placeholder (mem=10000 / steps=1_000_000), and on-chain Mix
  // validation fails out of script budget.
  const inFlightWalletExtras = new Map<string, Utxo>();

  // Load core-cst once if we're in wallet mode — the real chaining
  // helper needs it to parse each unsigned tx, and a dynamic import
  // per call would add a few ms × N leaves of redundant module-
  // resolution work. Skipped entirely when the caller injects a test
  // chainWalletUtxos stub.
  const cst =
    feePayer === "wallet" && args.wallet && !args.chainWalletUtxos
      ? ((await import("@meshsdk/core-cst")) as typeof import("@meshsdk/core-cst"))
      : null;
  const chainWalletUtxos =
    args.chainWalletUtxos ??
    ((current, unsignedTxHex, changeAddressBech32) =>
      chainWalletUtxosAfterBuild(current, unsignedTxHex, changeAddressBech32, cst!));

  const buildOnlyMix = async (a: BuildMixArgs): Promise<MixResult> => {
    const override =
      feePayer === "wallet" && rollingWalletUtxos.length > 0
        ? { walletUtxosOverride: rollingWalletUtxos.slice() }
        : {};
    // Splice any in-flight wallet UTxOs (change emitted by an earlier
    // leaf in this batch, not yet on chain) into chainFrom.utxos.
    // Bound: ≤ (slots built so far) entries, comfortably under the
    // backend's 32-entry cap together with the existing chainFrom
    // contributors (direct parent's mix outputs + in-flight fee-shard
    // extras).
    const chainFromArg = (() => {
      const baseUtxos = a.chainFrom?.utxos ?? [];
      const inFlightWalletList = Array.from(inFlightWalletExtras.values());
      const merged: Utxo[] = [...baseUtxos, ...inFlightWalletList];
      if (merged.length === 0) return undefined;
      return { ...(a.chainFrom ?? {}), utxos: merged };
    })();
    const built = await underlyingBuild({
      ...a,
      ...override,
      buildOnly: true,
      ...(chainFromArg ? { chainFrom: chainFromArg } : {}),
    });
    if (feePayer === "wallet" && changeAddress) {
      const result = chainWalletUtxos(rollingWalletUtxos, built.unsignedTxHex, changeAddress);
      rollingWalletUtxos = result.rolling;
      // Remove just-spent inputs from the in-flight tracker. Chain
      // helper returns the full consumed set including the mix-box +
      // pool inputs; those aren't in the map so .delete() is a no-op
      // for them.
      for (const k of result.consumedKeys) inFlightWalletExtras.delete(k);
      // Add this leaf's wallet change as a new in-flight entry so
      // subsequent leaves can resolve it via chainFrom.
      for (const u of result.inFlightChange) {
        const key = `${u.ref.txId.toLowerCase()}#${u.ref.outputIndex}`;
        inFlightWalletExtras.set(key, u);
      }
    }
    return built;
  };

  const slots: UnsignedFanoutSlot[] = [];
  const failed: Array<UnsignedFanoutBatch["failed"][number]> = [];

  for await (const evt of submitFanout({ ...args, buildMix: buildOnlyMix })) {
    if (evt.kind === "slot-submitted") {
      // "submitted" here means "built" because buildOnly was set.
      slots.push({
        slotId: evt.slotId,
        waveIndex: evt.waveIndex,
        unsignedTxHex: evt.result.unsignedTxHex,
        txId: evt.txId,
        plan: evt.result.plan,
        actualFeeLovelace: evt.result.actualFeeLovelace,
      });
    } else if (evt.kind === "slot-failed") {
      failed.push({
        slotId: evt.slotId,
        waveIndex: evt.waveIndex,
        error: evt.error,
        droppedDescendants: [...evt.droppedDescendants],
      });
    }
    // wave-started / wave-completed / plan-completed are informational
    // during planning; the caller receives the full picture in the
    // returned UnsignedFanoutBatch.
  }

  return { plan: args.plan, slots, failed };
}

/**
 * Walk a freshly-built unsigned Mix tx and update a rolling wallet-UTxO
 * set so the next leaf in a batch sees the wallet's post-build state
 * instead of the same pre-mempool snapshot. Exported so unit tests can
 * exercise the parser directly against synthesized CBOR.
 *
 * Removes any UTxO whose `(txHash, outputIndex)` matches a tx input.
 * Adds any tx output whose `address` matches the wallet's change
 * address AND has no inline datum AND no script ref — that's the
 * shape mesh emits for wallet change in wallet-funded Mix mode.
 *
 * `cst` is passed in so the caller controls when the heavy
 * @meshsdk/core-cst module gets imported; we hoist that load to the
 * top of `planFanoutTxs` and reuse the handle across every leaf.
 */
export function chainWalletUtxosAfterBuild(
  current: ReadonlyArray<MeshUtxo>,
  unsignedTxHex: string,
  changeAddressBech32: string,
  cst: typeof import("@meshsdk/core-cst"),
): ChainWalletUtxosResult {
  const tx = cst.deserializeTx(unsignedTxHex);
  const txId = String(cst.resolveTxHash(unsignedTxHex)).toLowerCase();

  const consumedKeys = new Set<string>();
  for (const inp of tx.body().inputs().values()) {
    const hash = inp.transactionId().toString().toLowerCase();
    consumedKeys.add(`${hash}#${Number(inp.index())}`);
  }

  const rolling: MeshUtxo[] = current.filter((u) => {
    const k = `${u.input.txHash.toLowerCase()}#${u.input.outputIndex}`;
    return !consumedKeys.has(k);
  });

  // Collect change outputs in BOTH shapes:
  //   * MeshUtxo (pushed onto `rolling` so the next leaf's
  //     walletUtxosOverride picks them up for coin-selection).
  //   * lovejoin `Utxo` (returned separately as `inFlightChange` so
  //     the orchestrator can splice them into the next leaf's
  //     `chainFrom.utxos` — without that the evaluator can't resolve
  //     a wallet input that came from a previous leaf in the batch
  //     and the redeemers ship with placeholder ex units, which the
  //     chain rejects).
  const inFlightChange: Utxo[] = [];
  const outputs = tx.body().outputs();
  const changeAddressLower = changeAddressBech32.toLowerCase();
  for (let i = 0; i < outputs.length; i++) {
    const out = outputs[i]!;
    let outAddr: string;
    try {
      outAddr = out.address().toBech32();
    } catch {
      // Non-bech32 (byron, malformed); can't be a change output we
      // produced. Skip.
      continue;
    }
    if (outAddr.toLowerCase() !== changeAddressLower) continue;
    // Mix-box outputs always carry an inline datum; the fee shard
    // (irrelevant in wallet mode) also carries one. Wallet change is
    // datumless. Same goes for ref-script-bearing outputs.
    if (out.datum()) continue;
    if (out.scriptRef && out.scriptRef()) continue;

    const value = out.amount();
    const lovelace = value.coin();
    const amount: Array<{ unit: string; quantity: string }> = [
      { unit: "lovelace", quantity: lovelace.toString() },
    ];
    const assets: Record<string, bigint> = {};
    const multiAsset = value.multiasset();
    if (multiAsset && multiAsset.size > 0) {
      for (const [assetId, qty] of multiAsset.entries()) {
        const unit = assetId.toString();
        amount.push({ unit, quantity: qty.toString() });
        assets[unit] = (assets[unit] ?? 0n) + BigInt(qty.toString());
      }
    }

    rolling.push({
      input: { txHash: txId, outputIndex: i },
      output: { address: outAddr, amount },
    });
    inFlightChange.push({
      ref: { txId, outputIndex: i },
      address: outAddr,
      lovelace: BigInt(lovelace.toString()),
      assets,
      inlineDatum: null,
      referenceScript: null,
    });
  }

  return { rolling, inFlightChange, consumedKeys };
}

export interface SubmitFanoutBatchArgs {
  batch: UnsignedFanoutBatch;
  /** Wallet exposing CIP-103 `signTxs`. Probe via
   *  `detectBatchSigningCip103` before calling — this function does NOT
   *  re-probe and will throw at signTxs-call time on an unsupported
   *  wallet. */
  wallet: LovejoinWallet;
  provider: ChainProvider;
}

/**
 * Sign + submit a pre-built fan-out batch via CIP-103. Yields the same
 * FanoutEvent stream as `submitFanout` so the UI can reuse its progress
 * reducer.
 *
 * Flow:
 *
 *   1. Replay the planner's `slot-failed` events first so the UI
 *      sees build-time failures before submit-time progress (matches
 *      `submitFanout`'s ordering: a build failure in wave N fires
 *      before wave N's `wave-completed`).
 *   2. Call `wallet.signTxs(allUnsignedCbors, false)` ONCE. The wallet
 *      shows one CIP-30 prompt covering the whole tree; rejection
 *      throws and the entire batch is abandoned.
 *   3. Submit each signed CBOR in submission order. On a submit
 *      failure, cascade descendants to dropped (parent's outputs never
 *      land on chain so children can't resolve their refs) and emit
 *      one `slot-failed` event per failure.
 *
 * Wave-grouping events (`wave-started` / `wave-completed`) are
 * reconstructed from the batch slots' `waveIndex` so consumers that
 * count waves don't have to special-case the batch path.
 */
export async function* submitFanoutBatch(args: SubmitFanoutBatchArgs): AsyncIterable<FanoutEvent> {
  const { batch, wallet, provider } = args;
  if (!wallet.signTxs) {
    throw new Error(
      "submitFanoutBatch: wallet does not implement CIP-103 signTxs. " +
        "Probe via detectBatchSigningCip103 and fall back to submitFanout.",
    );
  }

  // Pre-compute wave grouping so wave-started / wave-completed events
  // line up with the per-leaf path. Build-failed slots are surfaced
  // BEFORE their wave's wave-completed event so the UI's reducer sees
  // the same order as the per-leaf path.
  const slotsByWave = new Map<number, UnsignedFanoutSlot[]>();
  const failedByWave = new Map<number, UnsignedFanoutBatch["failed"][number][]>();
  let maxWave = -1;
  for (const slot of batch.slots) {
    if (!slotsByWave.has(slot.waveIndex)) slotsByWave.set(slot.waveIndex, []);
    slotsByWave.get(slot.waveIndex)!.push(slot);
    if (slot.waveIndex > maxWave) maxWave = slot.waveIndex;
  }
  for (const f of batch.failed) {
    if (!failedByWave.has(f.waveIndex)) failedByWave.set(f.waveIndex, []);
    failedByWave.get(f.waveIndex)!.push(f);
    if (f.waveIndex > maxWave) maxWave = f.waveIndex;
  }

  // Batch sign. One prompt for the whole tree. If the wallet refuses,
  // the rejection bubbles up; partial recovery is the caller's call
  // (typically: re-plan from confirmed boxes and retry).
  const unsignedCbors = batch.slots.map((s) => s.unsignedTxHex);
  console.log(
    `[lovejoin/fanout] submitFanoutBatch: requesting CIP-103 signature on ${unsignedCbors.length} tx(s)`,
  );
  const signStart = Date.now();
  const signedCbors = unsignedCbors.length === 0 ? [] : await wallet.signTxs(unsignedCbors, false);
  console.log(`[lovejoin/fanout] wallet.signTxs returned in ${Date.now() - signStart}ms`);
  if (signedCbors.length !== unsignedCbors.length) {
    throw new Error(
      `submitFanoutBatch: wallet.signTxs returned ${signedCbors.length} signed txs; ` +
        `expected ${unsignedCbors.length}`,
    );
  }

  let submittedCount = 0;
  let failedCount = batch.failed.reduce((acc, f) => acc + f.droppedDescendants.length, 0);
  const dropped = new Set<FanoutSlotId>();
  for (const f of batch.failed) {
    for (const id of f.droppedDescendants) dropped.add(id);
  }

  for (let k = 0; k <= maxWave; k++) {
    const waveSlots = slotsByWave.get(k) ?? [];
    const waveFailed = failedByWave.get(k) ?? [];
    yield { kind: "wave-started", waveIndex: k, slotCount: waveSlots.length };

    const submittedThisWave: FanoutSlotId[] = [];
    const failedThisWave: FanoutSlotId[] = [];

    // Replay planner-time failures first so per-leaf and batch paths
    // emit slot-failed events in the same relative order.
    for (const f of waveFailed) {
      failedThisWave.push(f.slotId);
      yield {
        kind: "slot-failed",
        slotId: f.slotId,
        waveIndex: f.waveIndex,
        error: f.error,
        droppedDescendants: [...f.droppedDescendants],
      };
    }

    for (const slot of waveSlots) {
      if (dropped.has(slot.slotId)) continue;

      // Find this slot's signed CBOR by position in the batch (same
      // index as in batch.slots since we kept submission order).
      const idx = batch.slots.indexOf(slot);
      const signedCbor = signedCbors[idx]!;
      const slotStartMs = Date.now();
      let submittedTxId: string;
      try {
        submittedTxId = await provider.submitTx(signedCbor);
        console.log(
          `[lovejoin/fanout] slot ${slot.slotId} (wave ${k + 1}) submitted in ` +
            `${Date.now() - slotStartMs}ms — tx ${submittedTxId.slice(0, 12)}…`,
        );
      } catch (err) {
        const droppedList = fanoutDescendants(batch.plan, slot.slotId);
        for (const id of droppedList) dropped.add(id);
        failedCount += droppedList.length;
        failedThisWave.push(slot.slotId);
        console.warn(
          `[lovejoin/fanout] slot ${slot.slotId} (wave ${k + 1}) submitTx failed after ` +
            `${Date.now() - slotStartMs}ms`,
        );
        yield {
          kind: "slot-failed",
          slotId: slot.slotId,
          waveIndex: k,
          error: err instanceof Error ? err : new Error(String(err)),
          droppedDescendants: droppedList,
        };
        continue;
      }

      const result: MixResult = {
        signedTxHex: signedCbor,
        unsignedTxHex: slot.unsignedTxHex,
        txId: submittedTxId,
        plan: slot.plan,
        actualFeeLovelace: slot.actualFeeLovelace,
      };
      submittedCount += 1;
      submittedThisWave.push(slot.slotId);
      yield {
        kind: "slot-submitted",
        slotId: slot.slotId,
        waveIndex: k,
        txId: submittedTxId,
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
