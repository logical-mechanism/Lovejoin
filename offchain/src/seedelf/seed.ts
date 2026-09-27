// Seedelf-specific scalar derivation, domain-separated from Lovejoin owners.
//
// Spec: issue #135 ("Single shared vault seed across Lovejoin owners + Seedelf
// registers, or domain-separated?"). Domain separation, so a leak in one
// derivation does not compromise the other and so future param bumps to
// either are independent. Both derivations share the same wallet-signature
// seed (see `offchain/src/wallet/seed.ts`); they differ in the HKDF info
// tag fed into the per-index expansion.
//
// HKDF chain:
//
//   seed       = deriveVaultSeed(walletSig, stakeAddrBech32)        // 32 bytes
//   x_{seedelf,i} = HKDF-SHA256(seed, info = SEEDELF_HKDF_TAG_V1 || u32_be(i),
//                               len = 64) mod r
//
// The `seedelf/v1` info tag is independent of the Lovejoin owner tag
// `lovejoin/owner/v1` and the password-recovery tag `lovejoin/recover-seed/v1`.
// Bumping any of the three is an isolated change to that derivation path.

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { SCALAR_ORDER, bytesToBigIntBE, reduceScalar, type Scalar } from "../crypto/bls.js";

/**
 * Domain tag mixed into HKDF-Expand when deriving the per-index Seedelf
 * scalar. Bound to v1 — if the derivation changes, bump to v2 alongside
 * any storage that pins existing scalars. Users with existing v1 registers
 * keep them until they burn them.
 */
export const SEEDELF_HKDF_TAG_V1 = "lovejoin/seedelf/v1";
const SEEDELF_HKDF_TAG_V1_BYTES = new TextEncoder().encode(SEEDELF_HKDF_TAG_V1);

function counterToBytes(index: number): Uint8Array {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
    throw new Error(`seedelf: index must be a uint32, got ${index}`);
  }
  const buf = new Uint8Array(4);
  buf[0] = (index >>> 24) & 0xff;
  buf[1] = (index >>> 16) & 0xff;
  buf[2] = (index >>> 8) & 0xff;
  buf[3] = index & 0xff;
  return buf;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Derive the i-th Seedelf secret scalar from a vault seed.
 *
 * Mirrors `deriveOwnerSecret` (lovejoin owner derivation) byte-for-byte
 * except for the info-tag — same HKDF construction, same 64-byte expand,
 * same `mod r` reduction.
 */
export function deriveSeedelfSecret(seed: Uint8Array, index: number): Scalar {
  if (seed.length !== 32) {
    throw new Error(`seedelf: seed must be 32 bytes, got ${seed.length}`);
  }
  const info = concat(SEEDELF_HKDF_TAG_V1_BYTES, counterToBytes(index));
  const okm = hkdf(sha256, seed, undefined, info, 64);
  const x = reduceScalar(bytesToBigIntBE(okm));
  if (x === 0n) {
    throw new Error(`seedelf: derived secret was zero at index ${index} (bump index)`);
  }
  if (x >= SCALAR_ORDER) {
    throw new Error("seedelf: derived secret >= SCALAR_ORDER");
  }
  return x;
}
