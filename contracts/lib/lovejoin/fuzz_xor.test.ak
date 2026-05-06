//// Property-based tests for the bytewise XOR fold used in
//// sigma_or.verify_pre.
////
//// Audit F-19 (next-redeploy bundle Q-3): the OR-equation check folds
//// branch challenges via 32-byte XOR. The fold's correctness rests on
//// three invariants: length preservation, commutativity (so the order
//// of branches in the FS preimage doesn't matter for the c_global
//// derivation we already pin elsewhere), and self-inverse (allows
//// extracting any single branch's challenge given the others). Pre-fix
//// these were exercised by the variable-N positive-prologue tests
//// only; fuzzing pins them directly.
////
//// Tested at the `builtin.xor_bytearray` level — `xor32` in sigma_or.ak
//// is a thin wrapper. If the builtin satisfies the properties, the
//// wrapper does too.

use aiken/builtin
use aiken/fuzz
use aiken/primitive/bytearray

const xor_size: Int = 32

fn ba32() -> Fuzzer<ByteArray> {
  fuzz.bytearray_fixed(xor_size)
}

fn ba32_pair() -> Fuzzer<(ByteArray, ByteArray)> {
  fuzz.map2(ba32(), ba32(), fn(a, b) { (a, b) })
}

fn ba32_triple() -> Fuzzer<(ByteArray, ByteArray, ByteArray)> {
  fuzz.map3(ba32(), ba32(), ba32(), fn(a, b, c) { (a, b, c) })
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

test prop_xor_length_preservation(args via ba32_pair()) {
  let (a, b) = args
  bytearray.length(builtin.xor_bytearray(False, a, b)) == xor_size
}

test prop_xor_self_inverse(a via ba32()) {
  // a XOR a = 0
  let zero = builtin.xor_bytearray(False, a, a)
  zero == #"0000000000000000000000000000000000000000000000000000000000000000"
}

test prop_xor_commutative(args via ba32_pair()) {
  let (a, b) = args
  builtin.xor_bytearray(False, a, b) == builtin.xor_bytearray(False, b, a)
}

test prop_xor_associative(args via ba32_triple()) {
  // (a XOR b) XOR c == a XOR (b XOR c). Used by the validator's fold —
  // it folds branches left-to-right but the math is order-invariant.
  let (a, b, c) = args
  let left = builtin.xor_bytearray(False, builtin.xor_bytearray(False, a, b), c)
  let right =
    builtin.xor_bytearray(False, a, builtin.xor_bytearray(False, b, c))
  left == right
}

test prop_xor_zero_is_identity(a via ba32()) {
  // a XOR 0 == a. Holds for the fold's seed (zero32 in sigma_or).
  let zero = #"0000000000000000000000000000000000000000000000000000000000000000"
  builtin.xor_bytearray(False, a, zero) == a
}
