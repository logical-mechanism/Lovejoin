// Ogmios-shaped UTxO adapters.
//
// Why this exists: giveme.my v1.2.0's `additional_utxos` field is forwarded
// verbatim to Ogmios' `evaluateTransaction.additionalUtxo` mechanism, which
// splices extra UTxO entries into the chain state for evaluation only.
// To chain a Mix tx onto an in-flight parent (Deposit, Replenish, or
// prior Mix), the SDK has to ship the parent's outputs in Ogmios' exact
// shape — pre-confirmation, those UTxOs don't exist on chain yet, so the
// evaluator would otherwise abort.
//
// Schema reference (Ogmios v6): each entry is a FLAT object combining
// the TxIn fields (transaction, index) with the TxOut fields (address,
// value, optional datum/script). The first cut of this module emitted
// a `[txin, txout]` 2-tuple per the issue spec, but Ogmios v6 rejected
// that with "parsing TxIn failed, expected Object, but encountered
// Array". The shape below matches ogmios's actual schema:
//
//   {
//     "transaction": { "id": "<txid>" },
//     "index":       <int>,
//     "address":     "<bech32>",
//     "value":       { "ada": { "lovelace": <int> },
//                      "<policyId>": { "<assetName>": <int>, ... },
//                      ... },
//     "datum"?:      "<cbor hex>",          // inline datum
//     "datumHash"?:  "<32-byte hex>",       // hash-only datum
//     "script"?:     <script object>        // optional reference script
//   }
//
// Lovejoin's internal `Utxo` (chain/provider.ts) and mesh's `UTxO` carry
// the same information; this module's converters peel them into Ogmios'
// nested-map shape without reaching into mesh runtime (so unit tests don't
// pay for the libsodium load).
//
// Naming: the helper is `meshUtxoToOgmiosAdditional` per the issue (#127);
// `lovejoinUtxoToOgmiosAdditional` is the same conversion from our flatter
// internal shape. Both produce identical Ogmios payloads.

import type { Utxo } from "./provider.js";

// Type-only — same erase-at-runtime trick used in wallet/cip30.ts to keep
// the libsodium import deferred.
import type { UTxO as MeshUtxo } from "@meshsdk/core";

/**
 * Ogmios v6 Value shape. `ada.lovelace` carries the ADA quantity; native
 * assets live under their policyId → assetName quantity map. Quantities
 * are numeric on the wire (Ogmios serialises bigints with a `bigint`
 * encoding when they exceed JS safe-int range; we keep `bigint` in the
 * type so callers don't accidentally lose precision).
 */
export interface OgmiosValue {
  ada: { lovelace: bigint };
  [policyId: string]: { [assetName: string]: bigint } | { lovelace: bigint };
}

/** Ogmios v6 transaction-output shape. */
export interface OgmiosOutput {
  address: string;
  value: OgmiosValue;
  /** Inline datum, CBOR hex. Mutually exclusive with `datumHash`. */
  datum?: string;
  /** Datum hash, 32-byte hex. Mutually exclusive with `datum`. */
  datumHash?: string;
  /**
   * Reference script attached to the output. Ogmios accepts a few shapes
   * here (native script JSON, Plutus script with version + cbor). We
   * pass through whatever the caller supplies — typed loosely because
   * lovejoin doesn't introspect this field, just forwards it.
   */
  script?: unknown;
}

/**
 * One UTxO entry as Ogmios v6 expects under `additionalUtxo`: a flat
 * object combining the TxIn fields (`transaction.id`, `index`) with
 * the TxOut fields (`address`, `value`, optional `datum` / `datumHash`
 * / `script`). NOT a 2-tuple — Ogmios rejects the 2-tuple form with
 * "parsing TxIn failed, expected Object, but encountered Array".
 */
export interface AdditionalUtxo extends OgmiosOutput {
  transaction: { id: string };
  index: number;
}

