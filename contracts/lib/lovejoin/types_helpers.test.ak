//// Unit tests for the lib helpers underlying Rule 2 (hyperstructure datum tolerance).
////
//// Spec: §0, §2 (well-formed MixDatum), §3 (unit fee datum).

use cardano/transaction.{DatumHash, InlineDatum, NoDatum}
use lovejoin/fee
use lovejoin/mixbox
use lovejoin/types.{MixDatum}

// ---------------------------------------------------------------------------
// try_decode_well_formed_*: positive
// ---------------------------------------------------------------------------

const a48: ByteArray =
  #"97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb"

const b48: ByteArray =
  #"a572cbea904d67468808c8eb50a9450c9721db309128012543902d0ac358a62ae28f75bb8f1c7c42c39a8c5529bf0f4e"

const c48: ByteArray =
  #"89ece308f9d1f0131765212deca99697b112d61f9be9a5f1f3780a51335b3ff981747a0b2ca2179b96d2c0c9024e5224"

test mix_datum_decode_positive() {
  let d: Data = MixDatum { a: a48, b: b48 }
  mixbox.try_decode_well_formed_data(d) == Some(MixDatum { a: a48, b: b48 })
}

test mix_datum_decode_a_eq_b() {
  // Spec rule: a != b. Datum where a == b is malformed → None.
  let d: Data = MixDatum { a: a48, b: a48 }
  mixbox.try_decode_well_formed_data(d) == None
}

test mix_datum_decode_short_a() {
  // Spec rule: bytearray.length(a) == 48.
  let d: Data = MixDatum { a: #"01", b: b48 }
  mixbox.try_decode_well_formed_data(d) == None
}

test mix_datum_decode_short_b() {
  let d: Data = MixDatum { a: a48, b: #"02" }
  mixbox.try_decode_well_formed_data(d) == None
}

test mix_datum_decode_long_a() {
  // 49-byte a (out by one): malformed.
  let d: Data =
    MixDatum {
      a: #"97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb00",
      b: b48,
    }
  mixbox.try_decode_well_formed_data(d) == None
}

test mix_datum_decode_inline_no_datum() {
  // NoDatum / DatumHash inputs return None — not a well-formed inline MixDatum.
  mixbox.try_decode_well_formed_inline(NoDatum) == None
}

test mix_datum_decode_datum_hash() {
  let zero32 =
    #"0000000000000000000000000000000000000000000000000000000000000000"
  mixbox.try_decode_well_formed_inline(DatumHash(zero32)) == None
}

test mix_datum_decode_inline_well_formed() {
  let d: Data = MixDatum { a: a48, b: c48 }
  mixbox.try_decode_well_formed_inline(InlineDatum(d)) == Some(
    MixDatum { a: a48, b: c48 },
  )
}

test mix_datum_decode_optional_none() {
  mixbox.try_decode_well_formed_optional(None) == None
}

// ---------------------------------------------------------------------------
// is_unit_*: positive + negative for fee-shard datum classification
// ---------------------------------------------------------------------------

test fee_unit_datum_positive() {
  let unit: Data = Void
  fee.is_unit_data(unit)
}

test fee_unit_datum_inline_positive() {
  let unit: Data = Void
  fee.is_unit_inline_datum(InlineDatum(unit))
}

test fee_unit_datum_no_datum_negative() {
  // NoDatum is not the unit constructor — a real fee shard always has inline ().
  !fee.is_unit_inline_datum(NoDatum)
}

test fee_unit_datum_int_negative() {
  let i: Data = 1
  !fee.is_unit_data(i)
}

test fee_unit_datum_bytes_negative() {
  let bs: Data = #""
  !fee.is_unit_data(bs)
}

test fee_unit_datum_nonzero_constr_negative() {
  // Constr 1 [] is not the unit constructor.
  let d: Data = MixDatum { a: a48, b: b48 }
  !fee.is_unit_data(d)
}
