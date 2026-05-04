// Composite indexer state — pool, fee shards, reference UTxO, plus a
// rolling buffer of recent block diffs for rollback recovery.
//
// Spec: docs/spec/05-backend.md §"Indexer", §"Rollback handling".
//
// Design:
//   - The chainsync emits forward / backward events. Forward events
//     carry a `BlockDiff` that the state applies to its three sub-models
//     (pool, fee, reference). Each forward apply pushes the diff onto a
//     rolling buffer (ROLLBACK_BUFFER_BLOCKS deep).
//   - On a rollback to a known point, we pop diffs off the buffer and
//     reverse them in LIFO order until we hit the target tip. If the
//     target is older than the buffer's bottom, we surface a recoverable
//     "deep-rollback" error and the runtime restarts the sync from
//     genesis (or a snapshot).
//   - State is immutable from the outside — callers read snapshots via
//     accessor methods. Apply / rollback are the only mutators.
//
// We deliberately do NOT cache pre-derived JSON blobs for the API (e.g.
// the `/pool` payload). At <100k boxes the JSON.stringify cost is well
// under 100ms (the spec's p99 target) and the simpler invariant — one
// source of truth, recomputed on read — is worth the slight extra CPU.

import type { LovejoinAddresses } from "../config.js";
import { tryDecodeMixDatum, bytesToHex } from "./datum.js";
import type {
  BlockDiff,
  ChainTip,
  FeeShard,
  FeeStateSnapshot,
  PoolEntry,
  ProducedUtxo,
  UtxoKey,
  UtxoRef,
} from "./types.js";
import { utxoKey } from "./types.js";

/**
 * Spec target: tolerate "500-block rollback" (M5 exit criterion). 2k
 * gives us 4x headroom and matches the spec's "last 2k blocks" guidance
 * in 05-backend.md §"Rollback handling".
 */
export const ROLLBACK_BUFFER_BLOCKS = 2000;

/** A snapshot of the full indexer state at a point in time. */
export interface StateSnapshot {
  tip: ChainTip | null;
  pool: PoolEntry[];
  fee: FeeStateSnapshot;
  /** True if we have ever observed the reference UTxO. */
  referenceUtxoOk: boolean;
  /** When set, the indexer is in alarm mode (reference UTxO disappeared). */
  referenceAlarm: string | null;
}

/** Filtering hooks the chainsync uses to decide what to forward. */
export interface AddressFilter {
  mixBoxAddress: string;
  feeContractAddress: string;
  /** The reference NFT's `<policy><asset_name>` unit. */
  referenceNftUnit: string;
}

/**
 * Bulk snapshot used to prime the indexer at cold start (or to recover
 * from a deep rollback past the reverse buffer). All UTxOs are live as
 * of `tip`; the rollback buffer is empty after a prime, so any
 * subsequent rollback to a point before `tip` re-triggers the prime
 * path via `DeepRollbackError`.
 */
export interface PrimeSnapshot {
  tip: ChainTip;
  /**
   * Live mix-box UTxOs at `tip`. Each entry's `inlineDatumHex` is the
   * raw chain CBOR (the prime code does not re-encode); entries with
   * unparseable / missing datums are silently skipped to mirror the
   * forward-apply path's tolerance for malformed boxes.
   */
  mixBoxUtxos: ProducedUtxo[];
  /** Live fee-contract UTxOs at `tip`. */
  feeShardUtxos: ProducedUtxo[];
  /** Reference NFT carrier, if observable; null surfaces as alarm. */
  referenceUtxo: ProducedUtxo | null;
}

/**
 * The unrecoverable rollback signal — thrown by `applyRollback` when the
 * target is older than the buffer can reach. The runtime should respond
 * by restarting chainsync from a fresh starting point.
 */
export class DeepRollbackError extends Error {
  readonly bufferOldestSlot: number | null;
  readonly targetSlot: number;
  constructor(targetSlot: number, bufferOldestSlot: number | null) {
    super(
      `deep rollback: target slot ${targetSlot} older than buffer's oldest ${bufferOldestSlot ?? "(empty)"}`,
    );
    this.bufferOldestSlot = bufferOldestSlot;
    this.targetSlot = targetSlot;
    this.name = "DeepRollbackError";
  }
}

export class IndexerState {
  private readonly pool = new Map<UtxoKey, PoolEntry>();
  private readonly feeShards = new Map<UtxoKey, FeeShard>();

