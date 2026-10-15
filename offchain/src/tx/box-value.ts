// Box value: the exact value every mix-box in a Lovejoin launch holds.
//
// Spec: docs/generalize-lovejoin.md §"The box value rule".
//
// An ADA pool's box is `lovelace` alone (10 ADA on the live launches). A
// token pool's box is `lovelace` (2 ADA, just enough for the UTxO to exist)
// plus `quantity` units of one native token. `mix_logic` requires every Mix
// output to equal this value exactly, and hashes its `serialise_data` bytes
// into the Fiat-Shamir context, so `encodeBoxValueCbor` below must stay
// byte-identical to Aiken's `builtin.serialise_data(value.box_value(...))`.
// Parity is pinned by the `box_value` vectors in
// crypto/test-vectors/encoding-parity.json, which the TS, Aiken, and Rust
// test suites all check.
//
// This module has no mesh dependency so the KAT generators can import it.

import type { AssetMap, Hex28, Lovelace, Utxo } from "../chain/provider.js";

/** The one native token a token pool's boxes carry. */
export interface PoolToken {
  /** Minting policy id, 28 bytes as lowercase hex. */
  policy: Hex28;
  /** Asset name as lowercase hex, 0 to 32 bytes. */
  name: string;
  /** `Q`: units of the token in every box. */
  quantity: bigint;
}

/** The exact value of every mix-box in one launch. */
export interface BoxValue {
  /** Lovelace in every box. */
  lovelace: Lovelace;
  /** The pool token; absent for an ADA-only pool. */
  token?: PoolToken;
}

/** A mesh-style asset entry (`{ unit, quantity }`), declared here to stay mesh-free. */
export interface AssetEntry {
  unit: string;
  quantity: string;
}

/** Ledger ceiling on one asset's quantity in an output (Conway `positive_coin`). */
export const MAX_TOKEN_QUANTITY = 18_446_744_073_709_551_615n;

/** Build the box value of an ADA-only pool. */
export function adaBoxValue(lovelace: Lovelace): BoxValue {
  return { lovelace };
}

/** The mesh / Blockfrost asset unit of a token: policy id followed by name hex. */
export function poolTokenUnit(token: PoolToken): string {
  return token.policy + token.name;
}

/**
 * Throw unless `value` is a box value `one_shot_mint` would accept: positive
 * lovelace and, when present, a 28-byte policy, a name of at most 32 bytes,
 * and `0 < quantity <= MAX_TOKEN_QUANTITY`.
 */
export function assertBoxValue(value: BoxValue): void {
  if (value.lovelace <= 0n) {
    throw new Error(`box value: lovelace must be positive, got ${value.lovelace}`);
  }
  const token = value.token;
  if (!token) return;
  if (!/^[0-9a-f]{56}$/.test(token.policy)) {
    throw new Error(`box value: token policy must be 28 bytes of lowercase hex`);
  }
  if (!/^(?:[0-9a-f]{2}){0,32}$/.test(token.name)) {
    throw new Error(`box value: token name must be at most 32 bytes of lowercase hex`);
  }
  if (token.quantity <= 0n || token.quantity > MAX_TOKEN_QUANTITY) {
    throw new Error(`box value: token quantity must be in [1, 2^64 - 1], got ${token.quantity}`);
  }
}

/** True iff the two box values are identical. */
export function boxValuesEqual(a: BoxValue, b: BoxValue): boolean {
  if (a.lovelace !== b.lovelace) return false;
  if (!a.token || !b.token) return !a.token && !b.token;
  return (
    a.token.policy === b.token.policy &&
    a.token.name === b.token.name &&
    a.token.quantity === b.token.quantity
  );
}

/**
 * The box value as a mesh asset list: lovelace first, then the token.
 * Use it for every mix-box `txIn` and `txOut` so a token box never loses
 * its token in a tx body.
 */
export function boxValueAssets(value: BoxValue): AssetEntry[] {
  const out: AssetEntry[] = [{ unit: "lovelace", quantity: value.lovelace.toString() }];
  if (value.token) {
    out.push({ unit: poolTokenUnit(value.token), quantity: value.token.quantity.toString() });
  }
  return out;
}

/**
 * Every asset a UTxO holds, as a mesh asset list (lovelace first). Use it
 * when spending a mix-box: mesh balances the tx from the amounts passed to
 * `txIn`, so passing lovelace alone would leave a token box's token
 * unaccounted for.
 */
export function utxoAssets(utxo: Utxo): AssetEntry[] {
  const out: AssetEntry[] = [{ unit: "lovelace", quantity: utxo.lovelace.toString() }];
  for (const [unit, quantity] of Object.entries(utxo.assets)) {
    if (quantity !== 0n) out.push({ unit, quantity: quantity.toString() });
  }
  return out;
}

