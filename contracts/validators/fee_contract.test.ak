//// `fee_contract` tests — every rule in spec §3 covered with positive + negative.
////
//// Spec: docs/spec/03-contracts.md §0 Rule 2 (datum tolerance), §3.

use aiken/collection/list
use cardano/assets
use cardano/transaction.{InlineDatum, Input, Output, OutputReference, Transaction}
use fee_contract
use lovejoin/test_fixtures.{
  default_reference_input, denom_lovelace, fee_shard_input, fee_shard_output,
  fee_shard_output_no_datum, fee_script_hash, max_fee_per_mix_lovelace,
  mix_box_input, out_ref, random_user_vk, ref_nft_name, ref_nft_policy,
  script_address, vk_output_lovelace, a48, b48,
}
use lovejoin/types.{PayMixFee, Replenish}

const fee_input_byte: Int = 0xf0

const default_fee_in: Int = 5_000_000

// ---------------------------------------------------------------------------
// Hyperstructure recovery (Rule 2)
// ---------------------------------------------------------------------------

test fee_contract_accepts_no_datum_recovery() {
  let utxo = out_ref(fee_input_byte, 0)
  fee_contract.fee_contract.spend(
    ref_nft_policy,
    ref_nft_name,
    None,
    PayMixFee,
    utxo,
    transaction.placeholder,
  )
}

test fee_contract_accepts_int_datum_recovery() {
  let utxo = out_ref(fee_input_byte, 0)
  let bad: Data = 1
  fee_contract.fee_contract.spend(
    ref_nft_policy,
    ref_nft_name,
    Some(bad),
    PayMixFee,
    utxo,
    transaction.placeholder,
  )
}

// ---------------------------------------------------------------------------
// PayMixFee builder + tests
// ---------------------------------------------------------------------------

/// Build a synthetic Mix tx with `mix_input_count` mix-script inputs, one fee
/// shard input, one fee shard output, and a tx fee. Returns (tx, fee_input_utxo).
fn pay_mix_fee_tx(
  fee_in_lovelace: Int,
  fee_out_lovelace: Int,
  tx_fee: Int,
  mix_input_count: Int,
) -> (Transaction, OutputReference) {
  let fee_in = fee_shard_input(fee_input_byte, 0, fee_in_lovelace)
  let fee_out = fee_shard_output(fee_out_lovelace)
  let mix_inputs = build_mix_inputs(mix_input_count)
  let inputs = list.concat(mix_inputs, [fee_in])
  let user_change = vk_output_lovelace(random_user_vk, 1_000_000)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: inputs,
      outputs: [fee_out, user_change],
      fee: tx_fee,
    }
  (tx, fee_in.output_reference)
}

fn build_mix_inputs(n: Int) -> List<Input> {
  do_build_mix_inputs(n, 0, [])
}

fn do_build_mix_inputs(remaining: Int, idx: Int, acc: List<Input>) -> List<Input> {
  if remaining == 0 {
    list.reverse(acc)
  } else {
    let inp = mix_box_input(0xa0 + idx, 0, a48, b48, denom_lovelace)
    do_build_mix_inputs(remaining - 1, idx + 1, [inp, ..acc])
  }
}

test pay_mix_fee_positive_n2() {
  let (tx, utxo) = pay_mix_fee_tx(default_fee_in, default_fee_in - 200_000, 200_000, 2)
  let unit: Data = Void
  fee_contract.fee_contract.spend(
    ref_nft_policy,
    ref_nft_name,
    Some(unit),
    PayMixFee,
    utxo,
    tx,
  )
}

test pay_mix_fee_positive_n6() {
  let (tx, utxo) = pay_mix_fee_tx(default_fee_in, default_fee_in - 700_000, 700_000, 6)
  let unit: Data = Void
  fee_contract.fee_contract.spend(
    ref_nft_policy,
    ref_nft_name,
    Some(unit),
    PayMixFee,
    utxo,
    tx,
  )
}

