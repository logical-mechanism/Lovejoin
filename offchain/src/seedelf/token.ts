// Seedelf NFT token-name generation.
//
// Spec: Seedelf-Wallet contracts/lib/token_name.ak (`generate`) and
// platform/seedelf-core/src/transaction.rs (`seedelf_token_name`).
//
// On-chain layout (matches Aiken's `bytearray.slice(.., 0, 31)`, i.e. the
// first 32 bytes of the concatenation):
//
//   token_name = prefix(4) || personal(0..15) || idx_byte(1) || txid(0..27)
//
// where `prefix == 0x5eed0e1f`, `personal` is the user-supplied label
// trimmed to at most 15 bytes, `idx_byte` is the producing input's output
// index encoded as a single byte, and the txid is the producing input's
// 32-byte tx hash. The total is truncated to 32 bytes.
//
// On-chain the producing input is the **first** entry of `tx.inputs`,
// which the ledger lex-sorts by `(txid, output_index)`. The validator
// recomputes the expected token-name from that input and mint redeemer's
// `personal_tag` — any divergence fails minting.

import type { UtxoRef } from "../chain/provider.js";

/** Maximum bytes the personal-tag field is trimmed to. */
export const SEEDELF_PERSONAL_MAX_BYTES = 15;
/** Hex of the seedelf token-name prefix. */
export const SEEDELF_TOKEN_PREFIX_HEX = "5eed0e1f";
/** Total token-name length in bytes (Cardano native-asset name). */
export const SEEDELF_TOKEN_BYTES = 32;

const PREFIX_BYTES = new Uint8Array([0x5e, 0xed, 0x0e, 0x1f]);

/**
 * Compute the Seedelf token name a mint tx must produce, given the
 * lex-smallest input ref and the user's personal tag. Returns the raw
 * 32-byte asset name. Caller may hex-encode for display or pass to mesh.
 *
 * The personal tag is interpreted as UTF-8 if it's a string, or used as
 * raw bytes if it's a Uint8Array. Either way it's trimmed to the first
 * `SEEDELF_PERSONAL_MAX_BYTES` bytes — the on-chain `bytearray.slice(.., 0,
 * 14)` keeps positions 0..=14 (15 bytes) before truncation.
 */
export function buildSeedelfTokenName(args: {
  /** Lex-smallest input ref that will be in the mint tx. */
  input: UtxoRef;
  /** Personal label. UTF-8 string or raw bytes. */
  personal?: string | Uint8Array;
}): Uint8Array {
  const personalRaw =
    args.personal === undefined
      ? new Uint8Array(0)
      : typeof args.personal === "string"
        ? new TextEncoder().encode(args.personal)
        : args.personal;
  const personal = personalRaw.subarray(0, SEEDELF_PERSONAL_MAX_BYTES);

  if (!Number.isInteger(args.input.outputIndex) || args.input.outputIndex < 0) {
    throw new Error(`seedelf token: outputIndex must be a non-negative integer`);
  }
  if (args.input.outputIndex > 0xff) {
    // On-chain `bytearray.push(txid, idx)` only encodes 1 byte; an idx >=
    // 256 would silently roll over (and the `rollover_attack` Aiken test
    // expects exactly this to fail). Refuse to mint against such inputs.
    throw new Error(
      `seedelf token: outputIndex ${args.input.outputIndex} exceeds 0xff; pick a different input`,
    );
  }
  const txid = hexToBytes(args.input.txId);
  if (txid.length !== 32) {
    throw new Error(`seedelf token: txid must be 32 bytes, got ${txid.length}`);
  }

  const buf = new Uint8Array(SEEDELF_TOKEN_BYTES);
  let off = 0;
  // Prefix (4 bytes)
  buf.set(PREFIX_BYTES, off);
  off += PREFIX_BYTES.length;
  // Personal (up to 15 bytes)
  buf.set(personal, off);
  off += personal.length;
  // Index byte (1 byte)
  if (off < SEEDELF_TOKEN_BYTES) {
    buf[off] = args.input.outputIndex & 0xff;
    off += 1;
  }
  // Tx hash (remaining bytes up to 32)
  const remaining = SEEDELF_TOKEN_BYTES - off;
  if (remaining > 0) {
    buf.set(txid.subarray(0, remaining), off);
  }
  return buf;
}

/** Convenience wrapper returning lowercase hex of the token name. */
export function buildSeedelfTokenNameHex(args: {
  input: UtxoRef;
  personal?: string | Uint8Array;
}): string {
  return bytesToHex(buildSeedelfTokenName(args));
}

/**
 * Pick the lex-smallest input ref from a list. Matches the on-chain
 * convention (`expect [input, ..] = inputs` against ledger-sorted inputs)
 * and the Rust CLI's `min_by` over `(tx_hash, txo_index)`.
 */
export function pickSmallestInputRef(refs: ReadonlyArray<UtxoRef>): UtxoRef {
  if (refs.length === 0) {
    throw new Error("seedelf token: input list is empty");
  }
  let smallest = refs[0]!;
  for (let i = 1; i < refs.length; i++) {
    const cur = refs[i]!;
    const cmp = cur.txId.localeCompare(smallest.txId);
    if (cmp < 0 || (cmp === 0 && cur.outputIndex < smallest.outputIndex)) {
      smallest = cur;
    }
  }
  return smallest;
}

/**
 * True iff `assetNameHex` is a Seedelf NFT token name — i.e. starts with
 * the `5eed0e1f` prefix and is exactly 32 bytes. The scanner uses this to
 * filter UTxOs at the wallet script address.
 */
export function isSeedelfAssetName(assetNameHex: string): boolean {
  if (assetNameHex.length !== SEEDELF_TOKEN_BYTES * 2) return false;
  return assetNameHex.toLowerCase().startsWith(SEEDELF_TOKEN_PREFIX_HEX);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (cleaned.length % 2 !== 0) throw new Error("hex string must have even length");
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(v)) throw new Error(`bad hex byte at offset ${i * 2}`);
    out[i] = v;
  }
  return out;
}
