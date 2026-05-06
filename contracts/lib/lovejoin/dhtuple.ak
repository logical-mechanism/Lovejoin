//// proveDHTuple verifier.
////
//// Spec: §"proveDHTuple".
////
//// Statement: prover knows `x ∈ Z_r` such that `u = [x]·g` AND `v = [x]·h`.
//// In Mix branch terms: g=a, h=b, u=a', v=b'. Verifier accepts iff
////   [z]·g == t0 + [c]·u  AND  [z]·h == t1 + [c]·v
//// with c = H(g, h, u, v, t0, t1, ctx) mod r.
////
//// Each call uncompresses the six 48-byte inputs once. Per-call cost (rough):
//// 6× G1 uncompress, 4× scalar mul, 2× G1 add, 1× blake2b, 2× G1 equal.

use lovejoin/bls
use lovejoin/hash

pub type DHTupleProof {
  t0: ByteArray,
  t1: ByteArray,
  z: ByteArray,
}

pub fn verify(
  g: ByteArray,
  h: ByteArray,
  u: ByteArray,
  v: ByteArray,
  proof: DHTupleProof,
  ctx: ByteArray,
) -> Bool {
  let g_pt = bls.point_from_bytes(g)
  let h_pt = bls.point_from_bytes(h)
  let u_pt = bls.point_from_bytes(u)
  let v_pt = bls.point_from_bytes(v)
  let t0_pt = bls.point_from_bytes(proof.t0)
  let t1_pt = bls.point_from_bytes(proof.t1)
  let z = bls.scalar_from_bytes(proof.z)

  let c_bytes = hash.fs_hash_dh_tuple(g, h, u, v, proof.t0, proof.t1, ctx)
  let c = bls.scalar_from_bytes_mod(c_bytes)

  let lhs0 = bls.scalar_mul(z, g_pt)
  let rhs0 = bls.point_add(t0_pt, bls.scalar_mul(c, u_pt))
  let lhs1 = bls.scalar_mul(z, h_pt)
  let rhs1 = bls.point_add(t1_pt, bls.scalar_mul(c, v_pt))

  bls.point_equal(lhs0, rhs0) && bls.point_equal(lhs1, rhs1)
}