/**
 * Convert mesh's `UTxO` shape into the Ogmios `additionalUtxo` 2-tuple.
 *
 * Mesh stores `value` as a flat `Asset[]` of `{ unit, quantity }` entries
 * where `unit === "lovelace"` for ADA and `unit === <policyId><assetNameHex>`
 * for native assets (concatenated, no separator — same convention mesh
 * uses internally and that BlockfrostProvider already produces).
 *
 * Ogmios' nested-map form re-groups assets by policyId; this helper does
 * that split. ADA always lands under `value.ada.lovelace`, even when the
 * UTxO carries zero lovelace — Ogmios requires the field to exist.
 *
 * Inline datums map to `output.datum`; reference scripts to `output.script`
 * (left as-is — the caller is expected to supply mesh's
 * `{ code, version }` object, which Ogmios accepts).
 *
 * The mesh shape doesn't distinguish hash-only datums from inline datums
 * in `plutusData`, so a datum-hash output produced by this converter
 * lands under `datum`. Lovejoin never produces hash-only outputs (every
 * dApp UTxO uses inline datums), so this is fine in practice; if a
 * downstream caller needs the `datumHash` discriminator, they can post-
 * process the result.
 */
export function meshUtxoToOgmiosAdditional(u: MeshUtxo): AdditionalUtxo {
  const value: OgmiosValue = { ada: { lovelace: 0n } };
  for (const a of u.output.amount) {
    if (a.unit === "lovelace") {
      value.ada.lovelace = BigInt(a.quantity);
      continue;
    }
    // Mesh's unit format: `<28-byte policyId hex><asset-name hex>` (no
    // separator). PolicyId is exactly 56 hex chars; everything after is
    // the asset name (which may be empty).
    if (a.unit.length < 56) {
      throw new Error(
        `meshUtxoToOgmiosAdditional: malformed asset unit "${a.unit}" — expected >= 56 hex chars`,
      );
    }
    const policyId = a.unit.slice(0, 56);
    const assetName = a.unit.slice(56);
    const bucket = (value[policyId] ??= {} as { [assetName: string]: bigint });
    const inner = bucket as { [assetName: string]: bigint };
    inner[assetName] = (inner[assetName] ?? 0n) + BigInt(a.quantity);
  }
  return {
    transaction: { id: u.input.txHash.toLowerCase() },
    index: u.input.outputIndex,
    address: u.output.address,
    value,
    ...(u.output.plutusData ? { datum: u.output.plutusData } : {}),
    ...(u.output.scriptRef ? { script: u.output.scriptRef } : {}),
  };
}

/**
 * Convert Lovejoin's flat `Utxo` shape into an Ogmios `additionalUtxo`
 * 2-tuple. Same Ogmios output as {@link meshUtxoToOgmiosAdditional}.
 *
 * Inline datums (`inlineDatum`, CBOR hex) and reference scripts
 * (`referenceScript`, CBOR hex) are forwarded under `datum` / `script`.
 * Note that Ogmios' `script` field expects a `{ language, cbor }` object
 * rather than a raw cbor-hex string; callers chaining off-protocol
 * scripts should construct the AdditionalUtxo directly. Lovejoin's own
 * dApp UTxOs carry no inline reference scripts (only the bootstrap-time
 * reference UTxOs do, and those are confirmed long before chaining
 * matters), so the simple shape here is sufficient for the in-flight
 * Mix-chain case.
 */
export function lovejoinUtxoToOgmiosAdditional(u: Utxo): AdditionalUtxo {
  const value: OgmiosValue = { ada: { lovelace: u.lovelace } };
  for (const [unit, qty] of Object.entries(u.assets)) {
    if (unit.length < 56) {
      throw new Error(
        `lovejoinUtxoToOgmiosAdditional: malformed asset unit "${unit}" — expected >= 56 hex chars`,
      );
    }
    const policyId = unit.slice(0, 56);
    const assetName = unit.slice(56);
    const bucket = (value[policyId] ??= {} as { [assetName: string]: bigint });
    const inner = bucket as { [assetName: string]: bigint };
    inner[assetName] = qty;
  }
  return {
    transaction: { id: u.ref.txId.toLowerCase() },
    index: u.ref.outputIndex,
    address: u.address,
    value,
    ...(u.inlineDatum ? { datum: u.inlineDatum } : {}),
    ...(u.referenceScript ? { script: u.referenceScript } : {}),
  };
}
