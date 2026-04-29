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

/// Statement with both raw bytes (for the FS hash preimage) AND the
/// uncompressed G1 points (for the per-branch DH-tuple equations).
/// Construct once via `precompute_statements` and reuse across the N
/// per-input `verify_pre` calls in a Mix tx — that reuse is the main
/// CPU-budget optimisation at high N (saves N²−N uncompressions of
/// the output statement points; each `bls12_381_g1_uncompress` is the
/// dominant per-op cost in the validator).
pub type DHTupleStatementPt {
  ap: ByteArray,
  bp: ByteArray,
  ap_pt: G1Element,
  bp_pt: G1Element,
}

/// Pre-uncompress a list of statements once. The Mix-tx validator
/// runs N input proofs, each over the same N output (a', b') pairs;
/// without pre-computation each verifier call would re-uncompress
/// every statement point (= N² uncompresses). With this, the per-tx
/// uncompress count for statements drops to N.
pub fn precompute_statements(
  statements: List<DHTupleStatement>,
) -> List<DHTupleStatementPt> {
  list.map(
    statements,
    fn(s) {
      DHTupleStatementPt {
        ap: s.ap,
        bp: s.bp,
        ap_pt: bls.point_from_bytes(s.ap),
        bp_pt: bls.point_from_bytes(s.bp),
      }
    },
  )
}

/// XOR two equal-length 32-byte arrays via the integer-wide `xor_bytearray`
/// builtin. The `False` padding flag aborts the builtin if the two inputs
/// differ in length, so the right-side length is implicitly enforced.
///
/// The previous `expect bytearray.length(left) == 32` was redundant: in the
/// XOR fold inside `verify_pre`, the seed is `zero32` (32 bytes) and
/// `xor_bytearray(False, l32, r)` returns 32 bytes only when `r` is also 32
/// (otherwise it aborts). By induction, `acc` is always 32 bytes, and a
/// non-32-byte `br.c` is caught by the builtin on the first iteration. N²
/// builtin pairs (length + ==) saved per Mix tx — see audit H3.
fn xor32(left: ByteArray, right: ByteArray) -> ByteArray {
  builtin.xor_bytearray(False, left, right)
}

/// Verify an N-way sigma-OR proof.
///
/// `max_n` is enforced by the caller (the validator looks it up from the reference
/// UTxO's ProtocolParams); this verifier only enforces N >= 2.
///
/// This is the convenience wrapper for callers that don't pre-uncompress
/// the statement points — it does the uncompression on every call.
/// The Mix-tx validator should use `verify_pre` instead, which accepts
/// pre-uncompressed statements and saves N²−N uncompressions per tx.
pub fn verify(
  a: ByteArray,
  b: ByteArray,
  statements: List<DHTupleStatement>,
  proof: SigmaOrProof,
  ctx: ByteArray,
) -> Bool {
  let n = list.length(statements)
  expect n <= 255
  let header_const_prefix = hash_mod.fs_hash_sigma_or_header_const_prefix(n)
  verify_pre(
    a,
    b,
    precompute_statements(statements),
    proof,
    ctx,
    header_const_prefix,
  )
}

