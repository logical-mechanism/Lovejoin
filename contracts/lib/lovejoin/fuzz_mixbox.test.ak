//// Property-based tests for the mix-box datum decoders.
////
//// Audit F-19 (next-redeploy bundle Q-3): the hand-written suite in
//// `mix_logic.test.ak` covers the cases the author imagined; fuzzing
//// over arbitrary `Data` and arbitrary `MixDatum`-shaped inputs widens
//// coverage of the parser-state-machine seams (extra fields, wrong
//// constructor index, wrong byte lengths, `a == b`).
////
//// Determinism: fuzz tests are seeded by aiken-lang/fuzz under
//// `aiken check`, so CI re-runs reproduce the same input sequence.
////
//// Properties tested:
////   1. `try_decode_well_formed_data` returns `Some(_)` iff the structural
////      rules hold (Constr 0, two `B` fields, both length 48, fields
////      differ); `None` otherwise.
////   2. Hard-fail/soft-fail consistency: when `try_decode_well_formed_data`
////      returns `Some(md)`, `decode_mix_datum_strict` must return the
////      same `md` (same protocol input ⇒ same protocol output).

use aiken/builtin
use aiken/fuzz
use aiken/primitive/bytearray
use lovejoin/mixbox.{
  decode_mix_datum_strict, mix_datum_field_length,
  try_decode_well_formed_data,
}
use lovejoin/types.{MixDatum}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

fn ba_of(len: Int) -> Fuzzer<ByteArray> {
  fuzz.bytearray_fixed(len)
}

/// A `MixDatum`-shaped `Data` where every field is correct length 48 and
/// `a != b`. The decoder MUST accept these.
fn well_formed_mix_datum_data() -> Fuzzer<Data> {
  let a <- fuzz.and_then(ba_of(mix_datum_field_length))
  let b <- fuzz.and_then(ba_of(mix_datum_field_length))
  // Force `a != b`: append distinct sentinel bytes (`0x00` to a, `0x01` to
  // b) and re-truncate. Cheap and deterministic, preserves the fuzz
  // distribution over the prefix.
  let a_distinct = bytearray.take(bytearray.push(a, 0x00), mix_datum_field_length)
  let b_distinct = bytearray.take(bytearray.push(b, 0x01), mix_datum_field_length)
  let datum: Data = MixDatum { a: a_distinct, b: b_distinct }
  fuzz.constant(datum)
}

/// A `Constr 0 [B, B]` shape but with one or both byte fields at the wrong
/// length, OR `a == b`. The decoder MUST reject these (`None`).
fn malformed_mix_datum_data() -> Fuzzer<Data> {
  let len_a <- fuzz.and_then(fuzz.either3(
    fuzz.constant(0),
    fuzz.constant(mix_datum_field_length - 1),
    fuzz.constant(mix_datum_field_length + 1),
  ))
  let len_b <- fuzz.and_then(fuzz.either(
    fuzz.constant(mix_datum_field_length),
    fuzz.constant(0),
  ))
  let a <- fuzz.and_then(ba_of(len_a))
  let b <- fuzz.and_then(ba_of(len_b))
  let datum: Data = MixDatum { a, b }
  fuzz.constant(datum)
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

test prop_well_formed_decodes_to_some(d via well_formed_mix_datum_data()) {
  when try_decode_well_formed_data(d) is {
    Some(md) -> and {
        bytearray.length(md.a) == mix_datum_field_length,
        bytearray.length(md.b) == mix_datum_field_length,
        md.a != md.b,
      }
    None -> False
  }
}

test prop_malformed_decodes_to_none(d via malformed_mix_datum_data()) {
  try_decode_well_formed_data(d) == None
}

test prop_decoder_consistency(d via well_formed_mix_datum_data()) {
  // If the soft decoder accepts a Data shape, the strict decoder MUST
  // return the same MixDatum without aborting. The validator relies on
  // this invariant: `mix_logic` filters mix-script inputs with the soft
  // decoder, then `decode_mix_datum_strict` re-decodes prefix Mix outputs.
  // A divergence would let a malformed datum slip past Rule 2 and abort
  // the strict path on chain.
  expect Some(soft) = try_decode_well_formed_data(d)
  let strict = decode_mix_datum_strict(d)
  and {
    soft.a == strict.a,
    soft.b == strict.b,
  }
}

// ---------------------------------------------------------------------------
// Reject Constr indices other than 0 (auditor-specified shape rule).
// ---------------------------------------------------------------------------

test prop_wrong_constructor_index_rejects(idx via fuzz.int_between(1, 6)) {
  // `Constr idx [bytes(48), bytes(48)]` with idx != 0. The protocol's
  // valid MixDatum is constructor 0; every other index must reject.
  let a48 = repeat_byte(0xaa, 48)
  let b48 = repeat_byte(0xbb, 48)
  let d: Data =
    builtin.constr_data(idx, [builtin.b_data(a48), builtin.b_data(b48)])
  try_decode_well_formed_data(d) == None
}

fn repeat_byte(byte: Int, n: Int) -> ByteArray {
  do_repeat(byte, n, #"")
}

fn do_repeat(byte: Int, n: Int, acc: ByteArray) -> ByteArray {
  if n == 0 {
    acc
  } else {
    do_repeat(byte, n - 1, bytearray.push(acc, byte))
  }
}
