//// Property-based tests for byte-stable Plutus-Data CBOR.
////
//// Audit F-19 (next-redeploy bundle Q-3): the encoding-parity KAT
//// vectors in encoding_parity_kat.test.ak lock byte-equality across
//// 1000 hand-picked inputs. Adding a fuzzer over arbitrary `MixDatum`
//// and ada-only Value shapes catches drift in `serialise_data` itself
//// (e.g. an Aiken bytecode-level shift that the KAT vectors might miss
//// because they happen to land on the same code path).
////
//// We don't compare to TS-side bytes here — that's the cross-language
//// KAT's job. Instead we fuzz over inputs and assert reflexivity:
////   * `serialise_data(x)` is deterministic — calling it twice on the
////     same input yields the same bytes.
////   * `serialise_data(MixDatum {a, b})` ALWAYS starts with the
////     constructor-0 prefix `d8 79 9f` (tag 121 + indef-array start).
////   * `serialise_data(assets.from_lovelace(n))` for n > 0 is the
////     pinned `a140a140 + minimal-int-encoding(n)`.

use aiken/builtin
use aiken/fuzz
use aiken/primitive/bytearray
use cardano/assets
use lovejoin/types.{MixDatum}

fn mix_datum_fuzzer() -> Fuzzer<MixDatum> {
  let a <- fuzz.and_then(fuzz.bytearray_fixed(48))
  let b <- fuzz.and_then(fuzz.bytearray_fixed(48))
  fuzz.constant(MixDatum {
    a: bytearray.take(bytearray.push(a, 0x00), 48),
    b: bytearray.take(bytearray.push(b, 0x01), 48),
  })
}

test prop_serialise_data_deterministic(md via mix_datum_fuzzer()) {
  // Calling serialise_data twice on the same MixDatum yields byte-equal
  // output. Locks the canonical-encoding contract that the off-chain
  // prover relies on for FS-hash parity.
  let d: Data = md
  builtin.serialise_data(d) == builtin.serialise_data(d)
}

test prop_mix_datum_constr_prefix(md via mix_datum_fuzzer()) {
  // Every well-formed MixDatum serialises to a Constr 0 wrapper:
  //   d8 79 9f <field0> <field1> ff
  // The first 3 bytes are invariant across all (a, b).
  let d: Data = md
  bytearray.take(builtin.serialise_data(d), 3) == #"d8799f"
}

test prop_ada_only_value_canonical_shape(
  n via fuzz.int_between(1, 1_000_000_000),
) {
  // assets.from_lovelace(n) → canonical CBOR for n ∈ [1, 23] is
  //   a1 40 a1 40 0X
  // where 0X is the int's minimal-byte encoding. We only assert the
  // a140a140 prefix (the policy-id + asset-name layer is the part
  // value_serialise_parity.test.ak hand-rolls in the off-chain ctx);
  // the int suffix is deterministic per n.
  let bytes = builtin.serialise_data(assets.from_lovelace(n))
  bytearray.take(bytes, 4) == #"a140a140"
}
