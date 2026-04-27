//// Reference UTxO lookup helper.
////
//// Spec: docs/spec/03-contracts.md §1.
////
//// The protocol's hyperstructure anchor is a single permanent UTxO at the always-False
//// `reference_holder` validator. It carries a one-of-one NFT identified by
//// `(reference_nft_policy, reference_nft_name)` and an inline `ReferenceDatum`
//// holding `ProtocolParams`. Validators that need parameters look up this UTxO via
//// `tx.reference_inputs` (read-only; the UTxO is never consumed).
////
//// `read_protocol_params` aborts the script if the reference UTxO is not present in
//// `reference_inputs`, or if its inline datum doesn't decode as `ReferenceDatum`.
//// Both are catastrophic protocol errors and rejection is the safe default.

use aiken/collection/list
use cardano/assets
use cardano/transaction.{Input, Transaction, InlineDatum}
use lovejoin/types.{ProtocolParams, ReferenceDatum, ReferenceParams}

/// Return the `ProtocolParams` carried by the reference UTxO.
///
/// Failure modes (all `expect`-driven, all script-rejecting):
///   * No reference input carries the NFT.
///   * Multiple reference inputs carry it (would imply the NFT was duplicated, which
///     `one_shot_mint` prevents at mint time, so this is defense-in-depth).
///   * The carrier's datum isn't `InlineDatum` or doesn't decode as `ReferenceDatum`.
pub fn read_protocol_params(self: Transaction, ref: ReferenceParams) -> ProtocolParams {
  let carriers =
    self.reference_inputs
      |> list.filter(fn(input) { holds_reference_nft(input, ref) })

  expect [Input { output, .. }] = carriers
  expect InlineDatum(datum_data) = output.datum
  expect parsed: ReferenceDatum = datum_data
  parsed.protocol
}

fn holds_reference_nft(input: Input, ref: ReferenceParams) -> Bool {
  assets.quantity_of(
    input.output.value,
    ref.reference_nft_policy,
    ref.reference_nft_name,
  ) == 1
}
