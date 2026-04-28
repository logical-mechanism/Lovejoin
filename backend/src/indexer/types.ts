// Indexer state shapes. Spec: docs/spec/05-backend.md §"Models".
//
// Kept separate from the model implementations so tests / API routes can
// import the types without dragging in the chainsync runtime.

import type { Hex32 } from "../config.js";

/** UTxO identifier — `<txid>#<index>`. */
export interface UtxoRef {
  txId: Hex32;
  outputIndex: number;
}

/** Stable string form of `UtxoRef` used as a Map key. */
export type UtxoKey = string;

export function utxoKey(ref: UtxoRef): UtxoKey {
  return `${ref.txId}#${ref.outputIndex}`;
}

export function parseUtxoKey(s: UtxoKey): UtxoRef {
  const hash = s.indexOf("#");
  if (hash <= 0) throw new Error(`bad utxo key ${JSON.stringify(s)}`);
  return { txId: s.slice(0, hash), outputIndex: Number(s.slice(hash + 1)) };
}

/**
 * One mix-box in the live pool. `a`/`b` are 48-byte BLS12-381 G1 compressed
 * points encoded as lowercase hex (no `0x` prefix).
 */
export interface PoolEntry {
  txHash: Hex32;
  outputIndex: number;
  a: string; // 96 hex chars
  b: string; // 96 hex chars
  /** The slot the box was created in. */
  slot: number;
  /**
   * Number of mixes the box has been through. 0 for fresh deposits;
   * increments at every Mix tx that consumes + recreates the box. UI
   * metric only — not enforced on chain.
   */
  generation: number;
}

/** One fee shard. */
export interface FeeShard {
  txHash: Hex32;
  outputIndex: number;
  lovelace: bigint;
  slot: number;
}

/** Aggregate fee state (derived from `shards`). */
export interface FeeStateSnapshot {
  shards: FeeShard[];
  totalLovelace: bigint;
  estimatedMixesAvailable: number;
}

/** What the ChainSync produced for a single block — both removed + added UTxOs. */
export interface BlockDiff {
  /** Slot at which this block was applied. */
  slot: number;
  /** Block hash. */
  blockHash: Hex32;
  /** Block height (number) — used to bound the rollback buffer. */
  height: number;
  /** UTxOs at relevant addresses spent by this block. */
  consumed: UtxoRef[];
  /** UTxOs at relevant addresses produced by this block. */
  produced: ProducedUtxo[];
}

export interface ProducedUtxo {
  ref: UtxoRef;
  /** Bech32 address. */
  address: string;
  /** Lovelace value. */
  lovelace: bigint;
  /** Inline datum CBOR hex; null if absent or not inline. */
  inlineDatumHex: string | null;
  /** Native asset multiset, keyed by `<policy><asset_name_hex>`. */
  assets: Record<string, bigint>;
}

/** Minimum chain-tip identity — used by /health and reorg detection. */
export interface ChainTip {
  slot: number;
  blockHash: Hex32;
  height: number;
}
