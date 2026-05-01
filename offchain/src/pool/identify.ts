// Pool scanner: walk the on-chain UTxO set at the mix-box script and
// surface the boxes the SDK can reason about.
//
// Spec: docs/spec/04-offchain.md §"Pool helpers" + §"Owning-box identification".
//
// A "pool entry" is a UTxO at `mixBoxScriptAddress` whose inline datum decodes
// as a well-formed `MixDatum { a, b }` and whose value is exactly the protocol
// denomination with no native assets. Anything else is treated as malformed
// (Rule 2 hyperstructure recovery on chain) and excluded from the pool view —
// the SDK has no use for it, but it remains spendable via mix_box's True
// path so it isn't bricked.
//
// `ownsBox` answers "is this box mine?" — true iff `b == [x]·a` for the
// caller's secret `x`. With deposit-time re-randomization in M3.5 this
// captures the freshly-deposited form (`a = [d]·g`, `b = [x·d]·g`) just as
// well as the post-mix form (`a = [y·d]·g`, `b = [x·y·d]·g`).

import { decode as cborDecode } from "cbor-x";

import {
  G1_COMPRESSED_BYTES,
  type Scalar,
  pointEqual,
  pointFromBytes,
  scalarMul,
} from "../crypto/index.js";
import type { ChainProvider, Utxo, UtxoRef } from "../chain/provider.js";
import type { ProtocolParams } from "../tx/params.js";

/**
 * A mix-box as the SDK sees it: on-chain ref + the (a, b) datum. The owner
 * secret is *never* on chain, so it isn't part of this shape.
 */
export interface PoolEntry {
  ref: UtxoRef;
  /** 48-byte compressed G1, the box's public `a`. */
  a: Uint8Array;
  /** 48-byte compressed G1, the box's public `b = [x]·a`. */
  b: Uint8Array;
  /** The full UTxO record, kept around so callers can build tx inputs. */
  utxo: Utxo;
}

/**
 * Decode a UTxO's inline datum as a `MixDatum { a: ByteArray(48), b: ByteArray(48) }`.
 * Returns null if the datum is missing, ill-typed, or has the wrong byte
 * lengths. Mirrors `mixbox.ak`'s `try_decode_well_formed_inline` — bad
 * inputs are silently skipped per the hyperstructure recovery rule.
 */
export function decodeMixDatumInline(
  cborHex: string | null,
): { a: Uint8Array; b: Uint8Array } | null {
  if (!cborHex) return null;
  let decoded: unknown;
  try {
    decoded = cborDecode(hexToBytes(cborHex));
  } catch {
    return null;
  }
  if (decoded === null || typeof decoded !== "object") return null;
  const tag = (decoded as { tag?: number }).tag;
  const fields = (decoded as { value?: unknown }).value;
  if (tag !== 121) return null;
  if (!Array.isArray(fields) || fields.length !== 2) return null;
  const [aRaw, bRaw] = fields as [unknown, unknown];
  if (!(aRaw instanceof Uint8Array) || !(bRaw instanceof Uint8Array)) return null;
  if (aRaw.length !== G1_COMPRESSED_BYTES) return null;
  if (bRaw.length !== G1_COMPRESSED_BYTES) return null;
  // a == b would fail the on-chain validator, so it isn't a usable pool entry.
  if (bytesEqual(aRaw, bRaw)) return null;
  // We don't subgroup-check here — every Lovejoin tx that touches the box
  // does an `uncompress` on chain that subgroup-checks for us. Subgroup
  // checks aren't free even off-chain (they're a multi-ms bigint op via
  // @noble/curves), and the cost would multiply by every box scanned.
  return { a: new Uint8Array(aRaw), b: new Uint8Array(bRaw) };
}

/**
 * Filter a UTxO set down to the legitimate pool entries.
 *
 * Rules: address must match, value must equal `denom_lovelace`, no native
 * assets, datum must decode as a well-formed MixDatum. Anything else is
 * silently dropped — Rule 2 says it stays spendable on chain but the SDK
 * shouldn't use it as a mix candidate.
 */
export function filterPoolEntries(args: {
  utxos: ReadonlyArray<Utxo>;
  mixBoxAddressBech32: string;
  denomLovelace: bigint;
}): PoolEntry[] {
  const out: PoolEntry[] = [];
  for (const u of args.utxos) {
    if (u.address !== args.mixBoxAddressBech32) continue;
    if (u.lovelace !== args.denomLovelace) continue;
    if (Object.keys(u.assets).length > 0) continue;
    const datum = decodeMixDatumInline(u.inlineDatum);
    if (!datum) continue;
    out.push({ ref: u.ref, a: datum.a, b: datum.b, utxo: u });
  }
  return out;
}

/**
 * Fetch + filter the pool from a ChainProvider. Convenience wrapper —
 * unit tests can use `filterPoolEntries` directly with a mocked UTxO list.
 */
export async function fetchPool(args: {
  provider: ChainProvider;
  mixBoxAddressBech32: string;
  params: Pick<ProtocolParams, "denomLovelace">;
}): Promise<PoolEntry[]> {
  const utxos = await args.provider.getUtxos(args.mixBoxAddressBech32);
  return filterPoolEntries({
    utxos,
    mixBoxAddressBech32: args.mixBoxAddressBech32,
    denomLovelace: args.params.denomLovelace,
  });
}

/**
 * True iff `secret` unlocks the box. The check is the on-chain Schnorr
 * statement: `b == [x]·a`. Caller is responsible for keeping the secret
 * confidential — this function reads it as a bigint scalar.
 */
export function ownsBox(secret: Scalar, entry: Pick<PoolEntry, "a" | "b">): boolean {
  if (secret <= 0n) return false;
  let aPt;
  let bPt;
  try {
    aPt = pointFromBytes(entry.a);
    bPt = pointFromBytes(entry.b);
  } catch {
    return false;
  }
  return pointEqual(scalarMul(secret, aPt), bPt);
}

/**
 * Walk a pool and return the entries the caller owns according to `secret`.
 * The order of the result mirrors `entries`. Useful for the UI's "my boxes"
 * view across a full mixed pool — the SDK doesn't trust labels, only math.
 */
export function findOwnedBoxes(secret: Scalar, entries: ReadonlyArray<PoolEntry>): PoolEntry[] {
  return entries.filter((e) => ownsBox(secret, e));
}

// ---------------------------------------------------------------------------
// Local utilities
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (cleaned.length % 2 !== 0) throw new Error("hex string must have even length");
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
