//// Reference UTxO lookup helper.
////
//// Spec: docs/spec/03-contracts.md §1.
////
//// The protocol's hyperstructure anchor is a single permanent UTxO at the
//// always-False `reference_holder` validator. It carries a one-of-one NFT
//// identified by `(policy, name)` and an inline `ReferenceDatum`. Validators
//// that need parameters look up this UTxO via `tx.reference_inputs`
//// (read-only; the UTxO is never consumed).
////
//// `read_reference_datum` aborts the script if the reference UTxO is not
//// present, multiple inputs claim to carry the NFT, or the inline datum
//// doesn't decode as `ReferenceDatum`. All three are catastrophic protocol
//// errors, and rejection is the safe default.

use aiken/collection/list
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{Input, InlineDatum, Transaction}
use lovejoin/types.{ReferenceDatum}

pub fn read_reference_datum(
  self: Transaction,
  policy: PolicyId,
  name: AssetName,
) -> ReferenceDatum {
  let carriers =
    self.reference_inputs
      |> list.filter(fn(input) { holds_reference_nft(input, policy, name) })

  expect [Input { output, .. }] = carriers
  expect InlineDatum(datum_data) = output.datum
  expect parsed: ReferenceDatum = datum_data
  parsed
}

fn holds_reference_nft(input: Input, policy: PolicyId, name: AssetName) -> Bool {
  assets.quantity_of(input.output.value, policy, name) == 1
}
