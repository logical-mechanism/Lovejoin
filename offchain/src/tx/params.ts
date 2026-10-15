// Protocol-parameter loader.
//
// Spec: §"Configuration source: the reference UTxO"
// and  §1 (the ReferenceDatum shape).
//
// At runtime every Lovejoin tx reads its parameters from the inline datum on
// the reference UTxO. This module is the off-chain mirror of the Aiken
// `read_reference_datum` helper: it fetches that UTxO via a `ChainProvider`,
// decodes the Plutus Data CBOR datum, and returns a typed `ProtocolParams`
// object the tx builders can use.
//
// The reference UTxO is immutable — `reference_holder` is always-False — so
// callers may cache the result for the lifetime of an SDK session.

import { decode as cborDecode } from "cbor-x";

import type { ChainProvider, Hex28, Hex32, Lovelace, Utxo, UtxoRef } from "../chain/provider.js";
import { assertBoxValue, type BoxValue, boxValuesEqual, type PoolToken } from "./box-value.js";

/// Lovejoin protocol parameters, mirroring the on-chain `ReferenceDatum`
/// struct in [contracts/lib/lovejoin/types.ak].
///
/// Two datum layouts exist on chain, and both decode to this one shape:
///
///   * v1, five fields: denom, max-fee, mix script hash, mix-logic script
///     hash, fee script hash. The live mainnet and Preprod ADA pools.
///   * v2, eight fields: box lovelace, token policy, token name, token
///     quantity, then the same four as v1. Token pools and any later launch
///     (docs/generalize-lovejoin.md). An empty token policy means ADA-only.
///
/// `max_n` and the canonical 10-shard fee-pool size live in off-chain config
/// (network.<net>.json), not on-chain — no validator reads them, so keeping
/// them on-chain just costs us a Constr-decode field per validator run.
/// Removed in M4.5 redeploy.
export interface ProtocolParams {
  /// The exact value of every mix-box in this launch.
  boxValue: BoxValue;
  maxFeePerMixLovelace: Lovelace;
  mixScriptHash: Hex28;
  mixLogicScriptHash: Hex28;
  feeScriptHash: Hex28;
}

/// Where the bootstrap ceremony recorded the on-chain script identifiers and
/// the reference UTxO. This is the exact shape of `artifacts/<net>/addresses.json`.
export interface LovejoinAddresses {
  network: string;
  protocol: {
    /// Lovelace per box on a v1 (5-field datum) launch: the live ADA pools.
    denom_lovelace?: number;
    /// Lovelace per box on a v2 (8-field datum) launch.
    box_lovelace?: number;
    /// The pool token on a v2 token launch; absent for an ADA pool.
    token?: AddressesPoolToken;
    max_fee_per_mix_lovelace: number;
    /**
     * Optional. Off-chain calibrated max-N for shard-fee mode.
     * shard mode pays the tx fee from a fee_contract shard, which adds
     * fee_contract.spend (~187M CPU @ Conway prices) to the per-tx
     * budget — pushing N=4 over the 10G CPU cap. The cap is therefore
     * lower in shard mode than in wallet mode.
     */
    max_n_shard?: number;
    /**
     * Optional. Off-chain calibrated max-N for wallet-fee mode (the
     * submitter pays directly). Skips fee_contract.spend, freeing
     * ~187M CPU and letting N=4 fit. Trade-off: the wallet's identity
     * is on the tx, so fee anonymity is lost (Mix anonymity itself is
     * unaffected).
     */
    max_n_wallet?: number;
    /**
     * Legacy single cap. Older bootstraps wrote one `max_n` instead of
     * the per-mode pair above. Newer SDK code reads `max_n_shard` /
     * `max_n_wallet`; this field is retained so a legacy addresses.json
     * still parses.
     */
    max_n?: number;
    /**
     * Optional, informational. The canonical fee-pool shard count
     * (= 10) is off-chain coordination; the validator does not read
     * it. Older bootstrap outputs carry this; M4.5 and later omit it.
     */
    fee_shard_target?: number;
  };
  referenceNftPolicy: Hex28;
  referenceNftAssetName: string;
  referenceUtxoRef: string;
  referenceHolderScriptHash: Hex28;
  mixLogicScriptHash: Hex28;
  mixBoxScriptHash: Hex28;
  feeScriptHash: Hex28;
  feeShardUtxos: string[];
  referenceScriptUtxos: {
    mix_box: string;
    mix_logic: string;
    fee_contract: string;
  };
  /**
   * Optional. Byte sizes of each published reference script (the
   * `cborHex` length from the .plutus file). Mesh's tx builder uses
   * this when computing the size-based portion of the tx fee — without
   * it the fee is undercounted and submission fails with a "min fee not
   * met" error from the ledger.
   */
  referenceScriptSizes?: {
    mix_box: number;
    mix_logic: number;
    fee_contract: number;
  };
  /// Optional. Present in newer bootstrap outputs but tolerated when missing.
  stage1ChangeUtxo?: string;
  /// Optional. The tx that registered the mix_logic stake credential.
  mixLogicRegisterTx?: Hex32;
  /// Optional. Chain point at-or-just-before the bootstrap tx, used by
  /// the self-hosted backend's chainsync to skip ahead from genesis.
  /// SDK doesn't read it directly; the field is mirrored here so the
  /// addresses.json schema stays the single source of truth.
  bootstrapStartPoint?: { slot: number; blockHash: Hex32 };
}