/**
 * The non-ADA part of a box value as a `Utxo.assets` map: `{}` for an ADA
 * pool, `{ <policy><name>: Q }` for a token pool. Use it to synthesize the
 * `Utxo` record of an in-flight mix-box output.
 */
export function boxValueAssetMap(value: BoxValue): AssetMap {
  return value.token ? { [poolTokenUnit(value.token)]: value.token.quantity } : {};
}

/** The combined value of `n` boxes (a bulk withdraw's destination total). */
export function scaleBoxValue(value: BoxValue, n: number): BoxValue {
  const k = BigInt(n);
  const out: BoxValue = { lovelace: value.lovelace * k };
  if (value.token) out.token = { ...value.token, quantity: value.token.quantity * k };
  return out;
}

/**
 * True iff `utxo` holds exactly `value`: the same lovelace, the pool token
 * at exactly `Q` (if the pool has one), and no other asset. This is the
 * off-chain mirror of `mix_logic`'s `output.value == box_value` rule, used
 * to pick which pool boxes are eligible Mix inputs.
 */
export function utxoHoldsBoxValue(utxo: Utxo, value: BoxValue): boolean {
  if (utxo.lovelace !== value.lovelace) return false;
  const units = Object.keys(utxo.assets).filter((unit) => utxo.assets[unit] !== 0n);
  if (!value.token) return units.length === 0;
  const unit = poolTokenUnit(value.token);
  return units.length === 1 && units[0] === unit && utxo.assets[unit] === value.token.quantity;
}

/**
 * Canonical Plutus-Data CBOR of the box value, byte-identical to Aiken's
 * `builtin.serialise_data(value.box_value(reference_datum))`.
 *
 * Plutus encodes a `Value` as `Map<PolicyId, Map<AssetName, Integer>>`
 * with definite-length maps, sorted keys, and smallest-form integers. ADA's
 * policy is the empty byte string, which sorts before any 28-byte policy,
 * so a token pool's map is always `[ada, token]`:
 *
 *   ADA pool:   A1 40 A1 40 <lovelace>
 *   token pool: A2 40 A1 40 <lovelace> 58 1C <policy> A1 <name> <quantity>
 */
export function encodeBoxValueCbor(value: BoxValue): Uint8Array {
  assertBoxValue(value);
  const lovelaceEntry = concatBytes([
    Uint8Array.of(0x40), // bytes(0): the ADA policy id
    Uint8Array.of(0xa1), // map(1)
    Uint8Array.of(0x40), // bytes(0): the ADA asset name
    encodeCborUInt(value.lovelace),
  ]);
  if (!value.token) {
    return concatBytes([Uint8Array.of(0xa1), lovelaceEntry]);
  }
  return concatBytes([
    Uint8Array.of(0xa2), // map(2)
    lovelaceEntry,
    encodeCborBytes(hexToBytes(value.token.policy)),
    Uint8Array.of(0xa1), // map(1)
    encodeCborBytes(hexToBytes(value.token.name)),
    encodeCborUInt(value.token.quantity),
  ]);
}

/**
 * Canonical CBOR major-type-0 encoding of a non-negative bigint (smallest
 * form, RFC 8949 §4.2.1). Throws above 2^64 - 1: lovelace and token
 * quantities never exceed it, and the bignum tag(2) path would be dead code.
 */
export function encodeCborUInt(n: bigint): Uint8Array {
  if (n < 0n) throw new Error("encodeCborUInt: negative");
  if (n < 24n) return Uint8Array.of(Number(n));
  if (n < 0x100n) return Uint8Array.of(0x18, Number(n));
  if (n < 0x10000n) {
    const v = Number(n);
    return Uint8Array.of(0x19, (v >> 8) & 0xff, v & 0xff);
  }
  if (n < 0x100000000n) {
    const v = Number(n);
    return Uint8Array.of(0x1a, (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  }
  if (n <= MAX_TOKEN_QUANTITY) {
    const out = new Uint8Array(9);
    out[0] = 0x1b;
    let x = n;
    for (let i = 8; i >= 1; i--) {
      out[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    return out;
  }
  throw new Error(`encodeCborUInt: ${n} exceeds u64; bignum path not implemented`);
}

/** Canonical CBOR byte string (major type 2) for payloads under 256 bytes. */
function encodeCborBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length >= 0x100) throw new Error("encodeCborBytes: payload too long");
  const header =
    bytes.length < 24 ? Uint8Array.of(0x40 + bytes.length) : Uint8Array.of(0x58, bytes.length);
  return concatBytes([header, bytes]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
