//// Encoding-parity test: assert what `builtin.serialise_data(output.value)`
//// emits for ada-only Values. The TS Mix tx builder hand-rolls these
//// bytes (`encodeAdaOnlyValueCbor` in offchain/src/tx/mix.ts) when
//// computing the Mix Fiat-Shamir context. If Aiken's canonical
//// encoding differs by even one byte, the off-chain ctx mismatches
//// the on-chain ctx, the sigma-OR proofs fail to verify, and the
//// `mix_logic` validator aborts in the OR-equation check.
////
//// We've seen exactly that symptom on Preprod (ogmios v6 reports
//// `withdraw[0]: machine terminated by error, traces=[]`), so this
//// test pins down the expected bytes for several denominations and
//// surfaces any drift between Aiken's emitter and the TS hand-roll.
////
//// The expected hex strings are intentionally NOT computed —
//// they're hard-coded to whatever Aiken's `serialise_data` actually
//// produces. When the test runs we either (a) match the hand-roll
//// (rare, since the hand-roll is currently definite-length and Plutus
//// canonical is indefinite-length), or (b) get a clear failure that
//// shows Aiken's bytes, and we patch the TS to match.
////
//// Spec: §Risk 1.

use aiken/builtin
use aiken/primitive/bytearray
use cardano/assets
use lovejoin/test_fixtures.{
  box_lovelace, default_reference_datum, token_box_value, token_reference_datum,
}
use lovejoin/types.{MixDatum, ReferenceDatum}
use lovejoin/value

// `assets.from_lovelace(n)` is the Aiken stdlib's idiomatic way to build
// an ada-only Value, and `value.box_value` builds an ADA pool's box value
// exactly that way. `mix_logic` hashes `serialise_data(box_value)` once per
// Mix output, so this is the exact codepath the validator exercises. The
// token-pool shapes are pinned by the `parity_box_value_*` vectors in
// encoding_parity_kat.test.ak.

// Run the test, observe what Aiken emits, then update both sides:
//   * if Aiken emits indefinite-length maps (`bf … ff`), the TS
//     `encodeAdaOnlyValueCbor` needs that shape.
//   * if Aiken emits definite-length maps (`a1 …`), the current TS
//     hand-roll is right and the bug is elsewhere.

// `assets.from_lovelace(n)` builds an ada-only Value. The on-chain
// `mix_logic.compute_mix_ctx` calls `serialise_data(output.value)` for
// each Mix output. Maps in canonical Plutus Data are DEFINITE-length
// (a1 for 1 entry); arrays in Constr fields are INDEFINITE (9f…ff —
// see the MixDatum tests below).

test serialise_data_value_10M_uses_definite_map() {
  let value = assets.from_lovelace(10_000_000)
  let bytes = builtin.serialise_data(value)
  // A1 40 A1 40 1A 00 98 96 80
  bytes == #"a140a1401a00989680"
}

test serialise_data_value_5_uses_definite_map() {
  let value = assets.from_lovelace(5)
  let bytes = builtin.serialise_data(value)
  bytes == #"a140a14005"
}

// `value.box_value` must produce the same Value as building it by hand, or
// a ledger output holding the box value would not compare equal to it.

test box_value_of_ada_pool_is_from_lovelace() {
  value.box_value(default_reference_datum()) == assets.from_lovelace(
    box_lovelace,
  )
}

test box_value_of_token_pool_adds_the_token() {
  value.box_value(token_reference_datum()) == token_box_value()
}

test box_value_of_token_pool_is_not_ada_only() {
  value.box_value(token_reference_datum()) != assets.from_lovelace(
    token_reference_datum().box_lovelace,
  )
}

test box_value_ignores_token_fields_for_ada_pool() {
  // An ADA pool's empty policy short-circuits; the bytes are the plain
  // lovelace map even if a malformed datum left a stray quantity (which
  // `one_shot_mint` rejects at launch anyway).
  builtin.serialise_data(
    value.box_value(
      ReferenceDatum { ..default_reference_datum(), token_quantity: 5 },
    ),
  ) == #"a140a1401a00989680"
}

// ---------------------------------------------------------------------------
// MixDatum re-serialization parity
//
// `mix_logic.compute_mix_ctx` also concatenates
// `serialise_data(inline_data)` for each Mix output's inline datum.
// `inline_data` is the Plutus `Data` parsed from the bytes we
// originally submitted via mesh. The validator re-serializes it
// canonically before hashing.
//
// If cbor-x's encoding of `MixDatum { a, b }` (used by
// `encodeMixDatum` in offchain/src/tx/deposit.ts) is NOT byte-equal
// to Aiken's canonical re-serialization, the off-chain ctx differs
// from on-chain → sigma-OR proofs fail to verify → the validator's
// OR-equation `expect c_global == xor_of_branch_c` aborts.
// "machine terminated by error, traces=[]" matches that signature.
// ---------------------------------------------------------------------------

const datum_a48: ByteArray =
  #"a39da0c995d54f162a32a1f401c9b184edb1384d28e5ff6fbcecbf406305df670bd64e35be028f131c4231a949bc5588"

const datum_b48: ByteArray =
  #"a2a66b3f90e9c74cf89befa1c91463f865b6583eb86b65e707b71106f5a4683bacc16c4d9bff1506aa22c1a4f333d839"

// Aiken's canonical form for a Constr's field list is INDEFINITE-length:
//   tag 121 + indef-array (`9f`) + bytes(48, a) + bytes(48, b) + break (`ff`).
//
// cbor-x emits definite-length (`82` …) which is also a valid Plutus
// Data encoding — the chain stores either form fine — but
// `serialise_data` re-emits the parsed datum canonically. The
// off-chain Mix ctx therefore must use this indefinite-length form
// (see `serialiseMixDatumCanonical` in offchain/src/tx/mix.ts) or the
// sigma-OR proofs won't verify on chain.
test serialise_data_mix_datum_uses_indefinite_array() {
  let d: Data = MixDatum { a: datum_a48, b: datum_b48 }
  let bytes = builtin.serialise_data(d)
  let expected = #"d8799f"
    |> bytearray.concat(#"5830")
    |> bytearray.concat(datum_a48)
    |> bytearray.concat(#"5830")
    |> bytearray.concat(datum_b48)
    |> bytearray.concat(#"ff")
  bytes == expected
}
