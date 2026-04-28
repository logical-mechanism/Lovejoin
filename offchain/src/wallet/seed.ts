// Wallet-derived seed + per-index owner-secret derivation.
//
// Spec: docs/spec/06-ui.md M6.5 vault rework + project memory
// project_owner_secret_storage_m6.md.
//
// The vault's primary flow is "no new keys for the user to manage": the
// connected CIP-30 wallet signs a fixed payload exactly once via signData,
// and Lovejoin derives every per-deposit owner secret deterministically
// from that signature. Ed25519 (RFC 8032) is deterministic, so the same
// (wallet, stakeAddr, payload) always produces the same signature — the
// signature is a stable per-wallet "Lovejoin master key" that costs the
// user a single click on every fresh browser.
//
// Layering (kept narrow on purpose so the SDK doesn't depend on mesh):
//
//   * `deriveSeedFromSignatureBytes(sig)` — pure, takes the signature
//     bytes and returns a 32-byte seed via blake2b_256. This is what the
//     determinism test pins.
//   * `deriveOwnerSecret(seed, index)` — pure, takes the seed + a 32-bit
//     unsigned counter and returns a uniformly random `Scalar` in `Z_r`
//     via HKDF-SHA256 expansion. The 64-byte HKDF output is then reduced
//     mod r — bias is negligible (2^512 / r ≫ 2^255).
//   * `deriveSeedFromWalletSignature({ wallet, stakeAddrBech32 })` —
//     thin wrapper that drives a CIP-30 signData round-trip through the
//     mesh wallet handle and feeds the resulting signature into the pure
//     derivation. Async because signData is async.
//
// The seed never leaves memory. Callers hold `UnlockedSeed` for the
// session and drop it on lock-out (vault lock / inactivity timer / tab
// close). Re-unlocking a fresh session re-prompts the wallet for the
// same signData and recomputes the same seed — no IndexedDB involved.

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { blake2b256 } from "../crypto/hash.js";
import {
  SCALAR_ORDER,
  bytesToBigIntBE,
  reduceScalar,
  type Scalar,
} from "../crypto/bls.js";

/**
 * Domain-separation tag baked into every Lovejoin owner-secret derivation.
 * The version suffix lets a future protocol revision (e.g. M7) introduce
 * `lovejoin/owner/v2` without colliding with v1 secrets a user has already
 * deposited under.
 */
export const SIGN_DATA_PAYLOAD_V1 = "lovejoin/owner/v1";

/** UTF-8 bytes of the v1 payload. Pre-encoded so callers don't reach for TextEncoder. */
export const SIGN_DATA_PAYLOAD_V1_BYTES: Uint8Array = new TextEncoder().encode(
  SIGN_DATA_PAYLOAD_V1,
);

/**
 * Derive a 32-byte vault seed from raw CIP-8 signature bytes.
 *
 * The seed is `blake2b_256(signature_bytes)`. We hash rather than use the
 * signature directly so the output is uniformly distributed even if the
 * underlying Ed25519 signature has any structural bias. blake2b_256 is the
 * same hash the on-chain protocol uses, which keeps the dependency surface
 * tight.
 */
export function deriveSeedFromSignatureBytes(signatureBytes: Uint8Array): Uint8Array {
  if (signatureBytes.length === 0) {
    throw new Error("seed: signature bytes must be non-empty");
  }
  return blake2b256(signatureBytes);
}

/**
 * Hex convenience wrapper for `deriveSeedFromSignatureBytes`. The CIP-30
 * `DataSignature.signature` field is a hex string of the COSE_Sign1
 * envelope; we hash the whole envelope rather than parsing out just the
 * 64-byte Ed25519 signature, because:
 *
 *   1. The envelope bytes are deterministic (mesh uses a stable CBOR
 *      encoder), so hashing the envelope is just as stable as hashing the
 *      raw signature.
 *   2. We avoid pulling a CBOR parser into this module, which keeps it
 *      callable from any environment that has the @noble/hashes deps.
 *   3. CIP-8's protected header binds the address — including it in the
 *      hash means a stake-address change yields a different seed even if
 *      somehow the underlying Ed25519 sig collided.
 */
export function deriveSeedFromSignatureHex(signatureHex: string): Uint8Array {
  return deriveSeedFromSignatureBytes(hexToBytes(signatureHex));
}

/**
 * Encode a 32-bit unsigned counter big-endian. Matches the bytes the spec
 * recommends for the HKDF info argument so cross-impl re-derivation is
 * straightforward (a Rust or Aiken port can hash the same 4 bytes).
 */
