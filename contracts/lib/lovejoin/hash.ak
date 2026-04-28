//// Fiat-Shamir challenge construction for the sigma-protocol verifiers.
////
//// Spec: docs/spec/02-cryptography.md §"Hash function and Fiat-Shamir context binding".
////
//// All inputs are pre-encoded as `ByteArray` (compressed group elements at 48 bytes,
//// scalars at 32 bytes, etc.); the hash is plain byte concatenation, no CBOR.
//// This is what makes byte-for-byte parity with the TS prover possible
//// (see docs/spec/12-build-guide.md §Risk 1).

use aiken/collection/list
use aiken/crypto.{blake2b_256}
use aiken/primitive/bytearray

/// Domain-separation tag for v1 of the protocol. ASCII; never CBOR-encoded.
pub const domain_tag_v1: ByteArray = "lovejoin/sigmajoin/v1/"

/// 1-byte statement identifiers.
pub const statement_id_prove_dlog: ByteArray = #"01"

pub const statement_id_prove_dh_tuple: ByteArray = #"02"

pub const statement_id_sigma_or_n: ByteArray = #"03"

/// Schnorr Fiat-Shamir hash: H(DOMAIN || 0x01 || g || u || t || ctx).
pub fn fs_hash_schnorr(
  g: ByteArray,
  u: ByteArray,
  t: ByteArray,
  ctx: ByteArray,
) -> ByteArray {
  blake2b_256(
    domain_tag_v1
      |> bytearray.concat(statement_id_prove_dlog)
      |> bytearray.concat(g)
      |> bytearray.concat(u)
      |> bytearray.concat(t)
      |> bytearray.concat(ctx),
  )
}

/// proveDHTuple Fiat-Shamir hash: H(DOMAIN || 0x02 || g || h || u || v || t0 || t1 || ctx).
pub fn fs_hash_dh_tuple(
  g: ByteArray,
  h: ByteArray,
  u: ByteArray,
  v: ByteArray,
  t0: ByteArray,
  t1: ByteArray,
  ctx: ByteArray,
) -> ByteArray {
  blake2b_256(
    domain_tag_v1
      |> bytearray.concat(statement_id_prove_dh_tuple)
      |> bytearray.concat(g)
      |> bytearray.concat(h)
      |> bytearray.concat(u)
      |> bytearray.concat(v)
      |> bytearray.concat(t0)
      |> bytearray.concat(t1)
      |> bytearray.concat(ctx),
  )
}

pub type SigmaOrStatementBranch {
  ap: ByteArray,
  bp: ByteArray,
}

pub type SigmaOrCommitment {
  t0: ByteArray,
  t1: ByteArray,
}

/// Canonical sigma-OR FS preimage prefix (everything before the per-branch
/// fields): `DOMAIN || 0x03 || N(1 byte) || a || b`. Exposed so callers
/// that want to walk *typed* per-branch lists (sigma_or.verify_pre) can
/// share the prefix without going through the wrapper-struct codepath.
/// `n` is required as a 1-byte big-endian prefix; callers must enforce
/// `2 <= n <= 255` themselves before calling.
pub fn fs_hash_sigma_or_header(a: ByteArray, b: ByteArray, n: Int) -> ByteArray {
  let n_byte = bytearray.from_int_big_endian(n, 1)
  domain_tag_v1
    |> bytearray.concat(statement_id_sigma_or_n)
    |> bytearray.concat(n_byte)
    |> bytearray.concat(a)
    |> bytearray.concat(b)
}

/// N-way sigma-OR Fiat-Shamir hash. `branches` and `commitments` MUST have the same
/// length N (the verifier enforces this; see `lovejoin/sigma_or`).
///
/// Layout: DOMAIN || 0x03 || N(1 byte) || a || b
///       || a'_0 || b'_0 || ... || a'_{N-1} || b'_{N-1}
///       || t_{0,0} || t_{0,1} || ... || t_{N-1,0} || t_{N-1,1} || ctx
pub fn fs_hash_sigma_or(
  a: ByteArray,
  b: ByteArray,
  branches: List<SigmaOrStatementBranch>,
  commitments: List<SigmaOrCommitment>,
  ctx: ByteArray,
) -> ByteArray {
  let n = list.length(branches)
  expect n == list.length(commitments)
  expect n >= 2
  expect n <= 255
  let header = fs_hash_sigma_or_header(a, b, n)
  let with_branches =
    list.foldl(
      branches,
      header,
      fn(br, acc) { acc |> bytearray.concat(br.ap) |> bytearray.concat(br.bp) },
    )
  let with_commitments =
    list.foldl(
      commitments,
      with_branches,
      fn(c, acc) { acc |> bytearray.concat(c.t0) |> bytearray.concat(c.t1) },
    )
  blake2b_256(with_commitments |> bytearray.concat(ctx))
}