  /**
   * The reference UTxO is immutable post-bootstrap: a single UTxO at
   * `referenceHolder` carrying the NFT. We track it by ref so we can
   * detect "it disappeared" (alarm) and restore on rollback.
   */
  private referenceRef: UtxoRef | null = null;
  private referenceAlarm: string | null = null;

  private tip_: ChainTip | null = null;
  /** LIFO of recent block diffs for rollback. Newest at the end. */
  private readonly buffer: BlockDiff[] = [];

  /** Snapshots of state needed to *reverse* a forward apply. */
  private readonly reverse: ReverseSnapshot[] = [];

  /**
   * Per-box generation counter. Incremented every time a Mix tx
   * consumes a mix-box and produces a fresh one in the same block. We
   * derive it as `max(generation of consumed mix-inputs) + 1`.
   *
   * UI-only metric: privacy budget `(1/N)^k` after `k` mixes.
   */
  constructor(
    private readonly addresses: LovejoinAddresses,
    private readonly filter: AddressFilter,
    private readonly maxFeePerMixLovelace: bigint,
  ) {}

  get tip(): ChainTip | null {
    return this.tip_;
  }

  /**
   * Apply one block. The runtime is expected to have already filtered
   * the diff to relevant addresses (mix_box, fee_contract, reference
   * holder); `applyForward` does no extra filtering.
   *
   * Throws if the diff would re-introduce a box already in the pool —
   * that would mean the chainsync emitted the same UTxO twice and is a
   * bug worth surfacing loudly (rather than silently masking).
   */
  applyForward(diff: BlockDiff): void {
    const reverse: ReverseSnapshot = {
      blockHash: diff.blockHash,
      addedPool: [],
      removedPool: [],
      addedFee: [],
      removedFee: [],
      referenceBefore: this.referenceRef,
      alarmBefore: this.referenceAlarm,
    };

    // First pass: figure out the generation each new mix-box should get,
    // by looking at the consumed mix-boxes the same block.
    let inputGenMax = -1;
    for (const consumed of diff.consumed) {
      const k = utxoKey(consumed);
      const existing = this.pool.get(k);
      if (existing && existing.generation > inputGenMax) {
        inputGenMax = existing.generation;
      }
    }
    const childGeneration = inputGenMax >= 0 ? inputGenMax + 1 : 0;

    // Apply removals first (so a tx that consumes + produces at the
    // same address doesn't accidentally clobber the new entry).
    for (const consumed of diff.consumed) {
      const k = utxoKey(consumed);
      const poolEntry = this.pool.get(k);
      if (poolEntry) {
        reverse.removedPool.push(poolEntry);
        this.pool.delete(k);
      }
      const feeEntry = this.feeShards.get(k);
      if (feeEntry) {
        reverse.removedFee.push(feeEntry);
        this.feeShards.delete(k);
      }
      // Reference UTxO consumed → alarm (validator is False; this should
      // never happen unless the chain is corrupt or the ref hash drifted).
      if (
        this.referenceRef &&
        this.referenceRef.txId === consumed.txId &&
        this.referenceRef.outputIndex === consumed.outputIndex
      ) {
        reverse.referenceBefore = this.referenceRef;
        this.referenceRef = null;
        this.referenceAlarm = `reference UTxO ${k} consumed at slot ${diff.slot}`;
      }
    }

    // Apply additions.
    for (const produced of diff.produced) {
      const k = utxoKey(produced.ref);
      if (produced.address === this.filter.mixBoxAddress) {
        if (this.pool.has(k)) {
          throw new Error(
            `pool: duplicate produced mix-box ${k} — chainsync should not emit twice`,
          );
        }
        const poolEntry = parsePoolEntry(produced, diff.slot, childGeneration);
        if (poolEntry) {
          this.pool.set(k, poolEntry);
          reverse.addedPool.push(k);
        }
      } else if (produced.address === this.filter.feeContractAddress) {
        if (this.feeShards.has(k)) {
          throw new Error(
            `fee: duplicate produced fee shard ${k} — chainsync should not emit twice`,
          );
        }
        this.feeShards.set(k, {
          txHash: produced.ref.txId,
          outputIndex: produced.ref.outputIndex,
          lovelace: produced.lovelace,
          slot: diff.slot,
          inlineDatumHex: produced.inlineDatumHex,
        });
        reverse.addedFee.push(k);
      } else if (produced.assets[this.filter.referenceNftUnit] === 1n) {
        // The reference UTxO is parked at the reference_holder address;
        // its identity is "the unique UTxO carrying the NFT". We don't
        // require the address to match because the reference_holder
        // address can be a mainnet/testnet variant we haven't
        // pre-computed if NETWORK is misconfigured — the NFT-carrying
        // UTxO is still the one we want.
        this.referenceRef = produced.ref;
        if (this.referenceAlarm !== null) {
          // Alarm clears once we observe the NFT again (e.g. after a
          // rollback that re-inserts the reference UTxO).
          this.referenceAlarm = null;
        }
      }
    }

    this.reverse.push(reverse);
    this.buffer.push(diff);
    while (this.buffer.length > ROLLBACK_BUFFER_BLOCKS) {
      this.buffer.shift();
      this.reverse.shift();
    }
    this.tip_ = { slot: diff.slot, blockHash: diff.blockHash, height: diff.height };
  }

