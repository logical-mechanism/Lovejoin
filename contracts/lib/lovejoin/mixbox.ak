//// Mix-box helpers: input/output classification, datum well-formedness.
////
//// Spec: docs/spec/03-contracts.md §0 Rule 2 (hyperstructure datum tolerance), §2.
////
//// "Well-formed" `MixDatum` = decodes as `Constr 0 [a: bytes, b: bytes]` with
//// `length(a) == length(b) == 48` and `a != b`. We do NOT call
//// `bls12_381_g1_uncompress` here — that is expensive and the proof verifiers do it
//// anyway. Length + distinctness is enough to drive the spend's hyperstructure
//// branching and `mix_logic`'s input-filtering policy.

use aiken/builtin
use aiken/primitive/bytearray
use cardano/address.{Script}
use cardano/transaction.{Datum, InlineDatum, Input, Output}
use lovejoin/types.{MixDatum}

/// True iff the input's payment credential is a script with the given hash.
pub fn input_at_script(input: Input, mix_script_hash: ByteArray) -> Bool {
  output_at_script(input.output, mix_script_hash)
}

/// True iff the output's payment credential is a script with the given hash.
pub fn output_at_script(output: Output, mix_script_hash: ByteArray) -> Bool {
  when output.address.payment_credential is {
    Script(h) -> h == mix_script_hash
    _ -> False
  }
}

/// Try to decode a `Datum` into a well-formed `MixDatum`.
///   * `NoDatum` or `DatumHash(_)` → `None` (no inline datum to inspect).
///   * `InlineDatum(d)` where `d` is not `Constr 0 [bytes, bytes]` → `None`.
///   * Inline `Constr 0 [a, b]` with `length(a) != 48` or `length(b) != 48` or `a == b` → `None`.
///   * Otherwise `Some(MixDatum { a, b })`.
///
/// This is the foundation of Rule 2: spend-side validators delegate to mix_logic only
/// when the result is `Some`, and accept the spend (return True) otherwise — those
/// UTxOs were never part of the privacy pool.
pub fn try_decode_well_formed_inline(datum: Datum) -> Option<MixDatum> {
  when datum is {
    InlineDatum(d) -> try_decode_well_formed_data(d)
    _ -> None
  }
}

/// Same as `try_decode_well_formed_inline` but operates on the spend handler's
/// `Option<Data>` datum field, which is `None` for `NoDatum` script inputs.
pub fn try_decode_well_formed_optional(datum: Option<Data>) -> Option<MixDatum> {
  when datum is {
    Some(d) -> try_decode_well_formed_data(d)
    None -> None
  }
}

/// Manually traverse `Data` so that an unexpected shape returns `None` instead of
/// aborting the script. Aiken's typed-cast (`expect md: MixDatum = d`) hard-fails on
/// any mismatch, which would defeat the hyperstructure recovery path.
pub fn try_decode_well_formed_data(d: Data) -> Option<MixDatum> {
  // choose_data(d, on_constr, on_map, on_list, on_int, on_bytes) — strict, must pre-guard.
  if is_constr(d) {
    let pair = builtin.un_constr_data(d)
    let idx = pair.1st
    let fields = pair.2nd
    if idx == 0 {
      when fields is {
        [a_data, b_data] -> decode_two_byte_fields(a_data, b_data)
        _ -> None
      }
    } else {
      None
    }
  } else {
    None
  }
}

fn decode_two_byte_fields(a_data: Data, b_data: Data) -> Option<MixDatum> {
  if is_bytes(a_data) && is_bytes(b_data) {
    let a = builtin.un_b_data(a_data)
    let b = builtin.un_b_data(b_data)
    if bytearray.length(a) == 48 && bytearray.length(b) == 48 && a != b {
      Some(MixDatum { a, b })
    } else {
      None
    }
  } else {
    None
  }
}

fn is_constr(d: Data) -> Bool {
  builtin.choose_data(d, True, False, False, False, False)
}

fn is_bytes(d: Data) -> Bool {
  builtin.choose_data(d, False, False, False, False, True)
}