/// A token pool's token as `addresses.json` records it. `quantity` is a
/// decimal string because `Q` can exceed JSON's safe-integer range.
/// `ticker` and `decimals` are optional, display-only metadata; no validator
/// reads them.
export interface AddressesPoolToken {
  policy: Hex28;
  name: string;
  quantity: string;
  ticker?: string;
  decimals?: number;
}

/// The box value recorded in `addresses.json`: `box_lovelace` plus `token`
/// on a v2 launch, or `denom_lovelace` on a v1 ADA launch. Callers that can
/// reach the chain should prefer `fetchProtocolParams`, which reads the
/// immutable reference datum; `fetchProtocolParams` also rejects an
/// `addresses.json` whose box value disagrees with the chain.
export function boxValueFromAddresses(addresses: LovejoinAddresses): BoxValue {
  const p = addresses.protocol;
  const lovelace = p?.box_lovelace ?? p?.denom_lovelace;
  if (typeof lovelace !== "number" || !Number.isSafeInteger(lovelace) || lovelace <= 0) {
    throw new Error("addresses.json: protocol.box_lovelace (or denom_lovelace) is missing");
  }
  const value: BoxValue = { lovelace: BigInt(lovelace) };
  if (p.token) {
    value.token = {
      policy: p.token.policy.toLowerCase(),
      name: p.token.name.toLowerCase(),
      quantity: BigInt(p.token.quantity),
    };
  }
  assertBoxValue(value);
  return value;
}

/// Convert a "<txid>#<index>" string into our typed UtxoRef.
export function parseUtxoRef(s: string): UtxoRef {
  const hash = s.indexOf("#");
  if (hash <= 0 || hash === s.length - 1) {
    throw new Error(`malformed UTxO ref ${JSON.stringify(s)}; expected <txid>#<index>`);
  }
  const txId = s.slice(0, hash).toLowerCase();
  const idxStr = s.slice(hash + 1);
  if (!/^[0-9a-f]{64}$/.test(txId)) {
    throw new Error(`malformed UTxO ref ${JSON.stringify(s)}; txid must be 64 lowercase hex chars`);
  }
  const outputIndex = Number(idxStr);
  if (!Number.isInteger(outputIndex) || outputIndex < 0) {
    throw new Error(
      `malformed UTxO ref ${JSON.stringify(s)}; index must be a non-negative integer`,
    );
  }
  return { txId, outputIndex };
}

