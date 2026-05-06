//// Schnorr / proveDlog verifier.
////
//// Spec: §"Schnorr / proveDlog".
////
//// Statement: prover knows `x ∈ Z_r` such that `u = [x]·base`.
//// Verifier accepts iff `[z]·base == t + [c]·u`, where
////   c = H(base, u, t, ctx) mod r       (lovejoin/hash.fs_hash_schnorr)
////
//// The verifier is base-parametric: the on-chain Owner branch passes `base = a`
//// (the box's first datum field) and `u = b`; vanilla Schnorr uses the canonical
//// generator. This module performs no signer / output checks — those live in the
//// validator that calls it.

use lovejoin/bls
use lovejoin/hash

/// `t` is 48 bytes (compressed G1), `z` is 32 bytes (canonical big-endian scalar).
pub type SchnorrProof {
  t: ByteArray,
  z: ByteArray,
}

/// Verify a Schnorr proof for `u = [x]·base` bound to `ctx`.
///
/// `base` and `u` are 48-byte compressed G1 points; non-canonical / wrong-length
/// inputs cause `expect`-driven script failure (the spec's intent: malformed
/// proofs MUST be rejected, and rejection on chain manifests as failed validation,
/// not a `False` return). Same goes for non-canonical scalars.
pub fn verify(
  base: ByteArray,
  u: ByteArray,
  proof: SchnorrProof,
  ctx: ByteArray,
) -> Bool {
  let base_pt = bls.point_from_bytes(base)
  let u_pt = bls.point_from_bytes(u)
  let t_pt = bls.point_from_bytes(proof.t)
  let z = bls.scalar_from_bytes(proof.z)

  let c_bytes = hash.fs_hash_schnorr(base, u, proof.t, ctx)
  let c = bls.scalar_from_bytes_mod(c_bytes)

  let lhs = bls.scalar_mul(z, base_pt)
  let rhs = bls.point_add(t_pt, bls.scalar_mul(c, u_pt))
  bls.point_equal(lhs, rhs)
}
