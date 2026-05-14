// Fan-out Mix strategy planner — issue #137.
//
// Lays out a depth-k tree of N=3 Mix transactions for a single owned root
// mix-box. After a deposit lands, the user can amplify their privacy by
// running waves of 3-ary mixes:
//
//   wave 0 (depth=1):  1 mix,  3 boxes touched
//   wave 1 (depth=2):  3 mixes, 9 boxes touched
//   wave 2 (depth=3):  9 mixes, 27 boxes touched
//   wave 3 (depth=4): 27 mixes, 81 boxes touched
//
// Total mixes  = (3^k − 1) / 2.
// Boxes touched = 3^k.
// Per-mix linkage probability is 1/3, so after k waves the user's branch is
// indistinguishable from 3^k branches under (1/3)^k linkage.
//
// **Why all-branches, not just the user's.** The privacy property only
// holds if EVERY box touched in the previous wave is re-mixed in this
// wave, not just the box that came from the user's own deposit. Mixing
// only the slot the user "owns" leaves a single chain an observer can
// trivially follow. Re-mixing all 3 wave-1 outputs (and all 9 wave-2
// outputs, etc.) is what makes the user's branch one of 3^k.
//
// The user pays fees + proof-construction cost for the other branches,
// in exchange for indistinguishability. The UI surfaces this trade in
// the disclosure copy.
//
// ## What the planner does
//
// `planFanout(args) → FanoutPlan` lays out the SHAPE of the tree. It is
// pure: no chain access, no MixPlan computation (output a'/b' depend on
// the parent's on-chain txid, which we don't know until the previous
// wave is built — so the orchestrator materialises one wave at a time
// from the parent's MixResult).
//
// The planner's responsibilities:
//   1. Validate inputs: `2 ≤ depth ≤ FANOUT_MAX_DEPTH`, root box is
//      a valid pool entry, pool has enough fresh boxes.
//   2. Pre-sample fresh pool boxes upfront — `2 × wavesize` per wave —
//      tracking an exclude-set that grows as the plan is built so no
//      box is reused across waves.
//   3. Build the slot tree: each wave has `3^waveIndex` slots; each
//      slot has 3 inputs (one parent output position + two fresh pool
//      boxes for wave > 0; the root + two fresh for wave 0).
//
// The planner does NOT pick fee shards. Shards are picked at submit
// time by the orchestrator via `pickRandomFeeShard` with rolling
// exclude/extras tracking so two parallel mixes in the same wave can't
// claim the same shard and a post-state shard from wave N is available
// to wave N+1.
//
// ## Slot identity
//
// Slots are addressed by string IDs of the form `w<wave>s<slot>`:
//   wave 0:  w0s0
//   wave 1:  w1s0, w1s1, w1s2
//   wave 2:  w2s0 ... w2s8
//
// For wave > 0, slot N's parent is slot `floor(N/3)` of the previous wave,
// and N % 3 is the parent's output position the slot inherits. That
// scheme means walking the tree by parent-link is `O(slot_count)` and
// the orchestrator's rollback-cascade can be computed in one pass.
//
// ## Cap on depth
//
// The planner clamps `depth` to `FANOUT_MAX_DEPTH`. The depth-3 default
// is the validated UX (linkage `(1/3)^3 ≈ 3.7%`); depth-4 is gated to
// power users at the UI level. We don't allow higher in the SDK either:
// depth-5 would mean 81 mixes / 243 boxes touched, the fee-shard pool
// can't realistically replenish that fast on a normal deposit rate, and
// the additional anonymity gain over depth-4 is marginal `(1/3)^5 ≈
// 0.4%` vs `(1/3)^4 ≈ 1.2%`. The cap is a guardrail, not a privacy
// claim — lift it by editing this constant.
//
// Spec / issue: see issue #137 and the disclosure-UX bullet ("you are
// paying fees to mix boxes you don't own").

import { cryptoRandomInt, type RandomInt } from "../tx/fee.js";
import { pickRandomNTuple } from "../pool/select.js";
import type { PoolEntry } from "../pool/identify.js";
import type { UtxoRef } from "../chain/provider.js";