  /**
   * Replace the entire state with a bulk snapshot at `snapshot.tip` —
   * the cold-start prime path (issue #87) and the deep-rollback
   * recovery path. After a prime:
   *
   *   - The rollback buffer is empty. Forward applies after this point
   *     repopulate it; rollbacks to a point before `snapshot.tip` will
   *     surface as `DeepRollbackError` and the runtime is expected to
   *     reprime in-process.
   *   - Each pool entry's `generation` is reset to 0. Generation is a
   *     UI-only metric derived from forward replay (max parent + 1);
   *     the prime drops history because db-sync doesn't persist it.
   *     Operators see the privacy-budget counter restart on a primed
   *     deploy, which is acceptable per the spec's "metric only" framing.
   *   - A null `referenceUtxo` raises the alarm (mirroring the spec's
   *     "reference UTxO disappeared" handling). A primed entry clears
   *     any pre-existing alarm.
   */
  primeFrom(snapshot: PrimeSnapshot): void {
    this.pool.clear();
    this.feeShards.clear();
    this.buffer.length = 0;
    this.reverse.length = 0;
    this.referenceRef = null;
    this.referenceAlarm = null;
    this.tip_ = snapshot.tip;
    for (const produced of snapshot.mixBoxUtxos) {
      const k = utxoKey(produced.ref);
      const entry = parsePoolEntry(produced, snapshot.tip.slot, 0);
      if (entry) this.pool.set(k, entry);
    }
    for (const produced of snapshot.feeShardUtxos) {
      const k = utxoKey(produced.ref);
      this.feeShards.set(k, {
        txHash: produced.ref.txId,
        outputIndex: produced.ref.outputIndex,
        lovelace: produced.lovelace,
        slot: snapshot.tip.slot,
        inlineDatumHex: produced.inlineDatumHex,
      });
    }
    if (snapshot.referenceUtxo) {
      this.referenceRef = snapshot.referenceUtxo.ref;
    } else {
      this.referenceAlarm = `prime: reference NFT not observable at slot ${snapshot.tip.slot}`;
    }
  }

  /**
   * Roll back to a given chain point. The argument is the *new tip*
   * after the rollback (ogmios's `RollBackward` semantics). We unwind
   * buffered diffs in LIFO order until the live tip matches the target,
   * or until the buffer is exhausted.
   *
   * Three outcomes:
   *   1. Target is the current tip: no-op.
   *   2. Target is somewhere in the buffer: unwind to it.
   *   3. Target is older than the buffer's bottom: throw
   *      `DeepRollbackError`. The runtime is expected to re-sync from a
   *      safe earlier intersection point (or genesis).
   */
  applyRollback(targetTip: ChainTip): void {
    if (this.tip_ && this.tip_.blockHash === targetTip.blockHash) {
      // Already at the target — nothing to do.
      this.tip_ = targetTip;
      return;
    }
    const targetInBuffer = this.buffer.some(
      (b) => b.blockHash === targetTip.blockHash && b.height === targetTip.height,
    );
    const oldestBuffered = this.buffer[0];
    if (!targetInBuffer && oldestBuffered && targetTip.height < oldestBuffered.height) {
      throw new DeepRollbackError(targetTip.slot, oldestBuffered.slot);
    }
    while (this.buffer.length > 0) {
      const top = this.buffer[this.buffer.length - 1]!;
      if (top.blockHash === targetTip.blockHash && top.height === targetTip.height) {
        this.tip_ = targetTip;
        return;
      }
      this.unwindLast();
      if (!targetInBuffer) break;
    }
    // If the target wasn't in the buffer we treat the rollback as a
    // hard reset — caller needs to re-sync. Set tip to the requested
    // value so ogmios's "Find intersection" round-trip can pick up from
    // there.
    this.tip_ = targetTip;
  }

