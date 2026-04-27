//// Sanity tests for the BLS12-381 G1 wrappers in `lovejoin/bls`.

use aiken/crypto/bls12_381/scalar
use lovejoin/bls

// 48-byte zero vector (canonical infinity is `c0 || 00*47`, but the all-zero
// bytes are NOT a valid compressed point — uncompress should fail).
const all_zero_48: ByteArray =
  #"000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

// Infinity in G1 (high bit + compressed flag).
const infinity_48: ByteArray =
  #"c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

test generator_round_trips() {
  let g = bls.generator
  let g_bytes = bls.point_to_bytes(g)
  let g_back = bls.point_from_bytes(g_bytes)
  bls.point_equal(g, g_back)
}

test scalar_mul_one_is_identity() {
  let g = bls.generator
  let one = scalar.from_int(1)
  bls.point_equal(bls.scalar_mul(one, g), g)
}

test scalar_mul_distributes_over_addition() {
  let g = bls.generator
  let two = scalar.from_int(2)
  let three = scalar.from_int(3)
  let five = scalar.from_int(5)
  let lhs = bls.point_add(bls.scalar_mul(two, g), bls.scalar_mul(three, g))
  let rhs = bls.scalar_mul(five, g)
  bls.point_equal(lhs, rhs)
}

test point_sub_is_inverse_of_add() {
  let g = bls.generator
  let a = bls.scalar_mul(scalar.from_int(11), g)
  let b = bls.scalar_mul(scalar.from_int(7), g)
  bls.point_equal(bls.point_sub(bls.point_add(a, b), b), a)
}

test scalar_from_bytes_rejects_field_prime() fail {
  // 32 bytes encoding `r` itself (>= r) — must be rejected.
  let r_bytes: ByteArray =
    #"73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001"
  let s = bls.scalar_from_bytes(r_bytes)
  bls.point_equal(bls.scalar_mul(s, bls.generator), bls.generator)
}

test point_from_bytes_rejects_all_zero() fail {
  let p = bls.point_from_bytes(all_zero_48)
  bls.point_equal(p, bls.generator)
}

test point_from_bytes_accepts_infinity() {
  let inf = bls.point_from_bytes(infinity_48)
  // Infinity + g should equal g.
  bls.point_equal(bls.point_add(inf, bls.generator), bls.generator)
}