/** Fan-out tree width. Issue #137 only sanctions N=3 — see header. */
export const FANOUT_N = 3 as const;

/** Hard cap on tree depth. See header for the rationale. */
export const FANOUT_MAX_DEPTH = 4 as const;

/**
 * Stable identifier for a slot in the tree. Format: `w<wave>s<slot>`,
 * for example `w0s0`, `w1s2`, `w2s7`. Used by descendant slots to
 * reference their parent's output position.
 */
export type FanoutSlotId = `w${number}s${number}`;

/**
 * One of the three inputs to a fan-out mix slot.
 *
 *   * `pool` — a freshly-sampled pool entry, never touched by this plan
 *     before. The orchestrator passes the entry's PoolEntry straight
 *     into `buildMixTx.inputs`.
 *
 *   * `parent` — an output of a previous wave's slot. The orchestrator
 *     materialises this from the parent's `MixResult` at submit time
 *     (the parent's txid + the recorded output position + the plan's
 *     output a' / b' pair give a fully-resolved UTxO).
 *
 *   * `root` — the user's own seed box. Appears exactly once across the
 *     whole plan, as one of wave 0's three inputs.
 */
export type FanoutInputDescriptor =
  | { kind: "pool"; entry: PoolEntry }
  | { kind: "root"; entry: PoolEntry }
  | {
      kind: "parent";
      parentSlotId: FanoutSlotId;
      /** Output position 0..N-1 of the parent slot. */
      parentOutputPosition: number;
    };

/** One Mix tx in the fan-out tree. */
export interface FanoutSlot {
  id: FanoutSlotId;
  waveIndex: number;
  slotIndex: number;
  /** Three inputs in the slot's natural order (NOT lex-sorted; the SDK
   *  sorts inside `planMixTx`). */
  inputs: FanoutInputDescriptor[];
}

export interface FanoutWave {
  waveIndex: number;
  /** Length `3^waveIndex`. */
  slots: FanoutSlot[];
}

export interface FanoutPlan {
  /** Always `FANOUT_N`. Surfaced so callers can read it without an import. */
  n: number;
  /** Tree depth — same as `waves.length`. `2 ≤ depth ≤ FANOUT_MAX_DEPTH`. */
  depth: number;
  /** The user's seed box — appears as `kind: "root"` in wave 0, slot 0. */
  rootBox: PoolEntry;
  /** Length `depth`. waves[k].slots has `3^k` entries. */
  waves: FanoutWave[];
  /** Every fresh pool ref the plan touches (excludes root). */
  poolRefsUsed: ReadonlyArray<UtxoRef>;
  /** Total tx count = (3^depth − 1) / 2. */
  totalMixes: number;
  /** Boxes touched (including root) = 3^depth. */
  boxesTouched: number;
}

export interface PlanFanoutArgs {
  rootBox: PoolEntry;
  /** Live pool entries to draw fresh inputs from. Must not include root. */
  pool: ReadonlyArray<PoolEntry>;
  /** `2 ≤ depth ≤ FANOUT_MAX_DEPTH`. */
  depth: number;
  /**
   * Refs to exclude from the fresh-pool sampler. Typically the union of:
   *   * pool entries known to be in-mempool inputs to other users' txs
   *     (from the backend's `/mempool/inputs`);
   *   * the caller's own locally-tracked in-flight refs.
   *
   * The root box's ref is excluded automatically — callers don't need to
   * pre-filter that.
   */
  excludeRefs?: ReadonlyArray<UtxoRef>;
  /** Optional deterministic RNG for tests. Default: WebCrypto. */
  rng?: RandomInt;
}

/**
 * Lay out a depth-k fan-out Mix plan.
 *
 * Pure function: no chain access, no proof generation. Tests can pin the
 * pool order + RNG and get a reproducible plan.
 *
 * @throws if `depth` is out of range, the root box ref appears in the
 *   pool, or the pool can't supply enough fresh boxes.
 */
