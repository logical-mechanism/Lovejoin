//// Fee-shard helpers.
////
//// Spec: docs/spec/03-contracts.md §0 Rule 2 (hyperstructure datum tolerance), §3.
////
//// `fee_contract`'s legitimate datum is the unit constructor `()`. Any other shape on
//// a fee-script input is treated as an accidentally-parked UTxO and the spend returns
//// True (Rule 2). A real fee shard always carries `()` because the bootstrap creates
//// it that way and PayMixFee/Replenish both require the output datum to remain `()`.

use aiken/builtin
use cardano/address.{Script}
use cardano/transaction.{Datum, InlineDatum, Input, Output}

/// True iff the input is at the fee script.
pub fn input_at_fee(input: Input, fee_script_hash: ByteArray) -> Bool {
  output_at_fee(input.output, fee_script_hash)
}

/// True iff the output is at the fee script.
pub fn output_at_fee(output: Output, fee_script_hash: ByteArray) -> Bool {
  when output.address.payment_credential is {
    Script(h) -> h == fee_script_hash
    _ -> False
  }
}

/// True iff the inline datum is the unit constructor `Constr 0 []`.
/// `NoDatum` and `DatumHash(_)` return False — a fee shard MUST carry `()` inline so
/// PayMixFee/Replenish can verify "datum unchanged" cheaply.
pub fn is_unit_inline_datum(datum: Datum) -> Bool {
  when datum is {
    InlineDatum(d) -> is_unit_data(d)
    _ -> False
  }
}

/// True iff the optional spend-handler datum is `Some(Constr 0 [])`.
pub fn is_unit_optional(datum: Option<Data>) -> Bool {
  when datum is {
    Some(d) -> is_unit_data(d)
    None -> False
  }
}

pub fn is_unit_data(d: Data) -> Bool {
  if builtin.choose_data(d, True, False, False, False, False) {
    let pair = builtin.un_constr_data(d)
    pair.1st == 0 && pair.2nd == []
  } else {
    False
  }
}