export function formatUtxoRef(ref: UtxoRef): string {
  return `${ref.txId}#${ref.outputIndex}`;
}

/// Decode a Plutus-Data CBOR-hex inline datum into a `ProtocolParams`.
///
/// Aiken's `builtin.serialise_data` produces "Plutus Data" CBOR — `Constr 0`
/// with the fields in declaration order (five for a v1 datum, eight for v2;
/// see `ProtocolParams`). cbor-x decodes generic CBOR into
/// JS types; tagged values come back as `{ tag, value }` objects from cbor-x's
/// `Tag` class. Plutus Data uses CBOR tag 121 + n for `Constr n` (RFC 8949
/// has tag 121 reserved for this purpose by IOG).
export function decodeReferenceDatum(cborHex: string): ProtocolParams {
  const bytes = hexToBytes(cborHex);
  const decoded = cborDecode(bytes);
  // cbor-x represents a CBOR tag as a `Tag` instance with `tag` + `value`.
  // We don't import the Tag class directly — duck-typing is sufficient and
  // avoids breaking if cbor-x's class layout changes.
  if (decoded === null || typeof decoded !== "object") {
    throw new Error(`reference datum: expected Constr, got ${typeof decoded}`);
  }
  const tag = (decoded as { tag?: number }).tag;
  const fields = (decoded as { value?: unknown }).value;
  if (tag !== 121) {
    throw new Error(`reference datum: expected Plutus Constr 0 (CBOR tag 121), got tag ${tag}`);
  }
  if (!Array.isArray(fields) || (fields.length !== 5 && fields.length !== 8)) {
    throw new Error(
      `reference datum: expected 5 fields (v1) or 8 fields (v2), got ${Array.isArray(fields) ? fields.length : typeof fields}`,
    );
  }
  let boxValue: BoxValue;
  let rest: unknown[];
  if (fields.length === 5) {
    boxValue = { lovelace: toBigInt(fields[0], "denom_lovelace") };
    rest = fields.slice(1);
  } else {
    boxValue = { lovelace: toBigInt(fields[0], "box_lovelace") };
    const token = decodePoolToken(fields[1], fields[2], fields[3]);
    if (token) boxValue.token = token;
    rest = fields.slice(4);
  }
  assertBoxValue(boxValue);
  const [maxFee, mixScriptHash, mixLogicScriptHash, feeScriptHash] = rest;

  return {
    boxValue,
    maxFeePerMixLovelace: toBigInt(maxFee, "max_fee_per_mix_lovelace"),
    mixScriptHash: toHex28(mixScriptHash, "mix_script_hash"),
    mixLogicScriptHash: toHex28(mixLogicScriptHash, "mix_logic_script_hash"),
    feeScriptHash: toHex28(feeScriptHash, "fee_script_hash"),
  };
}

