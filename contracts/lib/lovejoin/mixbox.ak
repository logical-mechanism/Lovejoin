//// Mix-box helpers: input/output classification, datum well-formedness.
////
//// Spec: docs/spec/03-contracts.md §0 Rule 2 (hyperstructure datum
//// tolerance), §2.
////
//// "Well-formed" `MixDatum` = decodes as `Constr 0 [a: bytes, b: bytes]`
//// with `length(a) == length(b) == 48` and `a != b`. We do NOT call
//// `bls12_381_g1_uncompress` here — that is expensive and the proof
//// verifiers do it anyway. Length + distinctness is enough to drive the
//// spend's hyperstructure branching and `mix_logic`'s input-filtering policy.

use aiken/builtin
use aiken/crypto.{ScriptHash}
use aiken/primitive/bytearray
use cardano/address.{Script}
use cardano/transaction.{Datum, InlineDatum, Input, Output}
use lovejoin/types.{MixDatum}

pub const mix_datum_field_length: Int = 48

/// True iff the input's payment credential is a script with the given hash.
pub fn input_at_script(input: Input, mix_script_hash: ScriptHash) -> Bool {
  output_at_script(input.output, mix_script_hash)
}

/// True iff the output's payment credential is a script with the given hash.
pub fn output_at_script(output: Output, mix_script_hash: ScriptHash) -> Bool {
  when output.address.payment_credential is {
    Script(script_hash) -> script_hash == mix_script_hash
    _ -> False
  }
}

/// Try to decode a `Datum` into a well-formed `MixDatum`.
///   * `NoDatum` or `DatumHash(_)`  → `None` (no inline datum to inspect).
///   * Inline data not shaped as `Constr 0 [bytes, bytes]` → `None`.
///   * Inline `Constr 0 [a, b]` with wrong byte lengths or `a == b` → `None`.
///   * Otherwise `Some(MixDatum { a, b })`.
///
/// This is the foundation of Rule 2: spend-side validators delegate to
/// `mix_logic` only when the result is `Some`, and accept the spend
/// (return True) otherwise — those UTxOs were never part of the privacy pool.
pub fn try_decode_well_formed_inline(datum: Datum) -> Option<MixDatum> {
  when datum is {
    InlineDatum(inline_data) -> try_decode_well_formed_data(inline_data)
    _ -> None
  }
}

/// Same as `try_decode_well_formed_inline` but operates on the spend
/// handler's `Option<Data>` datum field, which is `None` for `NoDatum`
/// script inputs.
pub fn try_decode_well_formed_optional(datum: Option<Data>) -> Option<MixDatum> {
  when datum is {
    Some(inline_data) -> try_decode_well_formed_data(inline_data)
    None -> None
  }
}

/// Hard-fail output decode for `validate_mix`'s prefix walk. Outputs MUST
/// be well-formed mix-boxes (Mix tx invariant), so the soft-fail Option
/// dance is dead overhead — we abort if the shape is wrong. Same protocol
/// constraints as `try_decode_well_formed_data` (Constr 0, 48-byte fields,
/// `a != b`); skips the manual `is_constr` / `is_bytes` `choose_data`
/// dispatches by leaning on Aiken's typed cast.
pub fn decode_mix_datum_strict(inline_data: Data) -> MixDatum {
  expect mix_datum: MixDatum = inline_data
  expect bytearray.length(mix_datum.a) == mix_datum_field_length
  expect bytearray.length(mix_datum.b) == mix_datum_field_length
  expect mix_datum.a != mix_datum.b
  mix_datum
}

/// Manually traverse `Data` so that an unexpected shape returns `None`
/// instead of aborting the script. Aiken's typed cast (`expect md: MixDatum
/// = d`) hard-fails on any mismatch, which would defeat the hyperstructure
/// recovery path — we need a soft-fail.
pub fn try_decode_well_formed_data(inline_data: Data) -> Option<MixDatum> {
  if is_constr(inline_data) {
    let constr_pair = builtin.un_constr_data(inline_data)
    let constructor_index = constr_pair.1st
    let fields = constr_pair.2nd
    if constructor_index == 0 {
      when fields is {
        [a_field, b_field] -> decode_two_byte_fields(a_field, b_field)
        _ -> None
      }
    } else {
      None
    }
  } else {
    None
  }
}

fn decode_two_byte_fields(a_field: Data, b_field: Data) -> Option<MixDatum> {
  if and {
    is_bytes(a_field),
    is_bytes(b_field),
  } {
    let a = builtin.un_b_data(a_field)
    let b = builtin.un_b_data(b_field)
    if and {
      bytearray.length(a) == mix_datum_field_length,
      bytearray.length(b) == mix_datum_field_length,
      a != b,
    } {
      Some(MixDatum { a, b })
    } else {
      None
    }
  } else {
    None
  }
}

fn is_constr(value: Data) -> Bool {
  builtin.choose_data(value, True, False, False, False, False)
}

fn is_bytes(value: Data) -> Bool {
  builtin.choose_data(value, False, False, False, False, True)
}