/// Variant of `verify` that takes statements with their G1 points
/// already uncompressed. Use this when the same statement set is
/// verified against multiple (input, proof) pairs in the same tx —
/// each `bls12_381_g1_uncompress` is one of the most expensive ops
/// in the validator (roughly 25-30M CPU steps), so amortising N²
/// re-uncompresses down to N is the single biggest knob for raising
/// the Mix tx's `max_n` ceiling.
///
/// `header_const_prefix` is `DOMAIN || 0x03 || N(1 byte)` — constant
/// across the N inputs of a single Mix tx. The caller (validate_mix)
/// builds it once via `hash.fs_hash_sigma_or_header_const_prefix(n)`,
/// having already enforced `2 <= n <= 255`. We just append the per-input
/// (a, b). Saves 2 concats + 1 `from_int_big_endian` per call (= 2N+N
/// per Mix tx).
pub fn verify_pre(
  a: ByteArray,
  b: ByteArray,
  statements: List<DHTupleStatementPt>,
  proof: SigmaOrProof,
  ctx: ByteArray,
  header_const_prefix: ByteArray,
) -> Bool {
  // O(1) guard: at least two statements. Length parity between
  // `statements` and `proof.branches` is enforced by `parallel_all`'s
  // `_ -> False` arm below — no need to walk the lists for it. The
  // 1-byte N-prefix bound (`n <= 255`) is enforced by the caller before
  // building `header_const_prefix`.
  expect [_, _, ..] = statements

  // FS hash, walking the typed lists directly. The previous version
  // allocated two N-element wrapper-struct lists (SigmaOrStatementBranch,
  // SigmaOrCommitment) just to feed `hash.fs_hash_sigma_or`. Reading the
  // .ap/.bp/.t0/.t1 byte fields off the existing structs preserves the
  // canonical wire layout — see hash.fs_hash_sigma_or for that layout
  // and encoding_parity_kat.test.ak for the byte-equal proof. Saves
  // 2N wrapper allocs per `verify_pre` call (= 2N² per Mix tx).
  let header =
    hash_mod.fs_hash_sigma_or_header_with_prefix(header_const_prefix, a, b)
  let with_branches =
    list.foldl(
      statements,
      header,
      fn(s, acc) { acc |> bytearray.concat(s.ap) |> bytearray.concat(s.bp) },
    )
  let with_commitments =
    list.foldl(
      proof.branches,
      with_branches,
      fn(br, acc) { acc |> bytearray.concat(br.t0) |> bytearray.concat(br.t1) },
    )
  let c_global = builtin.blake2b_256(with_commitments |> bytearray.concat(ctx))

  // c_global == XOR of all per-branch c_i.
  let zero32 =
    #"0000000000000000000000000000000000000000000000000000000000000000"
  let xor_of_branch_c =
    list.foldl(proof.branches, zero32, fn(br, acc) { xor32(acc, br.c) })
  expect c_global == xor_of_branch_c

  // Per-branch DH-tuple equations. Input points uncompressed once
  // per call (unique per input; can't share across N calls).
  let a_pt = bls.point_from_bytes(a)
  let b_pt = bls.point_from_bytes(b)

  // Walk statements + branches in lockstep without allocating an
  // intermediate `(stmt, branch)` pair list — this loop runs N×N
  // times across a Mix tx, so the alloc savings add up.
  parallel_all(
    statements,
    proof.branches,
    fn(stmt, br) {
      let t0_pt = bls.point_from_bytes(br.t0)
      let t1_pt = bls.point_from_bytes(br.t1)
      let z = bls.scalar_from_bytes(br.z)
      let c = bls.scalar_from_bytes_mod(br.c)

      let lhs0 = bls.scalar_mul(z, a_pt)
      let rhs0 = bls.point_add(t0_pt, bls.scalar_mul(c, stmt.ap_pt))
      let lhs1 = bls.scalar_mul(z, b_pt)
      let rhs1 = bls.point_add(t1_pt, bls.scalar_mul(c, stmt.bp_pt))
      bls.point_equal(lhs0, rhs0) && bls.point_equal(lhs1, rhs1)
    },
  )
}

/// Like `list.all` over `list.zip(xs, ys)` but without allocating the
/// intermediate pair list. The caller asserts xs.length == ys.length;
/// returns False for length mismatch. Inlined here so the per-branch
/// hot loop in `verify_pre` doesn't pay for `list.zip` + `list.all`.
fn parallel_all(
  xs: List<DHTupleStatementPt>,
  ys: List<SigmaOrBranch>,
  pred: fn(DHTupleStatementPt, SigmaOrBranch) -> Bool,
) -> Bool {
  when (xs, ys) is {
    ([], []) -> True
    ([x, ..xt], [y, ..yt]) ->
      if pred(x, y) {
        parallel_all(xt, yt, pred)
      } else {
        False
      }
    _ -> False
  }
}