test pay_mix_fee_positive_at_max_fee() {
  // tx.fee at exactly max_fee_per_mix_lovelace — boundary inclusive.
  let (tx, utxo) =
    pay_mix_fee_tx(
      default_fee_in,
      default_fee_in - max_fee_per_mix_lovelace,
      max_fee_per_mix_lovelace,
      2,
    )
  let unit: Data = Void
  fee_contract.fee_contract.spend(
    ref_nft_policy,
    ref_nft_name,
    Some(unit),
    PayMixFee,
    utxo,
    tx,
  )
}

// `expect`-driven failures abort the script. Aiken's `test ... fail` annotation
// passes when the body aborts, which is the right semantics for the validator
// rejecting a tx (whether by `expect` or by returning False is equivalent at
// the ledger level — both mean validation fails).

test pay_mix_fee_rejects_one_mix_input() fail {
  // Spec rule: ≥ 2 mix-script inputs (a real Mix tx, not a Deposit-shaped one).
  let (tx, utxo) = pay_mix_fee_tx(default_fee_in, default_fee_in - 200_000, 200_000, 1)
  let unit: Data = Void
  fee_contract.fee_contract.spend(
    ref_nft_policy,
    ref_nft_name,
    Some(unit),
    PayMixFee,
    utxo,
    tx,
  )
}

test pay_mix_fee_rejects_zero_mix_inputs() fail {
  let (tx, utxo) = pay_mix_fee_tx(default_fee_in, default_fee_in - 200_000, 200_000, 0)
  let unit: Data = Void
  fee_contract.fee_contract.spend(
    ref_nft_policy,
    ref_nft_name,
    Some(unit),
    PayMixFee,
    utxo,
    tx,
  )
}

test pay_mix_fee_rejects_fee_diff_too_small() fail {
  // fee_in - fee_out (100_000) < tx.fee (200_000): rule fails.
  let (tx, utxo) = pay_mix_fee_tx(default_fee_in, default_fee_in - 100_000, 200_000, 2)
  let unit: Data = Void
  fee_contract.fee_contract.spend(
    ref_nft_policy,
    ref_nft_name,
    Some(unit),
    PayMixFee,
    utxo,
    tx,
  )
}

test pay_mix_fee_rejects_fee_diff_too_large() fail {
  // fee_in - fee_out (300_000) > tx.fee (200_000): the shard would lose more
  // value than was actually paid; rule fails.
  let (tx, utxo) = pay_mix_fee_tx(default_fee_in, default_fee_in - 300_000, 200_000, 2)
  let unit: Data = Void
  fee_contract.fee_contract.spend(
    ref_nft_policy,
    ref_nft_name,
    Some(unit),
    PayMixFee,
    utxo,
    tx,
  )
}

test pay_mix_fee_rejects_fee_above_max() {
  // tx.fee just above max_fee_per_mix_lovelace.
  let over = max_fee_per_mix_lovelace + 1
  let (tx, utxo) = pay_mix_fee_tx(default_fee_in, default_fee_in - over, over, 2)
  let unit: Data = Void
  !fee_contract.fee_contract.spend(
    ref_nft_policy,
    ref_nft_name,
    Some(unit),
    PayMixFee,
    utxo,
    tx,
  )
}

test pay_mix_fee_rejects_no_fee_output() fail {
  let mix_inputs = build_mix_inputs(2)
  let fee_in = fee_shard_input(fee_input_byte, 0, default_fee_in)
  let user_change = vk_output_lovelace(random_user_vk, 1_000_000)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: list.concat(mix_inputs, [fee_in]),
      outputs: [user_change],
      fee: 200_000,
    }
  let unit: Data = Void
  fee_contract.fee_contract.spend(
    ref_nft_policy,
    ref_nft_name,
    Some(unit),
    PayMixFee,
    fee_in.output_reference,
    tx,
  )
}

test pay_mix_fee_rejects_two_fee_outputs() fail {
  let mix_inputs = build_mix_inputs(2)
  let fee_in = fee_shard_input(fee_input_byte, 0, default_fee_in)
  let fee_out = fee_shard_output(default_fee_in - 200_000)
  let extra_fee_out = fee_shard_output(1)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: list.concat(mix_inputs, [fee_in]),
      outputs: [fee_out, extra_fee_out],
      fee: 200_000,
    }
  let unit: Data = Void
  fee_contract.fee_contract.spend(
    ref_nft_policy,
    ref_nft_name,
    Some(unit),
    PayMixFee,
    fee_in.output_reference,
    tx,
  )
}