function counterToBytes(index: number): Uint8Array {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
    throw new Error(`seed: index must be a uint32, got ${index}`);
  }
  const buf = new Uint8Array(4);
  buf[0] = (index >>> 24) & 0xff;
  buf[1] = (index >>> 16) & 0xff;
  buf[2] = (index >>> 8) & 0xff;
  buf[3] = index & 0xff;
  return buf;
}

/**
 * Derive the i-th per-deposit owner secret from a seed.
 *
 * Implementation: HKDF-SHA256 with the 32-byte seed as IKM, no salt, info
 * = `"lovejoin/owner/v1/" || u32_be(index)`, expand to 64 bytes, reduce
 * mod r. The 64-byte expansion makes the bias from `mod r` reduction
 * negligible (≪ 2⁻²⁵⁶).
 *
 * The result is a non-zero scalar by overwhelming probability; we still
 * reject the zero case loudly so callers don't accidentally generate the
 * identity element. In practice this branch is dead code.
 */
export function deriveOwnerSecret(seed: Uint8Array, index: number): Scalar {
  if (seed.length !== 32) {
    throw new Error(`seed: seed must be 32 bytes, got ${seed.length}`);
  }
  const info = concat(SIGN_DATA_PAYLOAD_V1_BYTES, counterToBytes(index));
  const okm = hkdf(sha256, seed, undefined, info, 64);
  const x = reduceScalar(bytesToBigIntBE(okm));
  if (x === 0n) {
    // Probability ≈ 2⁻²⁵⁶ in a 256-bit field. Surface anyway rather than
    // returning a zero secret — the on-chain validator would reject any
    // proof built from x = 0 because [0]·a is the identity.
    throw new Error(`seed: owner secret was zero at index ${index} (bump index)`);
  }
  if (x >= SCALAR_ORDER) {
    // Defensive: reduceScalar already mods by SCALAR_ORDER. Catch a future
    // refactor that accidentally returns an out-of-range value.
    throw new Error("seed: derived secret >= SCALAR_ORDER");
  }
  return x;
}

/**
 * Mesh wallet surface for `signData`. Both `BrowserWallet` and
 * `MeshWallet` already implement this — we type the minimum so this
 * module is callable with a bare CIP-30 stub in tests.
 */
export interface SignDataCapableWallet {
  /**
   * CIP-30 signData. Returns a CIP-8 envelope in `signature` (hex) and a
   * COSE_Key in `key` (hex). For Lovejoin we only consume `signature`.
   */
  signData(
    address: string,
    payload: string,
  ): Promise<{ signature: string; key: string }>;
  /**
   * Bech32 stake / reward address used as the signing key. CIP-30 lets
   * a wallet sign with any of its keys; we always sign with the stake
   * key so the seed is per-account, not per-payment-address.
   */
  getRewardAddresses(): Promise<string[]>;
}

/**
 * Drive a CIP-30 signData round-trip and return the derived 32-byte seed.
 *
 * Args:
 *   wallet:           any CIP-30 / mesh-shaped handle.
 *   payloadOverride:  optional override for the signed payload — defaults
 *                     to `SIGN_DATA_PAYLOAD_V1`. The override exists for
 *                     test fixtures and for a future v2 derivation.
 *   stakeAddrBech32:  optional override for the signing address. Defaults
 *                     to the wallet's first reward address.
 *
 * The seed is `blake2b_256(signatureHex_bytes)` — see the doc on
 * `deriveSeedFromSignatureHex` for why we hash the envelope rather than
 * the raw Ed25519 signature.
 */
export async function deriveSeedFromWalletSignature(args: {
  wallet: SignDataCapableWallet;
  payloadOverride?: string;
  stakeAddrBech32?: string;
}): Promise<{ seed: Uint8Array; signatureHex: string; address: string }> {
  const payload = args.payloadOverride ?? SIGN_DATA_PAYLOAD_V1;
  const payloadHex = bytesToHex(new TextEncoder().encode(payload));
  let address = args.stakeAddrBech32 ?? "";
  if (!address) {
    const rewards = await args.wallet.getRewardAddresses();
    if (!rewards || rewards.length === 0) {
      throw new Error(
        "seed: wallet exposed no reward (stake) addresses — cannot derive a Lovejoin seed",
      );
    }
    address = rewards[0]!;
  }
  const result = await args.wallet.signData(address, payloadHex);
  const seed = deriveSeedFromSignatureHex(result.signature);
  return { seed, signatureHex: result.signature, address };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (cleaned.length === 0) throw new Error("hex string must be non-empty");
  if (cleaned.length % 2 !== 0) throw new Error("hex string must have even length");
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`hex string contains non-hex char at ${i * 2}`);
    out[i] = byte;
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
