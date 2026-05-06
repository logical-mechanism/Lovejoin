//// BLS12-381 G1 wrappers for Lovejoin's sigma-protocol verifiers.
////
//// Spec: (see CLAUDE.md)
////   - Curve: BLS12-381 G1, 48-byte compressed points, 32-byte big-endian scalars.
////   - r = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001

use aiken/builtin
use aiken/crypto/bitwise.{State}
use aiken/crypto/bls12_381/g1
use aiken/crypto/bls12_381/scalar.{Scalar, field_prime}
use aiken/primitive/bytearray

/// Compressed group-element size in bytes.
pub const g1_compressed_bytes: Int = 48

/// Canonical scalar serialization size in bytes (big-endian).
pub const scalar_bytes: Int = 32

/// Order of G1's prime-order subgroup.
pub const scalar_order: Int = field_prime

/// Canonical generator of G1 (compressed bytes from the spec).
pub const generator: G1Element = g1.generator

/// Decode a 48-byte compressed G1 point. Aborts if the bytes are not a valid
/// element of the prime-order subgroup (the builtin `uncompress` performs the
/// subgroup check) or if the byte length is not 48 (the builtin's
/// deserialiser only accepts exactly 48 bytes; wrong-length input fails the
/// uncompress with a `BLST_BAD_ENCODING` error). Length is therefore enforced
/// by the builtin; an explicit `bytearray.length` pre-check would be a
/// belt-and-suspenders duplicate.
pub fn point_from_bytes(bytes: ByteArray) -> G1Element {
  builtin.bls12_381_g1_uncompress(bytes)
}

/// Compress a G1 point to its 48-byte canonical encoding.
pub fn point_to_bytes(p: G1Element) -> ByteArray {
  builtin.bls12_381_g1_compress(p)
}

/// Decode a 32-byte big-endian scalar in `Z_r`. Aborts if the value is not strictly
/// less than `r` — only canonical encodings are accepted, mirroring the TS prover.
pub fn scalar_from_bytes(bytes: ByteArray) -> State<Scalar> {
  expect bytearray.length(bytes) == scalar_bytes
  let v = builtin.bytearray_to_integer(True, bytes)
  expect v < scalar_order
  scalar.from_int(v)
}

/// Decode a challenge byte string by reducing it modulo `r`. Used for the Fiat-Shamir
/// challenge `c mod r`, which is allowed to wrap. No length restriction — the bytes
/// are treated as a big-endian non-negative integer.
pub fn scalar_from_bytes_mod(bytes: ByteArray) -> State<Scalar> {
  let v = builtin.bytearray_to_integer(True, bytes)
  scalar.from_int(v)
}

/// Scalar multiplication [k]P.
pub fn scalar_mul(k: State<Scalar>, p: G1Element) -> G1Element {
  g1.scale(p, k)
}

/// Group addition P + Q.
pub fn point_add(p: G1Element, q: G1Element) -> G1Element {
  g1.add(p, q)
}

/// Group subtraction P - Q.
pub fn point_sub(p: G1Element, q: G1Element) -> G1Element {
  g1.sub(p, q)
}

/// Group equality.
pub fn point_equal(p: G1Element, q: G1Element) -> Bool {
  g1.equal(p, q)
}
