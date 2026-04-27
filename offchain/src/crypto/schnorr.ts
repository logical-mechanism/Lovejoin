// Schnorr / proveDlog (Sigmajoin paper §2.1; Lovejoin spec docs/spec/02-cryptography.md).
//
// Statement: prover knows `x ∈ Z_r` such that `u = [x]·base`.
//   * "Vanilla" Schnorr uses `base = g` (the canonical generator).
//   * The Owner branch in mix_box uses `base = a`, `u = b` (where (a, b) is the
//     box's MixDatum). The math is identical — the verifier just consumes `base`
//     from the call site.
//
// Non-interactive (Fiat-Shamir):
//   1. Pick `r_p ∈ Z_r` (deterministic via RFC 6979 — see crypto/nonce.ts).
//   2. t = [r_p]·base.
//   3. c = H(base, u, t, ctx) mod r.
//   4. z = r_p + c·x mod r.
//   Proof π = (t, z).
//
// Verifier: accept iff `[z]·base == t + [c]·u`.

import {
  type G1Point,
  G1_COMPRESSED_BYTES,
  SCALAR_BYTES,
  SCALAR_ORDER,
  type Scalar,
  bytesToBigIntBE,
  generator,
  pointAdd,
  pointEqual,
  pointFromBytes,
  pointToBytes,
  reduceScalar,
  scalarMul,
  scalarToBytes,
} from "./bls.js";
import { fsHashSchnorr } from "./hash.js";
import { deriveNonce } from "./nonce.js";

export type SchnorrProof = {
  t: Uint8Array; // 48 bytes
  z: Uint8Array; // 32 bytes
};

/** Compute the public point `u = [x]·base` for a given secret. */
export function publicPoint(base: G1Point, secret: Scalar): G1Point {
  if (secret <= 0n || secret >= SCALAR_ORDER) {
    throw new Error("secret must be in [1, r)");
  }
  return scalarMul(secret, base);
}

/** Convenience: `u = [x]·g`. */
export function publicPointG(secret: Scalar): G1Point {
  return publicPoint(generator(), secret);
}

/**
 * Generate a Schnorr proof for `u = [secret]·base` bound to `ctx`. The proof is
 * deterministic in `(secret, base, u, ctx)` thanks to RFC 6979 — the same call
 * site produces byte-identical proofs across runs and platforms.
 */
export function proveSchnorr(
  base: G1Point,
  secret: Scalar,
  ctx: Uint8Array,
): SchnorrProof {
  const baseBytes = pointToBytes(base);
  const u = publicPoint(base, secret);
  const uBytes = pointToBytes(u);

  // Message that pins the nonce to this exact statement+context.
  const nonceMessage = new Uint8Array(
    baseBytes.length + uBytes.length + ctx.length,
  );
  nonceMessage.set(baseBytes, 0);
  nonceMessage.set(uBytes, baseBytes.length);
  nonceMessage.set(ctx, baseBytes.length + uBytes.length);

  const r_p = deriveNonce(secret, nonceMessage);
  const t = scalarMul(r_p, base);
  const tBytes = pointToBytes(t);

  const cBytes = fsHashSchnorr(baseBytes, uBytes, tBytes, ctx);
  const c = reduceScalar(bytesToBigIntBE(cBytes));

  const z = (r_p + ((c * secret) % SCALAR_ORDER)) % SCALAR_ORDER;
  return { t: tBytes, z: scalarToBytes(z) };
}

/**
 * Verify a Schnorr proof. Returns false on any structural defect (wrong-length
 * fields, non-canonical scalar, point not in subgroup) rather than throwing.
 */
export function verifySchnorr(
  base: G1Point,
  point: G1Point, // u = [x]·base
  proof: SchnorrProof,
  ctx: Uint8Array,
): boolean {
  if (proof.t.length !== G1_COMPRESSED_BYTES) return false;
  if (proof.z.length !== SCALAR_BYTES) return false;

  let t: G1Point;
  try {
    t = pointFromBytes(proof.t);
  } catch {
    return false;
  }
  let z: bigint;
  try {
    // Canonical: z must encode a value strictly less than r.
    z = bytesToBigIntBE(proof.z);
    if (z >= SCALAR_ORDER) return false;
  } catch {
    return false;
  }

  const baseBytes = pointToBytes(base);
  const uBytes = pointToBytes(point);
  const cBytes = fsHashSchnorr(baseBytes, uBytes, proof.t, ctx);
  const c = reduceScalar(bytesToBigIntBE(cBytes));

  // [z]·base == t + [c]·u
  const lhs = scalarMul(z, base);
  const rhs = pointAdd(t, scalarMul(c, point));
  return pointEqual(lhs, rhs);
}