test pay_mix_fee_rejects_no_datum_on_output() fail {
  let mix_inputs = build_mix_inputs(2)
  let fee_in = fee_shard_input(fee_input_byte, 0, default_fee_in)
  let fee_out = fee_shard_output_no_datum(default_fee_in - 200_000)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: list.concat(mix_inputs, [fee_in]),
      outputs: [fee_out],
      fee: 200_000,
    }
  let unit: Data = Void
  fee_contract.fee_contract.spend(
    ref_nft_policy,
    ref_nft_name,
    Some(unit),
    PayMixFee,
    fee_in.output_reference,
    tx,
  )
}

test pay_mix_fee_rejects_native_asset_in_output() fail {
  let mix_inputs = build_mix_inputs(2)
  let fee_in = fee_shard_input(fee_input_byte, 0, default_fee_in)
  let unit: Data = Void
  let dirty_value =
    assets.merge(
      assets.from_lovelace(default_fee_in - 200_000),
      assets.from_asset(
        #"33333333333333333333333333333333333333333333333333333333",
        "junk",
        1,
      ),
    )
  let fee_out =
    Output {
      address: script_address(fee_script_hash),
      value: dirty_value,
      datum: InlineDatum(unit),
      reference_script: None,
    }
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: list.concat(mix_inputs, [fee_in]),
      outputs: [fee_out],
      fee: 200_000,
    }
  fee_contract.fee_contract.spend(
    ref_nft_policy,
    ref_nft_name,
    Some(unit),
    PayMixFee,
    fee_in.output_reference,
    tx,
  )
}

// ---------------------------------------------------------------------------
// Replenish builder + tests
// ---------------------------------------------------------------------------

fn replenish_tx(
  fee_in_lovelace: Int,
  fee_out_lovelace: Int,
) -> (Transaction, OutputReference) {
  let fee_in = fee_shard_input(fee_input_byte, 0, fee_in_lovelace)
  let fee_out = fee_shard_output(fee_out_lovelace)
  let user_change = vk_output_lovelace(random_user_vk, 1_000_000)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: [fee_in],
      outputs: [fee_out, user_change],
      fee: 0,
    }
  (tx, fee_in.output_reference)
}

test replenish_positive() {
  // Strict-increase top-up: out > in.
  let (tx, utxo) = replenish_tx(5_000_000, 8_000_000)
  let unit: Data = Void
  fee_contract.fee_contract.spend(
    ref_nft_policy,
    ref_nft_name,
    Some(unit),
    Replenish,
    utxo,
    tx,
  )
}

test replenish_rejects_decrease() {
  let (tx, utxo) = replenish_tx(5_000_000, 4_000_000)
  let unit: Data = Void
  !fee_contract.fee_contract.spend(
    ref_nft_policy,
    ref_nft_name,
    Some(unit),
    Replenish,
    utxo,
    tx,
  )
}

test replenish_rejects_unchanged() {
  // Strict: out > in — equality fails.
  let (tx, utxo) = replenish_tx(5_000_000, 5_000_000)
  let unit: Data = Void
  !fee_contract.fee_contract.spend(
    ref_nft_policy,
    ref_nft_name,
    Some(unit),
    Replenish,
    utxo,
    tx,
  )
}

test replenish_rejects_no_fee_output() fail {
  let fee_in = fee_shard_input(fee_input_byte, 0, 5_000_000)
  let user_change = vk_output_lovelace(random_user_vk, 1_000_000)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: [fee_in],
      outputs: [user_change],
      fee: 0,
    }
  let unit: Data = Void
  fee_contract.fee_contract.spend(
    ref_nft_policy,
    ref_nft_name,
    Some(unit),
    Replenish,
    fee_in.output_reference,
    tx,
  )
}
