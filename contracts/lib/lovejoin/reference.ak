//// Reference UTxO lookup + bootstrap-target perimeter helper.
////
//// Spec: §1.
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
////
//// `output_at_reference_holder` is the sister of `mixbox.output_at_script`
//// and `fee.output_at_fee`: it pins the H-01 / M-01 perimeter rules
//// (no stake credential, no attached reference script) on the *bootstrap*
//// reference-UTxO output produced by `one_shot_mint`, and additionally
//// requires the protocol NFT to land on that same output.

use aiken/collection/list
use aiken/crypto.{ScriptHash}
use cardano/address.{Script}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
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

/// True iff the output is a well-formed bootstrap target for the protocol
/// reference UTxO: payment credential is the `reference_holder` script,
/// `stake_credential == None`, `reference_script == None`, and the output
/// carries quantity 1 of `(policy, name)` (the protocol NFT).
///
/// Audit L-01 (next-redeploy bundle): the previous inline `list.find`
/// predicate in `one_shot_mint` checked only `payment_credential` and NFT
/// quantity, leaving the deployer free to attach an arbitrary
/// `stake_credential` or `reference_script` to the reference UTxO. Because
/// `reference_holder` is always-False, that gap was permanent — staking
/// rewards on the locked principal would accrue to the deployer-chosen
/// stake key forever, and an attacker-supplied reference script would ride
/// free on the UTxO's min-ADA inflation. This helper lifts the same H-01 /
/// M-01 rule pinned on `output_at_script` / `output_at_fee` onto the
/// bootstrap codepath.
///
/// We do NOT inspect the inline datum here — datum decoding is the caller's
/// responsibility (see audit L-02 in `one_shot_mint`). Keeping this helper
/// purely structural mirrors its two siblings so the three perimeter checks
/// stay shape-aligned.
pub fn output_at_reference_holder(
  output: Output,
  reference_holder_hash: ScriptHash,
  policy: PolicyId,
  name: AssetName,
) -> Bool {
  when output.address.payment_credential is {
    Script(script_hash) -> and {
        script_hash == reference_holder_hash,
        output.address.stake_credential == None,
        output.reference_script == None,
        assets.quantity_of(output.value, policy, name) == 1,
      }
    _ -> False
  }
}