/// Fetch the reference UTxO and decode its inline datum into `ProtocolParams`.
///
/// Throws if the reference UTxO is missing, present but with no inline datum,
/// or carries a datum that doesn't decode as `ReferenceDatum`. Each of these
/// is a catastrophic protocol error — the SDK refuses to build a tx because
/// the Aiken validator would reject it on-chain anyway.
export async function fetchProtocolParams(
  addresses: LovejoinAddresses,
  provider: ChainProvider,
): Promise<{ params: ProtocolParams; referenceUtxo: Utxo }> {
  const referenceUtxo = await provider.getReferenceUtxo(
    addresses.referenceNftPolicy,
    addresses.referenceNftAssetName,
  );
  if (!referenceUtxo.inlineDatum) {
    throw new Error(
      `reference UTxO ${formatUtxoRef(referenceUtxo.ref)} has no inline datum; bootstrap is incomplete`,
    );
  }
  const params = decodeReferenceDatum(referenceUtxo.inlineDatum);

  // Defense-in-depth: if the bootstrap ceremony recorded specific script
  // hashes in addresses.json, refuse to proceed if the on-chain datum
  // disagrees. A mismatch points to either a bootstrap bug or someone
  // pointing the SDK at the wrong addresses.json.
  if (params.mixLogicScriptHash !== addresses.mixLogicScriptHash) {
    throw new Error(
      `mix_logic hash mismatch: on-chain ${params.mixLogicScriptHash}, addresses.json ${addresses.mixLogicScriptHash}`,
    );
  }
  if (params.mixScriptHash !== addresses.mixBoxScriptHash) {
    throw new Error(
      `mix_box hash mismatch: on-chain ${params.mixScriptHash}, addresses.json ${addresses.mixBoxScriptHash}`,
    );
  }
  if (params.feeScriptHash !== addresses.feeScriptHash) {
    throw new Error(
      `fee_contract hash mismatch: on-chain ${params.feeScriptHash}, addresses.json ${addresses.feeScriptHash}`,
    );
  }
  // Code that cannot wait on the chain (the strategy layer, the UI) reads
  // the box value from addresses.json, so it must agree with the datum.
  if (!boxValuesEqual(params.boxValue, boxValueFromAddresses(addresses))) {
    throw new Error(
      `box value mismatch: on-chain ${describeBoxValue(params.boxValue)}, addresses.json ${describeBoxValue(boxValueFromAddresses(addresses))}`,
    );
  }

  return { params, referenceUtxo };
}

// ---------------------------------------------------------------------------
// Internal coercions — produce friendlier errors than `as` casts.
// ---------------------------------------------------------------------------

/// Decode the v2 token triple. An empty policy means an ADA-only pool and
/// requires an empty name and zero quantity, the same shape rule
/// `one_shot_mint` enforces at launch.
function decodePoolToken(policy: unknown, name: unknown, quantity: unknown): PoolToken | null {
  const policyBytes = toBytes(policy, "token_policy");
  const nameBytes = toBytes(name, "token_name");
  const q = toBigInt(quantity, "token_quantity");
  if (policyBytes.length === 0) {
    if (nameBytes.length !== 0 || q !== 0n) {
      throw new Error(
        "reference datum: ADA-only pool must have an empty token name and zero quantity",
      );
    }
    return null;
  }
  return { policy: bytesToHex(policyBytes), name: bytesToHex(nameBytes), quantity: q };
}

function describeBoxValue(v: BoxValue): string {
  const token = v.token ? ` + ${v.token.quantity} ${v.token.policy}.${v.token.name}` : "";
  return `${v.lovelace} lovelace${token}`;
}

function toBytes(x: unknown, field: string): Uint8Array {
  if (!(x instanceof Uint8Array)) {
    throw new Error(`reference datum: ${field} must be CBOR bytes, got ${typeof x}`);
  }
  return x;
}

function toBigInt(x: unknown, field: string): bigint {
  if (typeof x === "bigint") return x;
  if (typeof x === "number" && Number.isInteger(x)) return BigInt(x);
  throw new Error(`reference datum: ${field} must be an integer, got ${typeof x}`);
}

function toHex28(x: unknown, field: string): Hex28 {
  if (!(x instanceof Uint8Array)) {
    throw new Error(`reference datum: ${field} must be CBOR bytes, got ${typeof x}`);
  }
  if (x.length !== 28) {
    throw new Error(`reference datum: ${field} must be 28 bytes, got ${x.length}`);
  }
  return bytesToHex(x);
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (cleaned.length % 2 !== 0) {
    throw new Error("hex string must have even length");
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = cleaned.slice(i * 2, i * 2 + 2);
    const v = Number.parseInt(byte, 16);
    if (!Number.isFinite(v)) throw new Error(`bad hex byte ${JSON.stringify(byte)}`);
    out[i] = v;
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}