  /** Unwind the most recently applied block. */
  private unwindLast(): void {
    const reverse = this.reverse.pop();
    const block = this.buffer.pop();
    if (!reverse || !block) return;
    for (const k of reverse.addedPool) this.pool.delete(k);
    for (const k of reverse.addedFee) this.feeShards.delete(k);
    for (const entry of reverse.removedPool) {
      this.pool.set(utxoKey({ txId: entry.txHash, outputIndex: entry.outputIndex }), entry);
    }
    for (const entry of reverse.removedFee) {
      this.feeShards.set(utxoKey({ txId: entry.txHash, outputIndex: entry.outputIndex }), entry);
    }
    this.referenceRef = reverse.referenceBefore;
    this.referenceAlarm = reverse.alarmBefore;

    // Update tip to the block-before-this-one. If buffer is empty, tip
    // becomes null (caller is expected to handle that by restarting the
    // sync).
    const previous = this.buffer[this.buffer.length - 1];
    this.tip_ = previous
      ? { slot: previous.slot, blockHash: previous.blockHash, height: previous.height }
      : null;
  }

  // ---- read APIs (immutable views) ----

  snapshot(): StateSnapshot {
    return {
      tip: this.tip_,
      pool: this.pool_().slice(),
      fee: this.feeSnapshot(),
      referenceUtxoOk: this.referenceRef !== null,
      referenceAlarm: this.referenceAlarm,
    };
  }

  poolSize(): number {
    return this.pool.size;
  }

  pool_(): PoolEntry[] {
    return Array.from(this.pool.values());
  }

  poolPage(cursor: number, limit: number): { rows: PoolEntry[]; nextCursor: number | null } {
    const all = this.pool_();
    const slice = all.slice(cursor, cursor + limit);
    const nextCursor = cursor + slice.length < all.length ? cursor + slice.length : null;
    return { rows: slice, nextCursor };
  }

  poolGet(ref: UtxoRef): PoolEntry | null {
    return this.pool.get(utxoKey(ref)) ?? null;
  }

  feeSnapshot(): FeeStateSnapshot {
    const shards = Array.from(this.feeShards.values());
    let total = 0n;
    for (const s of shards) total += s.lovelace;
    const estimated =
      this.maxFeePerMixLovelace === 0n ? 0 : Number(total / this.maxFeePerMixLovelace);
    return {
      shards,
      totalLovelace: total,
      estimatedMixesAvailable: estimated,
    };
  }

  referenceUtxoRef(): UtxoRef | null {
    return this.referenceRef;
  }

  /**
   * Union of every UTxO key (`${txId}#${index}`) the protocol cares
   * about: live mix-boxes + live fee shards. The mempool poller uses
   * this to drop input refs that aren't relevant to Lovejoin (~99% of
   * mempool traffic on a busy chain). Callers shouldn't mutate the
   * returned set; it's a fresh snapshot each call.
   */
  protocolRelevantUtxoKeys(): Set<UtxoKey> {
    const keys = new Set<UtxoKey>();
    for (const k of this.pool.keys()) keys.add(k);
    for (const k of this.feeShards.keys()) keys.add(k);
    return keys;
  }

  alarm(): string | null {
    return this.referenceAlarm;
  }

  /** For tests / introspection: the current rollback buffer depth. */
  bufferDepth(): number {
    return this.buffer.length;
  }
}

interface ReverseSnapshot {
  blockHash: string;
  addedPool: UtxoKey[];
  removedPool: PoolEntry[];
  addedFee: UtxoKey[];
  removedFee: FeeShard[];
  referenceBefore: UtxoRef | null;
  alarmBefore: string | null;
}

function parsePoolEntry(
  produced: ProducedUtxo,
  slot: number,
  generation: number,
): PoolEntry | null {
  if (!produced.inlineDatumHex) return null;
  const decoded = tryDecodeMixDatum(produced.inlineDatumHex);
  if (!decoded) return null;
  return {
    txHash: produced.ref.txId,
    outputIndex: produced.ref.outputIndex,
    a: bytesToHex(decoded.a),
    b: bytesToHex(decoded.b),
    slot,
    generation,
    inlineDatumHex: produced.inlineDatumHex,
    lovelace: produced.lovelace,
  };
}
