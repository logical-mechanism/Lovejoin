//// `fee_contract` — sharded fee pool spend validator.
////
//// Spec: docs/spec/03-contracts.md §0 Rule 2, §3.
////
//// 10 shard UTxOs (the `fee_shard_target`) live at this validator. Two
//// redeemer paths preserve the shard count (1 input → 1 output):
////
////   * `PayMixFee` — consumed by a Mix tx; the value drop on this shard
////     equals the tx's fee, with `tx.fee ≤ max_fee_per_mix_lovelace`. The
////     `mix_script_hash` is present in the tx (≥ 2 inputs at it), making
////     this a real Mix tx.
////   * `Replenish` — strict-increase top-up; usable in a Deposit tx.
////
//// Rule 2 (hyperstructure): an input whose datum isn't `()` is treated as
//// accidentally parked and the spend is allowed (recovery path). Real fee
//// shards always carry `()`.
////
//// Drain-attack note: a user can pay `max_fee_per_mix_lovelace` while only
//// mixing N=2 inputs, taking up shard capacity disproportionate to the
//// privacy gain. Mitigation (capacity floor / scaling fee with N) is a
//// post-M2 follow-up; we'll calibrate it after the stress test produces
//// real numbers.

use aiken/collection/list
use aiken/crypto.{ScriptHash}
use cardano/address.{Script}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{Input, OutputReference, Transaction}
use lovejoin/fee.{
  input_at_fee, is_unit_inline_datum, is_unit_optional, output_at_fee,
}
use lovejoin/mixbox.{input_at_script}
use lovejoin/reference.{read_reference_datum}
use lovejoin/types.{FeeRedeemer, PayMixFee, ReferenceDatum, Replenish}
use lovejoin/value.{ada_only}

// Flat params — one CBOR atom per `aiken blueprint apply` call.
validator fee_contract(
  reference_nft_policy: PolicyId,
  reference_nft_name: AssetName,
) {
  spend(
    datum: Option<Data>,
    redeemer: FeeRedeemer,
    utxo: OutputReference,
    self: Transaction,
  ) {
    if !is_unit_optional(datum) {
      // Rule 2: not a real fee shard. Allow recovery.
      True
    } else {
      let reference_datum =
        read_reference_datum(self, reference_nft_policy, reference_nft_name)

      expect Some(own_input) =
        list.find(self.inputs, fn(input) { input.output_reference == utxo })
      expect Script(own_hash) = own_input.output.address.payment_credential
      expect own_hash == reference_datum.fee_script_hash

      when redeemer is {
        PayMixFee ->
          validate_pay_mix_fee(reference_datum, self, own_input, own_hash)
        Replenish -> validate_replenish(self, own_input, own_hash)
      }
    }
  }

  else(_) {
    fail
  }
}

/// PayMixFee:
///   1. ≥ 2 mix-script inputs (it's a real Mix tx).
///   2. Exactly one fee input (this) and one fee output, datum unchanged.
///   3. fee_in.lovelace − fee_out.lovelace == self.fee.
///   4. self.fee ≤ reference_datum.max_fee_per_mix_lovelace.
///   5. No native assets in fee input/output.
fn validate_pay_mix_fee(
  reference_datum: ReferenceDatum,
  self: Transaction,
  own_input: Input,
  own_hash: ScriptHash,
) -> Bool {
  let mix_input_count =
    self.inputs
      |> list.count(
          fn(input) { input_at_script(input, reference_datum.mix_script_hash) },
        )
  expect mix_input_count >= 2

  let fee_input_count =
    self.inputs |> list.count(fn(input) { input_at_fee(input, own_hash) })
  expect fee_input_count == 1

  let fee_outputs =
    self.outputs |> list.filter(fn(output) { output_at_fee(output, own_hash) })
  expect [fee_output] = fee_outputs

  let fee_in_lovelace = assets.lovelace_of(own_input.output.value)
  let fee_out_lovelace = assets.lovelace_of(fee_output.value)

  and {
    is_unit_inline_datum(fee_output.datum),
    ada_only(own_input.output.value),
    ada_only(fee_output.value),
    fee_in_lovelace - fee_out_lovelace == self.fee,
    self.fee <= reference_datum.max_fee_per_mix_lovelace,
  }
}

/// Replenish:
///   1. Exactly one fee input (this) and one fee output, datum unchanged.
///   2. fee_out.lovelace > fee_in.lovelace (strict).
///   3. No native assets in fee input/output.
fn validate_replenish(
  self: Transaction,
  own_input: Input,
  own_hash: ScriptHash,
) -> Bool {
  let fee_input_count =
    self.inputs |> list.count(fn(input) { input_at_fee(input, own_hash) })
  expect fee_input_count == 1

  let fee_outputs =
    self.outputs |> list.filter(fn(output) { output_at_fee(output, own_hash) })
  expect [fee_output] = fee_outputs

  and {
    is_unit_inline_datum(fee_output.datum),
    ada_only(own_input.output.value),
    ada_only(fee_output.value),
    assets.lovelace_of(fee_output.value) > assets.lovelace_of(
      own_input.output.value,
    ),
  }
}

