//// `fee_contract` — sharded fee pool spend validator.
////
//// Spec: docs/spec/03-contracts.md §0 Rule 2, §3.
////
//// 10 shard UTxOs (the `fee_shard_target`) live at this validator. Two
//// redeemer paths preserve the shard count (1 input → 1 output):
////
////   * `PayMixFee` — consumed by a Mix tx; the value drop on this shard
////     equals the tx's fee, with `tx.fee ≤ max_fee_per_mix_lovelace`. The
////     mix_logic withdraw redeemer in the same tx must be `Mix { .. }`
////     (not `Owner`), and there must be ≥ 2 mix-script inputs — together
////     these gate "this is actually a Mix tx" (see audit finding F-1).
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
use aiken/collection/pairs
use aiken/crypto.{ScriptHash}
use cardano/address.{Script}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{Input, OutputReference, Transaction, Withdraw}
use lovejoin/fee.{
  input_at_fee, is_unit_inline_datum, is_unit_optional, output_at_fee,
}
use lovejoin/mixbox.{input_at_script}
use lovejoin/reference.{read_reference_datum}
use lovejoin/types.{
  FeeRedeemer, Mix, MixLogicRedeemer, PayMixFee, ReferenceDatum, Replenish,
}
use lovejoin/value.{expect_ada_only_lovelace}

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
///   1. The `mix_logic` withdraw redeemer in this tx is `Mix { .. }` (not
///      `Owner { .. }`). This is the binding gate that makes "this is a real
///      Mix tx" enforceable on chain — see audit finding F-1. Owner-branch
///      txs that happen to bundle ≥ 2 mix-script inputs would otherwise
///      satisfy the structural check below and let an attacker rotate their
///      own boxes to drain the shard.
///   2. ≥ 2 mix-script inputs.
///   3. Exactly one fee input (this) and one fee output, datum unchanged.
///   4. fee_in.lovelace − fee_out.lovelace == self.fee.
///   5. self.fee ≤ reference_datum.max_fee_per_mix_lovelace.
///   6. No native assets in fee input/output.
fn validate_pay_mix_fee(
  reference_datum: ReferenceDatum,
  self: Transaction,
  own_input: Input,
  own_hash: ScriptHash,
) -> Bool {
  // Rule 1 — the mix_logic withdraw must use the Mix redeemer. We look up
  // the redeemer by `Withdraw(Script(mix_logic_script_hash))` in
  // `self.redeemers` (a sorted Pairs by ScriptPurpose) and `expect`-cast it
  // to MixLogicRedeemer. If the cast hard-fails (Owner-shape data) the
  // whole script aborts, which is the right "fee_contract rejects this tx"
  // semantics.
  expect Some(mix_logic_redeemer_data) =
    pairs.get_first(
      self.redeemers,
      Withdraw(Script(reference_datum.mix_logic_script_hash)),
    )
  expect mix_logic_redeemer: MixLogicRedeemer = mix_logic_redeemer_data
  expect Mix { .. } = mix_logic_redeemer

  // Single-pass fold replaces two separate `list.count` walks: count
  // mix-script inputs (need >=2) and fee-script inputs (need ==1) in one
  // pass over `self.inputs`. Saves N input-list walks per Mix tx.
  let (mix_input_count, fee_input_count) =
    list.foldl(
      self.inputs,
      (0, 0),
      fn(input, acc) {
        let (m, f) = acc
        if input_at_script(input, reference_datum.mix_script_hash) {
          (m + 1, f)
        } else if input_at_fee(input, own_hash) {
          (m, f + 1)
        } else {
          acc
        }
      },
    )
  expect mix_input_count >= 2
  expect fee_input_count == 1

  let fee_outputs =
    self.outputs |> list.filter(fn(output) { output_at_fee(output, own_hash) })
  expect [fee_output] = fee_outputs

  // expect_ada_only_lovelace fuses the ada-only check + lovelace extract
  // into a single dict walk (vs the old `ada_only` + `lovelace_of` pair).
  let fee_in_lovelace = expect_ada_only_lovelace(own_input.output.value)
  let fee_out_lovelace = expect_ada_only_lovelace(fee_output.value)

  and {
    is_unit_inline_datum(fee_output.datum),
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

  let fee_in_lovelace = expect_ada_only_lovelace(own_input.output.value)
  let fee_out_lovelace = expect_ada_only_lovelace(fee_output.value)

  and {
    is_unit_inline_datum(fee_output.datum),
    fee_out_lovelace > fee_in_lovelace,
  }
}