export function planFanout(args: PlanFanoutArgs): FanoutPlan {
  if (!Number.isInteger(args.depth)) {
    throw new Error(`planFanout: depth must be an integer, got ${args.depth}`);
  }
  if (args.depth < 2 || args.depth > FANOUT_MAX_DEPTH) {
    throw new Error(
      `planFanout: depth must be in [2, ${FANOUT_MAX_DEPTH}], got ${args.depth} ` +
        `(see FANOUT_MAX_DEPTH for the rationale)`,
    );
  }

  const rootKey = refKey(args.rootBox.ref);
  const dedupedExcludes = new Set<string>([rootKey]);
  for (const r of args.excludeRefs ?? []) dedupedExcludes.add(refKey(r));

  // Per-wave pool requirement: 3^k slots × 2 fresh boxes each.
  const perWaveFresh: number[] = [];
  let totalFresh = 0;
  for (let k = 0; k < args.depth; k++) {
    const need = pow3(k) * 2;
    perWaveFresh.push(need);
    totalFresh += need;
  }

  // Pre-flight: do we have enough fresh boxes for the whole plan?
  const eligibleCount = args.pool.reduce(
    (a, e) => (dedupedExcludes.has(refKey(e.ref)) ? a : a + 1),
    0,
  );
  if (eligibleCount < totalFresh) {
    throw new Error(
      `planFanout: pool has ${eligibleCount} fresh boxes after exclusions, ` +
        `need ${totalFresh} for depth=${args.depth}`,
    );
  }

  const rng = args.rng ?? cryptoRandomInt;
  // Maintain a single growing exclude-set across waves so wave N never
  // re-samples a box wave M (M<N) already claimed.
  const usedRefs = new Set<string>(dedupedExcludes);
  const poolRefsUsed: UtxoRef[] = [];

  const waves: FanoutWave[] = [];
  for (let k = 0; k < args.depth; k++) {
    const slotCount = pow3(k);
    const freshNeeded = perWaveFresh[k]!;
    const excludeRefs = Array.from(usedRefs).map(parseRefKey);
    const fresh = pickRandomNTuple({
      pool: args.pool,
      n: freshNeeded,
      excludeRefs,
      rng,
    });
    if (fresh.length !== freshNeeded) {
      // Belt-and-braces: the pre-flight check above already gates this,
      // but guard the slicing logic below in case the caller mutates the
      // pool between the check and the sample.
      throw new Error(
        `planFanout: wave ${k} sampler returned ${fresh.length} entries, expected ${freshNeeded}`,
      );
    }
    for (const f of fresh) {
      usedRefs.add(refKey(f.ref));
      poolRefsUsed.push(f.ref);
    }

    const slots: FanoutSlot[] = [];
    for (let s = 0; s < slotCount; s++) {
      const id: FanoutSlotId = `w${k}s${s}`;
      const inputs: FanoutInputDescriptor[] = [];
      if (k === 0) {
        // Wave 0, slot 0: the user's root box + two fresh.
        inputs.push({ kind: "root", entry: args.rootBox });
      } else {
        // Wave k>0, slot s: parent is slot floor(s/N) of wave k-1; the
        // output position to inherit is s % N. This mapping is the
        // tree's branching factor — each parent has exactly N children,
        // one per output position.
        const parentSlotIndex = Math.floor(s / FANOUT_N);
        const parentOutputPosition = s % FANOUT_N;
        const parentId: FanoutSlotId = `w${k - 1}s${parentSlotIndex}`;
        inputs.push({
          kind: "parent",
          parentSlotId: parentId,
          parentOutputPosition,
        });
      }
      // Two fresh boxes. The first slot uses fresh[0], fresh[1]; second
      // uses fresh[2], fresh[3]; ... so we slice from the wave's fresh
      // pool in slot order.
      const baseFresh = s * 2;
      inputs.push({ kind: "pool", entry: fresh[baseFresh]! });
      inputs.push({ kind: "pool", entry: fresh[baseFresh + 1]! });
      slots.push({ id, waveIndex: k, slotIndex: s, inputs });
    }

    waves.push({ waveIndex: k, slots });
  }

  return {
    n: FANOUT_N,
    depth: args.depth,
    rootBox: args.rootBox,
    waves,
    poolRefsUsed,
    totalMixes: (pow3(args.depth) - 1) / 2,
    boxesTouched: pow3(args.depth),
  };
}

