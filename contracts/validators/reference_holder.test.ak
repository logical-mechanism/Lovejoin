//// `reference_holder` validator tests.
////
//// Spec: §0 Rule 2 (the explicit exception), §1.
////
//// Always-False is intentional: the reference UTxO is the hyperstructure
//// anchor and must never move. Any spend attempt is rejected.
////
//// Audit L-01 / L-02 (issue #130): the validator is parameter-free. Its
//// hash is therefore a fixed compile-time constant computable before
//// `one_shot_mint`, which then takes `reference_holder_hash` as a parameter
//// and asserts the bootstrap mint lands here with a sane `ReferenceDatum`.

use cardano/transaction.{OutputReference}
use reference_holder

const dummy_utxo: OutputReference =
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
    output_index: 0,
  }

test reference_holder_always_rejects_unit_redeemer() {
  !reference_holder.reference_holder.spend(
    None,
    Void,
    dummy_utxo,
    transaction.placeholder,
  )
}

test reference_holder_always_rejects_int_redeemer() {
  !reference_holder.reference_holder.spend(
    None,
    42,
    dummy_utxo,
    transaction.placeholder,
  )
}

test reference_holder_always_rejects_with_inline_datum() {
  let some_data: Data = 0
  !reference_holder.reference_holder.spend(
    Some(some_data),
    Void,
    dummy_utxo,
    transaction.placeholder,
  )
}
