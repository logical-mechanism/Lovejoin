// Mempool poller. Periodically acquires the cardano-node's mempool
// snapshot via Ogmios, walks every tx, and stores the union of all
// input refs in memory. The API server reads from this in-memory set
// to answer `/mempool/inputs`, which UI clients use for mempool-aware
// fee-shard picking (and pool-box picking on mix).
//
// Spec context: docs/spec/05-backend.md §"Mempool awareness". The
// mempool view is the cardano-node's view, so it sees every tx
// propagated through the network's gossip layer regardless of which
// submission endpoint produced it. Lag between submit and visibility
// is sub-second in practice.

import type { OgmiosTxClient } from "./ogmios-tx.js";

/**
 * Logging surface. Two overloads so a pino instance (`info(obj, msg)`)
 * and a plain console-style logger (`info(msg)`) both satisfy the
 * interface; the poller itself only ever calls the string-only form.
 */
export interface MempoolLogger {
  info(obj: object, msg?: string): void;
  info(msg: string): void;
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
}

export interface MempoolPollerConfig {
  client: OgmiosTxClient;
  /** Interval between snapshots, in ms. Default 2000. */
  intervalMs?: number;
  /**
   * Optional relevance filter. When set, the poller drops every
   * mempool input ref that isn't in the returned set. Typical wiring
   * is `() => indexerState.protocolRelevantUtxoKeys()` so we only
   * track refs that point at live Lovejoin UTxOs (mix-boxes and fee
   * shards). On a busy chain this drops ~99% of mempool traffic.
   *
   * Without it, every mempool input ref is stored — fine for testing
   * or small environments, wasteful at scale.
   */
  relevantRefs?: () => ReadonlySet<InputRefKey>;
  logger: MempoolLogger;
}

/** A single input ref `${txId}#${outputIndex}` lower-cased. */
export type InputRefKey = string;

export interface MempoolSnapshot {
  /** Slot the most recent snapshot was acquired at; 0 before first poll. */
  slot: number;
  /** When the snapshot was last refreshed, in epoch ms. */
  acquiredAtMs: number;
  /** Union of all input refs across all mempool txs. */
  inputs: ReadonlySet<InputRefKey>;
  /** How many txs were in the snapshot. */
  txCount: number;
}

const EMPTY_SNAPSHOT: MempoolSnapshot = {
  slot: 0,
  acquiredAtMs: 0,
  inputs: new Set(),
  txCount: 0,
};

/**
 * Compose a canonical input-ref key.
 */
export function inputRefKey(txId: string, outputIndex: number): InputRefKey {
  return `${txId.toLowerCase()}#${outputIndex}`;
}

/**
 * Periodically poll the ogmios mempool. Owns no chain state; just
 * mirrors the snapshot into an in-memory set the API can read.
 */
export class MempoolPoller {
  private snapshot_: MempoolSnapshot = EMPTY_SNAPSHOT;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly config: MempoolPollerConfig) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
    this.config.logger.info(
      `mempool poller started (interval ${this.config.intervalMs ?? 2000}ms)`,
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        /* swallow on shutdown */
      }
    }
  }

  /** Latest mempool snapshot. Returns the empty snapshot before first poll. */
  snapshot(): MempoolSnapshot {
    return this.snapshot_;
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.poll().catch((err) => {
        this.config.logger.warn(
          `mempool poll failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      void this.inFlight.finally(() => {
        this.inFlight = null;
        this.scheduleNext(this.config.intervalMs ?? 2000);
      });
    }, delayMs);
  }

  private async poll(): Promise<void> {
    const slot = await this.config.client.acquireMempool();
    const inputs = new Set<InputRefKey>();
    // Snapshot the relevance filter once per poll. Re-querying it
    // inside the inner loop would be safe (it's an O(1) Set view) but
    // chaining the call chain through `tx.inputs.length × txCount`
    // calls is needless work on busy chains.
    const relevant = this.config.relevantRefs?.();
    let txCount = 0;
    try {
      while (true) {
        const tx = await this.config.client.nextMempoolTransaction();
        if (!tx) break;
        txCount += 1;
        for (const inp of tx.inputs) {
          const key = inputRefKey(inp.transaction.id, inp.index);
          if (relevant && !relevant.has(key)) continue;
          inputs.add(key);
        }
      }
    } finally {
      // Always release, even if we bailed mid-walk; ogmios pins the
      // snapshot until released and we don't want to leak it.
      try {
        await this.config.client.releaseMempool();
      } catch {
        /* same: swallow */
      }
    }
    this.snapshot_ = {
      slot,
      acquiredAtMs: Date.now(),
      inputs,
      txCount,
    };
  }
}