/**
 * Walk descendant slots of a given slot id (inclusive). Used by the
 * orchestrator's rollback handler: if a parent fails, every descendant
 * is invalid and the caller must drop them all from the submission
 * queue.
 *
 * Returns IDs in BFS order so the immediate children come before
 * grandchildren — a `BranchDropped` event can describe the cascade
 * level-by-level.
 */
export function fanoutDescendants(plan: FanoutPlan, rootSlotId: FanoutSlotId): FanoutSlotId[] {
  // Build a parent → children map once. Plans are small (≤ 121 slots at
  // depth 4) so this is cheap.
  const byParent = new Map<FanoutSlotId, FanoutSlotId[]>();
  for (let k = 1; k < plan.waves.length; k++) {
    const wave = plan.waves[k]!;
    for (const slot of wave.slots) {
      for (const inp of slot.inputs) {
        if (inp.kind === "parent") {
          const arr = byParent.get(inp.parentSlotId);
          if (arr) arr.push(slot.id);
          else byParent.set(inp.parentSlotId, [slot.id]);
        }
      }
    }
  }
  const out: FanoutSlotId[] = [];
  const queue: FanoutSlotId[] = [rootSlotId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    out.push(cur);
    const kids = byParent.get(cur);
    if (kids) queue.push(...kids);
  }
  return out;
}

/**
 * Locate a slot by id. O(1) after computing `(wave, slot)` from the
 * naming convention — no map lookup needed.
 */
export function getSlot(plan: FanoutPlan, id: FanoutSlotId): FanoutSlot {
  const parsed = parseSlotId(id);
  if (parsed.wave < 0 || parsed.wave >= plan.waves.length) {
    throw new Error(`getSlot: wave ${parsed.wave} out of range for plan of depth ${plan.depth}`);
  }
  const wave = plan.waves[parsed.wave]!;
  if (parsed.slot < 0 || parsed.slot >= wave.slots.length) {
    throw new Error(`getSlot: slot ${parsed.slot} out of range for wave ${parsed.wave}`);
  }
  return wave.slots[parsed.slot]!;
}

/** Linkage probability after a depth-k fan-out: `(1/3)^k`. */
export function fanoutLinkageProbability(depth: number): number {
  return 1 / pow3(depth);
}

/** `(3^k − 1) / 2`. */
export function fanoutTotalMixes(depth: number): number {
  return (pow3(depth) - 1) / 2;
}

/** `3^k`. */
export function fanoutBoxesTouched(depth: number): number {
  return pow3(depth);
}

// ---------------------------------------------------------------------------
// Local utilities
// ---------------------------------------------------------------------------

function pow3(k: number): number {
  let r = 1;
  for (let i = 0; i < k; i++) r *= FANOUT_N;
  return r;
}

function refKey(ref: UtxoRef): string {
  return `${ref.txId.toLowerCase()}#${ref.outputIndex}`;
}

function parseRefKey(key: string): UtxoRef {
  const hash = key.indexOf("#");
  if (hash <= 0) {
    throw new Error(`parseRefKey: malformed key "${key}"`);
  }
  const idx = Number(key.slice(hash + 1));
  if (!Number.isInteger(idx) || idx < 0) {
    throw new Error(`parseRefKey: bad output index in "${key}"`);
  }
  return { txId: key.slice(0, hash), outputIndex: idx };
}

function parseSlotId(id: FanoutSlotId): { wave: number; slot: number } {
  const m = /^w(\d+)s(\d+)$/.exec(id);
  if (!m) throw new Error(`parseSlotId: not a slot id: "${id}"`);
  return { wave: Number(m[1]), slot: Number(m[2]) };
}
