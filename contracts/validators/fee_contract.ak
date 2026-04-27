//// `fee_contract` — sharded fee pool spend validator.
////
//// Spec: docs/spec/03-contracts.md §0 Rule 2, §3.
////
//// 10 shard UTxOs (the `fee_shard_target`) live at this validator. Two redeemer
//// paths preserve the shard count (1 input → 1 output):
////
////   * `PayMixFee` — consumed by a Mix tx; the value drop on this shard equals the
////     tx's fee, with `tx.fee ≤ max_fee_per_mix_lovelace`. The mix_script_hash is
////     present in the tx (≥ 2 inputs at it), making this a real Mix tx.
////   * `Replenish` — strict-increase top-up; usable in a Deposit tx.
////
//// Rule 2 (hyperstructure): an input whose datum isn't `()` is treated as accidentally
//// parked and the spend is allowed (recovery path). Real fee shards always carry `()`.

use aiken/collection/list
use cardano/address.{Script}
use cardano/assets
use cardano/transaction.{Input, OutputReference, Transaction}
use lovejoin/fee.{input_at_fee, is_unit_inline_datum, is_unit_optional, output_at_fee}
use lovejoin/mixbox.{input_at_script}
use lovejoin/reference.{read_protocol_params}
use lovejoin/types.{
  FeeRedeemer, PayMixFee, ProtocolParams, ReferenceParams, Replenish,
}

// Flat params for `aiken blueprint apply` (one CBOR atom per call).
validator fee_contract(reference_nft_policy: ByteArray, reference_nft_name: ByteArray) {
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
      let ref = ReferenceParams { reference_nft_policy, reference_nft_name }
      let params = read_protocol_params(self, ref)

      // Locate this input among self.inputs to discover own_hash.
      // `find_input` returns the `Input` carrying our `OutputReference`.
      expect Some(own_input) =
        list.find(self.inputs, fn(i) { i.output_reference == utxo })
      expect Script(own_hash) = own_input.output.address.payment_credential
      expect own_hash == params.fee_script_hash

      when redeemer is {
        PayMixFee ->
          validate_pay_mix_fee(params, self, own_input, own_hash)
        Replenish -> validate_replenish(self, own_input, own_hash)
      }
    }
  }
}

/// PayMixFee:
///   1. ≥ 2 mix-script inputs (it's a real Mix tx).
///   2. Exactly one fee input (this) and one fee output, datum unchanged (`()`).
///   3. fee_in.lovelace − fee_out.lovelace == self.fee.
///   4. self.fee ≤ params.max_fee_per_mix_lovelace.
///   5. No native assets in fee input/output.
fn validate_pay_mix_fee(
  params: ProtocolParams,
  self: Transaction,
  own_input: Input,
  own_hash: ByteArray,
) -> Bool {
  let mix_input_count =
    self.inputs
      |> list.count(fn(i) { input_at_script(i, params.mix_script_hash) })
  expect mix_input_count >= 2

  let fee_inputs =
    self.inputs |> list.filter(fn(i) { input_at_fee(i, own_hash) })
  expect [_only_fee] = fee_inputs

  let fee_outputs =
    self.outputs |> list.filter(fn(o) { output_at_fee(o, own_hash) })
  expect [fee_out] = fee_outputs
  expect is_unit_inline_datum(fee_out.datum)

  expect ada_only(own_input.output.value)
  expect ada_only(fee_out.value)

  let fee_in_lovelace = assets.lovelace_of(own_input.output.value)
  let fee_out_lovelace = assets.lovelace_of(fee_out.value)
  expect fee_in_lovelace - fee_out_lovelace == self.fee
  self.fee <= params.max_fee_per_mix_lovelace
}

/// Replenish:
///   1. Exactly one fee input (this) and one fee output, datum unchanged.
///   2. fee_out.lovelace > fee_in.lovelace (strict).
///   3. No native assets in fee input/output.
fn validate_replenish(
  self: Transaction,
  own_input: Input,
  own_hash: ByteArray,
) -> Bool {
  let fee_inputs =
    self.inputs |> list.filter(fn(i) { input_at_fee(i, own_hash) })
  expect [_only_fee] = fee_inputs

  let fee_outputs =
    self.outputs |> list.filter(fn(o) { output_at_fee(o, own_hash) })
  expect [fee_out] = fee_outputs
  expect is_unit_inline_datum(fee_out.datum)

  expect ada_only(own_input.output.value)
  expect ada_only(fee_out.value)

  assets.lovelace_of(fee_out.value) > assets.lovelace_of(own_input.output.value)
}

/// `Value` carries only ADA iff `policies(v)` is `[ada_policy_id]` (when ADA is
/// non-zero) or `[]` (when zero). Mix/fee txs always have non-zero ADA, so the
/// stronger check is "the only policy is the ada policy".
fn ada_only(v: assets.Value) -> Bool {
  when assets.policies(v) is {
    [] -> True
    [policy] -> policy == assets.ada_policy_id
    _ -> False
  }
}
