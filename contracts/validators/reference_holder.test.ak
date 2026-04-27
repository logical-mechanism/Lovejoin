//// `reference_holder` validator tests.
////
//// Spec: docs/spec/03-contracts.md §0 Rule 2 (the explicit exception), §1.
////
//// Always-False is intentional: the reference UTxO is the hyperstructure anchor
//// and must never move. Any spend attempt is rejected. We don't bother varying
//// the inputs since the validator ignores them.

use cardano/transaction.{OutputReference}
use cardano/transaction
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
