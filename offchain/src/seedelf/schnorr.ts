// Seedelf Schnorr Σ-protocol prover, matching the on-chain verifier.
//
// Spec: Seedelf-Wallet contracts/lib/schnorr.ak (`verify`) and
// platform/seedelf-crypto/src/schnorr.rs (`create_proof`).
//
// Statement: prover knows `x` such that `public_value = generator^x`.
// Non-interactive via Fiat-Shamir.
//
// Differences from Lovejoin's Schnorr (`offchain/src/crypto/schnorr.ts`):
//
//   - Hash is blake2b-**224** (28-byte output), not blake2b-256. This is
//     dictated by the Aiken validator's `crypto.blake2b_224` call.
//   - The Fiat-Shamir bound is the ephemeral `vkh` (28 bytes) — a fresh
//     payment-key hash that MUST appear in `tx.extra_signatories`. This is
//     the "one-time pad" Aiken's `list.has(self.extra_signatories,
//     proof.vkh)` enforces: a rollback can't replay the proof because the
//     vkh-keyed signature won't have been re-witnessed by anyone.
//   - The challenge bytes are 28 wide; we interpret them as a big-endian
//     integer < 2^224 < r and reduce mod r. The on-chain verifier feeds
//     the same 28 bytes through `scalar.from_bytes`, which is the same
//     BE-integer interpretation, so the resulting scalar matches exactly.
//   - There is no domain-separation tag; the on-chain hash input is the
//     bare concatenation `generator || g_r || public_value || vkh`. Adding
//     a tag here would diverge from the chain.
//
// On the curve side everything else is identical: G1, RFC 6979 nonces,
// 32-byte BE scalar serialisation.

import { blake2b } from "@noble/hashes/blake2.js";

import {
  G1_COMPRESSED_BYTES,
  SCALAR_BYTES,
  SCALAR_ORDER,
  type Scalar,
  bytesToBigIntBE,
  pointFromBytes,
  pointToBytes,
  reduceScalar,
  scalarMul,
  scalarToBytes,
} from "../crypto/bls.js";
import { deriveNonce } from "../crypto/nonce.js";

/** Length of the on-chain Schnorr bound (a payment-key hash). */
export const SEEDELF_VKH_BYTES = 28;

/** blake2b-224 digest length. */
export const SEEDELF_FS_DIGEST_BYTES = 28;

/**
 * Compute the Fiat-Shamir challenge bytes the chain re-derives:
 *
 *   c_bytes = blake2b_224(generator || g_r || public_value || vkh)
 *
 * Returns the raw 28-byte digest; callers mod-reduce to a scalar.
 */
export function seedelfFsHash(
  generator: Uint8Array,
  gR: Uint8Array,
  publicValue: Uint8Array,
  vkh: Uint8Array,
): Uint8Array {
  if (generator.length !== G1_COMPRESSED_BYTES) {
    throw new Error(`seedelf-fs: generator must be ${G1_COMPRESSED_BYTES} bytes`);
  }
  if (gR.length !== G1_COMPRESSED_BYTES) {
    throw new Error(`seedelf-fs: g_r must be ${G1_COMPRESSED_BYTES} bytes`);
  }
  if (publicValue.length !== G1_COMPRESSED_BYTES) {
    throw new Error(`seedelf-fs: public_value must be ${G1_COMPRESSED_BYTES} bytes`);
  }
  if (vkh.length !== SEEDELF_VKH_BYTES) {
    throw new Error(`seedelf-fs: vkh must be ${SEEDELF_VKH_BYTES} bytes`);
  }
  const buf = new Uint8Array(generator.length + gR.length + publicValue.length + vkh.length);
  let off = 0;
  buf.set(generator, off);
  off += generator.length;
  buf.set(gR, off);
  off += gR.length;
  buf.set(publicValue, off);
  off += publicValue.length;
  buf.set(vkh, off);
  return blake2b(buf, { dkLen: SEEDELF_FS_DIGEST_BYTES });
}

/**
 * On-the-wire Seedelf proof shape, byte-identical to the Aiken `Proof`:
 *
 *   pub type Proof {
 *     z_b: ByteArray,
 *     g_r_b: ByteArray,
 *     vkh: VerificationKeyHash,
 *   }
 */
