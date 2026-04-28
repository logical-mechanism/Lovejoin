//// N-way sigma-OR verifier (Cramer-Damgård OR composition; spec §"N-way Sigma-OR").
////
//// Statement: prover knows the DH-tuple witness for at least one of N branches
////   τ_i = proveDHTuple(a, b, a'_i, b'_i),  i ∈ {0..N-1}.
////
//// The verifier:
////   1. Recompute c = H(a, b, all (a'_i, b'_i), all (t_{i,0}, t_{i,1}), ctx).
////   2. Check c == XOR_{i=0..N-1} c_i  (bytewise — c_i are RAW 32-byte strings).
////   3. For each i: check
////      [z_i]·a == t_{i,0} + [c_i mod r]·a'_i
////      [z_i]·b == t_{i,1} + [c_i mod r]·b'_i.
////
//// On Cardano this validator runs once per mix-input; per-instance cost is
//// approximately 2N scalar muls + 2N adds + 2N+2 uncompresses + 1 blake2b.
//// Per-tx cost (N inputs × N branches) is ~2N², so `max_n` is calibrated empirically
//// against the mainnet script-cost budget at M2 close.

use aiken/builtin
use aiken/collection/list
use aiken/primitive/bytearray
use lovejoin/bls
use lovejoin/hash.{SigmaOrCommitment, SigmaOrStatementBranch}
use lovejoin/hash as hash_mod

pub type SigmaOrBranch {
  t0: ByteArray,
  t1: ByteArray,
  c: ByteArray,
  z: ByteArray,
}

pub type SigmaOrProof {
  branches: List<SigmaOrBranch>,
}

pub type DHTupleStatement {
  ap: ByteArray,
  bp: ByteArray,
}

/// XOR two equal-length 32-byte arrays, produced via per-byte bitwise XOR using
/// the integer-wide `xor_bytearray` builtin.
fn xor32(left: ByteArray, right: ByteArray) -> ByteArray {
  expect bytearray.length(left) == 32
  expect bytearray.length(right) == 32
  builtin.xor_bytearray(False, left, right)
}

/// Verify an N-way sigma-OR proof.
///
/// `max_n` is enforced by the caller (the validator looks it up from the reference
/// UTxO's ProtocolParams); this verifier only enforces N >= 2.
pub fn verify(
  a: ByteArray,
  b: ByteArray,
  statements: List<DHTupleStatement>,
  proof: SigmaOrProof,
  ctx: ByteArray,
) -> Bool {
  let n = list.length(statements)
  expect n >= 2
  expect list.length(proof.branches) == n

  // Decompose the lists into the byte-only form expected by hash.fs_hash_sigma_or
  // and the geometric data needed for per-branch checks.
  let stmt_for_hash =
    list.map(
      statements,
      fn(s) { SigmaOrStatementBranch { ap: s.ap, bp: s.bp } },
    )
  let commitments_for_hash =
    list.map(
      proof.branches,
      fn(br) { SigmaOrCommitment { t0: br.t0, t1: br.t1 } },
    )
  let c_global =
    hash_mod.fs_hash_sigma_or(a, b, stmt_for_hash, commitments_for_hash, ctx)

  // c_global == XOR of all per-branch c_i.
  let zero32 =
    #"0000000000000000000000000000000000000000000000000000000000000000"
  let xor_of_branch_c =
    list.foldl(proof.branches, zero32, fn(br, acc) { xor32(acc, br.c) })
  expect c_global == xor_of_branch_c

  // Per-branch DH-tuple equations.
  let a_pt = bls.point_from_bytes(a)
  let b_pt = bls.point_from_bytes(b)

  let pairs = list.map2(statements, proof.branches, fn(stmt, br) { (stmt, br) })
  list.all(
    pairs,
    fn(pair) {
      let (stmt, br) = pair
      let ap_pt = bls.point_from_bytes(stmt.ap)
      let bp_pt = bls.point_from_bytes(stmt.bp)
      let t0_pt = bls.point_from_bytes(br.t0)
      let t1_pt = bls.point_from_bytes(br.t1)
      let z = bls.scalar_from_bytes(br.z)
      let c = bls.scalar_from_bytes_mod(br.c)

      let lhs0 = bls.scalar_mul(z, a_pt)
      let rhs0 = bls.point_add(t0_pt, bls.scalar_mul(c, ap_pt))
      let lhs1 = bls.scalar_mul(z, b_pt)
      let rhs1 = bls.point_add(t1_pt, bls.scalar_mul(c, bp_pt))
      bls.point_equal(lhs0, rhs0) && bls.point_equal(lhs1, rhs1)
    },
  )
}
