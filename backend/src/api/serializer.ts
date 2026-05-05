// JSON wire-format helpers shared across route plugins.
//
// Lovelace and asset quantities are bigints in the indexer's
// in-memory representation; the wire format is decimal strings so we
// don't lose precision on values that fit a JS bigint but exceed
// Number.MAX_SAFE_INTEGER. The Fastify reply serializer is wired with
// `PRESERVE_BIGINT_REPLACER` so any nested bigint survives a
// JSON.stringify round-trip; `serializeUtxo` does the explicit
// conversion for routes that need to emit the canonical
// `DbSyncUtxo`-shaped wire object.

import type { DbSyncUtxo } from "../db/dbsync.js";

export const PRESERVE_BIGINT_REPLACER = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

/**
 * Wire shape for a UTxO. Lovelace is a decimal string so the JSON
 * serializer doesn't lose precision on values that fit a JS bigint
 * but exceed Number.MAX_SAFE_INTEGER. Asset quantities follow the
 * same convention.
 */
export function serializeUtxo(u: DbSyncUtxo): {
  txHash: string;
  outputIndex: number;
  address: string;
  lovelace: string;
  assets: Record<string, string>;
  inlineDatum: string | null;
  datumHash: string | null;
  referenceScriptCbor: string | null;
  referenceScriptHash: string | null;
} {
  const assets: Record<string, string> = {};
  for (const [unit, qty] of Object.entries(u.assets)) {
    assets[unit] = qty.toString();
  }
  return {
    txHash: u.txHash,
    outputIndex: u.outputIndex,
    address: u.address,
    lovelace: u.lovelace.toString(),
    assets,
    inlineDatum: u.inlineDatum,
    datumHash: u.datumHash,
    referenceScriptCbor: u.referenceScriptCbor,
    referenceScriptHash: u.referenceScriptHash,
  };
}