export interface SeedelfProof {
  /** 32-byte big-endian scalar `z = r + c·x mod r`. */
  z: Uint8Array;
  /** 48-byte compressed `g^r`. */
  gR: Uint8Array;
  /** 28-byte ephemeral payment-key hash (the bound). */
  vkh: Uint8Array;
}

/**
 * Generate a Seedelf Schnorr proof.
 *
 * RFC 6979 binds the nonce to `(secret, generator, public_value, vkh)`, so
 * repeated runs are byte-identical and the encoding-parity tests can pin
 * the output bytes. The vkh appearing in the nonce input means a
 * spend-side replay attempt using a different vkh would produce a different
 * `r`, which propagates through `g_r` and `z` — there is no way to lift a
 * proof from one (vkh, tx) to another.
 *
 * The caller is responsible for:
 *   - ensuring `vkh` is the blake2b-224 of the ephemeral signer's public
 *     key the tx puts into `extra_signatories`,
 *   - rejecting the resulting tx if the signer-key chain witness is
 *     missing (the on-chain `list.has` check fails otherwise).
 */
export function proveSeedelfSchnorr(args: {
  secret: Scalar;
  generator: Uint8Array;
  publicValue: Uint8Array;
  vkh: Uint8Array;
}): SeedelfProof {
  if (args.secret <= 0n || args.secret >= SCALAR_ORDER) {
    throw new Error("seedelf prove: secret must be in [1, r)");
  }
  if (args.vkh.length !== SEEDELF_VKH_BYTES) {
    throw new Error(`seedelf prove: vkh must be ${SEEDELF_VKH_BYTES} bytes`);
  }

  const g = pointFromBytes(args.generator);

  // Nonce message: `generator || public_value || vkh`. The generator is
  // included because Seedelf re-randomizes it (so the same secret has
  // many distinct nonces depending on the register's `d`), and the vkh
  // pins the nonce to this one-time pad.
  const nonceMessage = new Uint8Array(
    args.generator.length + args.publicValue.length + args.vkh.length,
  );
  let off = 0;
  nonceMessage.set(args.generator, off);
  off += args.generator.length;
  nonceMessage.set(args.publicValue, off);
  off += args.publicValue.length;
  nonceMessage.set(args.vkh, off);

  const r_p = deriveNonce(args.secret, nonceMessage);
  const gR = scalarMul(r_p, g);
  const gRBytes = pointToBytes(gR);

  const cBytes = seedelfFsHash(args.generator, gRBytes, args.publicValue, args.vkh);
  // blake2b-224 output is 28 bytes; interpreting as a BE integer gives a
  // value < 2^224 < r, so the `% r` is well-defined and not biased in
  // practice. Reduce defensively anyway.
  const c = reduceScalar(bytesToBigIntBE(cBytes));

  const z = (r_p + ((c * args.secret) % SCALAR_ORDER)) % SCALAR_ORDER;
  return { z: scalarToBytes(z), gR: gRBytes, vkh: args.vkh };
}

/**
 * Verify a Seedelf Schnorr proof (off-chain mirror of the Aiken validator).
 * Returns false rather than throwing on any structural defect — useful for
 * sanity-checking a freshly-built proof before submitting.
 */
export function verifySeedelfSchnorr(args: {
  generator: Uint8Array;
  publicValue: Uint8Array;
  proof: SeedelfProof;
}): boolean {
  if (args.proof.z.length !== SCALAR_BYTES) return false;
  if (args.proof.gR.length !== G1_COMPRESSED_BYTES) return false;
  if (args.proof.vkh.length !== SEEDELF_VKH_BYTES) return false;

  let g, gR, u;
  try {
    g = pointFromBytes(args.generator);
    gR = pointFromBytes(args.proof.gR);
    u = pointFromBytes(args.publicValue);
  } catch {
    return false;
  }

  const z = bytesToBigIntBE(args.proof.z);
  if (z >= SCALAR_ORDER) return false;

  const cBytes = seedelfFsHash(args.generator, args.proof.gR, args.publicValue, args.proof.vkh);
  const c = reduceScalar(bytesToBigIntBE(cBytes));

  // g^z == g^r * u^c
  const lhs = scalarMul(z, g);
  const rhs = scalarMul(c, u).add(gR);
  return lhs.equals(rhs);
}
