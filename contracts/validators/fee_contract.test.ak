//// `fee_contract` tests — every rule in spec §3 covered with positive + negative.
////
//// Spec: §0 Rule 2 (datum tolerance), §3.

use aiken/collection/list
use cardano/address.{Script}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, Withdraw,
}
use fee_contract
use lovejoin/schnorr.{SchnorrProof}
use lovejoin/sigma_or.{SigmaOrBranch, SigmaOrProof}
use lovejoin/test_fixtures.{
  a48, b48, default_reference_input, denom_lovelace, fee_script_hash,
  fee_shard_input, fee_shard_output, fee_shard_output_no_datum,
  fee_shard_output_with_address, fee_shard_output_with_ref_script,
  max_fee_per_mix_lovelace, mix_box_input, mix_logic_hash, out_ref,
  random_user_vk, ref_nft_name, ref_nft_policy, script_address,
  script_address_with_stake_vk, vk_output_lovelace,
}
use lovejoin/types.{Mix, Owner, PayMixFee, Replenish}

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

/// Bogus Mix sigma-OR redeemer (length-N list of zero-bytes branches). The
/// fee_contract validator only `expect`-casts the redeemer Data into
/// MixLogicRedeemer and pattern-matches `Mix { .. }`; it doesn't traverse the
/// proof contents. Zero-length / zero-bytes branches are fine for that gate.
fn bogus_mix_redeemer(n: Int) -> Data {
  let branches: List<SigmaOrBranch> = []
  let bogus_proof: SigmaOrProof = SigmaOrProof { branches }
  let proofs: List<SigmaOrProof> = replicate_proof(n, bogus_proof, [])
  let r: Data = Mix { proofs }
  r
}

fn replicate_proof(
  n: Int,
  proof: SigmaOrProof,
  acc: List<SigmaOrProof>,
) -> List<SigmaOrProof> {
  if n == 0 {
    acc
  } else {
    replicate_proof(n - 1, proof, [proof, ..acc])
  }
}

fn bogus_owner_redeemer(n: Int) -> Data {
  let zero32: ByteArray =
    #"0000000000000000000000000000000000000000000000000000000000000000"
  let zero48: ByteArray =
    #"000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
  let proof: SchnorrProof = SchnorrProof { t: zero48, z: zero32 }
  let proofs: List<SchnorrProof> = replicate_schnorr(n, proof, [])
  let r: Data = Owner { proofs }
  r
}

fn replicate_schnorr(
  n: Int,
  proof: SchnorrProof,
  acc: List<SchnorrProof>,
) -> List<SchnorrProof> {
  if n == 0 {
    acc
  } else {
    replicate_schnorr(n - 1, proof, [proof, ..acc])
  }
}

/// Build a synthetic Mix tx with `mix_input_count` mix-script inputs, one fee
/// shard input, one fee shard output, and a tx fee. Returns (tx, fee_input_utxo).
///
/// `mix_logic_redeemer_data` is what we attach at `Withdraw(Script(mix_logic))`
/// in `tx.redeemers`. PayMixFee asserts this decodes as `Mix { .. }`; pass a
/// `Mix`-shaped Data for happy-path tests, an `Owner`-shaped Data (or omit
/// the redeemer entirely) for the F-1 negative tests.
fn pay_mix_fee_tx_with_redeemer(
  fee_in_lovelace: Int,
  fee_out_lovelace: Int,
  tx_fee: Int,
  mix_input_count: Int,
  mix_logic_redeemer_data: Data,
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
      inputs,
      outputs: [fee_out, user_change],
      fee: tx_fee,
      redeemers: [
        Pair(Withdraw(Script(mix_logic_hash)), mix_logic_redeemer_data),
      ],
    }
  (tx, fee_in.output_reference)
}

/// Default happy-path builder — supplies a Mix redeemer of correct N at
/// `Withdraw(Script(mix_logic_hash))`.
fn pay_mix_fee_tx(
  fee_in_lovelace: Int,
  fee_out_lovelace: Int,
  tx_fee: Int,
  mix_input_count: Int,
) -> (Transaction, OutputReference) {
  pay_mix_fee_tx_with_redeemer(
    fee_in_lovelace,
    fee_out_lovelace,
    tx_fee,
    mix_input_count,
    bogus_mix_redeemer(mix_input_count),
  )
}

fn build_mix_inputs(n: Int) -> List<Input> {
  do_build_mix_inputs(n, 0, [])
}

fn do_build_mix_inputs(
  remaining: Int,
  idx: Int,
  acc: List<Input>,
) -> List<Input> {
  if remaining == 0 {
    list.reverse(acc)
  } else {
    let inp = mix_box_input(0xa0 + idx, 0, a48, b48, denom_lovelace)
    do_build_mix_inputs(remaining - 1, idx + 1, [inp, ..acc])
  }
}

test pay_mix_fee_positive_n3() {
  // N=3 is the minimum mix-script-input count for a fee-paying mix; the
  // smaller N=2 case is rejected (see `pay_mix_fee_rejects_two_mix_inputs`).
  let (tx, utxo) =
    pay_mix_fee_tx(default_fee_in, default_fee_in - 200_000, 200_000, 3)
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
  let (tx, utxo) =
    pay_mix_fee_tx(default_fee_in, default_fee_in - 700_000, 700_000, 6)
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
      3,
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
  // Spec rule: ≥ 3 mix-script inputs for a fee-paying mix.
  let (tx, utxo) =
    pay_mix_fee_tx(default_fee_in, default_fee_in - 200_000, 200_000, 1)
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

test pay_mix_fee_rejects_two_mix_inputs() fail {
  // N=2 is legal in `mix_logic.validate_mix` (wallet-collateral mixes), but
  // illegal here: consuming a fee shard at N=2 collapses the anonymity set
  // against an observer who knows the shard input.
  let (tx, utxo) =
    pay_mix_fee_tx(default_fee_in, default_fee_in - 200_000, 200_000, 2)
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
  let (tx, utxo) =
    pay_mix_fee_tx(default_fee_in, default_fee_in - 200_000, 200_000, 0)
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
  let (tx, utxo) =
    pay_mix_fee_tx(default_fee_in, default_fee_in - 100_000, 200_000, 3)
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
  let (tx, utxo) =
    pay_mix_fee_tx(default_fee_in, default_fee_in - 300_000, 200_000, 3)
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
  let (tx, utxo) =
    pay_mix_fee_tx(default_fee_in, default_fee_in - over, over, 3)
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
  let mix_inputs = build_mix_inputs(3)
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
  let mix_inputs = build_mix_inputs(3)
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
  let mix_inputs = build_mix_inputs(3)
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
  let mix_inputs = build_mix_inputs(3)
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

test pay_mix_fee_rejects_native_asset_in_input() fail {
  // Spec §3 PayMixFee rule 6: no native assets in the fee input either —
  // `expect_ada_only_lovelace(input.output.value)` aborts on the fee shard
  // input fold step.
  let mix_inputs = build_mix_inputs(3)
  let unit: Data = Void
  let dirty_value =
    assets.merge(
      assets.from_lovelace(default_fee_in),
      assets.from_asset(
        #"33333333333333333333333333333333333333333333333333333333",
        "junk",
        1,
      ),
    )
  let dirty_fee_in =
    Input {
      output_reference: out_ref(fee_input_byte, 0),
      output: Output {
        address: script_address(fee_script_hash),
        value: dirty_value,
        datum: InlineDatum(unit),
        reference_script: None,
      },
    }
  let fee_out = fee_shard_output(default_fee_in - 200_000)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: list.concat(mix_inputs, [dirty_fee_in]),
      outputs: [fee_out],
      fee: 200_000,
      redeemers: [Pair(Withdraw(Script(mix_logic_hash)), bogus_mix_redeemer(3))],
    }
  fee_contract.fee_contract.spend(
    ref_nft_policy,
    ref_nft_name,
    Some(unit),
    PayMixFee,
    dirty_fee_in.output_reference,
    tx,
  )
}

// ---------------------------------------------------------------------------
// F-1 regression — PayMixFee must reject Owner-branch txs even when the
// structural input-count gate is satisfied. Without this, an attacker who
// already owns ≥ 2 mix-boxes can rotate them via Owner withdraw + PayMixFee
// and drain `max_fee_per_mix_lovelace` per tx from the shard indefinitely.
// See docs/audit-2026-05-03.md F-1.
// ---------------------------------------------------------------------------

test pay_mix_fee_rejects_owner_redeemer_n2() fail {
  // Same shape as the happy-path N=2 PayMixFee tx, but the mix_logic
  // withdraw redeemer is Owner instead of Mix. The new gate must abort.
  let (tx, utxo) =
    pay_mix_fee_tx_with_redeemer(
      default_fee_in,
      default_fee_in - 200_000,
      200_000,
      2,
      bogus_owner_redeemer(2),
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

test pay_mix_fee_rejects_owner_redeemer_n6() fail {
  // Same drain but with a wider Owner withdraw (N=6) — wider rotation
  // would mean more attacker-side proof work but the same drain rate per
  // shard. Must still reject.
  let (tx, utxo) =
    pay_mix_fee_tx_with_redeemer(
      default_fee_in,
      default_fee_in - 700_000,
      700_000,
      6,
      bogus_owner_redeemer(6),
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

test pay_mix_fee_rejects_missing_mix_logic_redeemer() fail {
  // Pathological: structural inputs satisfy ≥ 2 mix-script + 1 fee, but
  // the tx omits the mix_logic withdraw redeemer entirely. The Cardano
  // ledger would have already rejected this tx (mix_box.spend forces a
  // mix_logic withdraw to exist), but defense-in-depth: PayMixFee must
  // also abort because `pairs.get_first(...)` returns None.
  let fee_in = fee_shard_input(fee_input_byte, 0, default_fee_in)
  let fee_out = fee_shard_output(default_fee_in - 200_000)
  let mix_inputs = build_mix_inputs(3)
  let inputs = list.concat(mix_inputs, [fee_in])
  let user_change = vk_output_lovelace(random_user_vk, 1_000_000)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs,
      outputs: [fee_out, user_change],
      fee: 200_000,
      redeemers: [],
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

// ---------------------------------------------------------------------------
// PayMixFee — perimeter rules on continuing fee output (audit H-01, M-01).
//
// `output_at_fee` requires `stake_credential == None` AND
// `reference_script == None`. A bad-perimeter fee output is filtered out by
// `list.filter(output_at_fee, ...)`, leaving the result list empty, which
// makes `expect [fee_output] = fee_outputs` abort.
// ---------------------------------------------------------------------------

test pay_mix_fee_rejects_fee_output_with_attacker_stake_vk() fail {
  // H-01 on the fee shard. An attacker re-routes fee-shard staking rewards
  // to their own stake key by attaching a stake credential to the
  // continuing fee output. Stake credential pinned to None must reject.
  let attacker_stake: ByteArray =
    #"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
  let bad_addr = script_address_with_stake_vk(fee_script_hash, attacker_stake)
  let fee_in = fee_shard_input(fee_input_byte, 0, default_fee_in)
  let fee_out =
    fee_shard_output_with_address(bad_addr, default_fee_in - 200_000)
  let mix_inputs = build_mix_inputs(3)
  let user_change = vk_output_lovelace(random_user_vk, 1_000_000)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: list.concat(mix_inputs, [fee_in]),
      outputs: [fee_out, user_change],
      fee: 200_000,
      redeemers: [Pair(Withdraw(Script(mix_logic_hash)), bogus_mix_redeemer(3))],
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

test pay_mix_fee_rejects_fee_output_with_reference_script_attached() fail {
  // M-01 on the fee shard. Same rule: any non-None reference_script is
  // perimeter-rejected by `output_at_fee`.
  let attacker_ref: ByteArray =
    #"abadbabeabadbabeabadbabeabadbabeabadbabeabadbabeabadbabe"
  let fee_in = fee_shard_input(fee_input_byte, 0, default_fee_in)
  let fee_out =
    fee_shard_output_with_ref_script(default_fee_in - 200_000, attacker_ref)
  let mix_inputs = build_mix_inputs(3)
  let user_change = vk_output_lovelace(random_user_vk, 1_000_000)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: list.concat(mix_inputs, [fee_in]),
      outputs: [fee_out, user_change],
      fee: 200_000,
      redeemers: [Pair(Withdraw(Script(mix_logic_hash)), bogus_mix_redeemer(3))],
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

test replenish_rejects_two_fee_outputs() fail {
  // Spec §3 Replenish rule 1: exactly one fee output. Two fee outputs would
  // increase shard count (drift away from `fee_shard_target` = 10) and break
  // SDK random-shard selection. Pattern-match on `[fee_output]` aborts.
  let fee_in = fee_shard_input(fee_input_byte, 0, 5_000_000)
  let fee_out_a = fee_shard_output(7_000_000)
  let fee_out_b = fee_shard_output(1_000_000)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: [fee_in],
      outputs: [fee_out_a, fee_out_b],
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

test replenish_rejects_non_unit_datum_on_output() {
  // Spec §3 Replenish rule 1: datum unchanged. The fee shard's datum must
  // remain `()` after replenish; an integer-shaped datum on the output makes
  // `is_unit_inline_datum` return False, which makes `validate_replenish`
  // return False (no abort).
  let fee_in = fee_shard_input(fee_input_byte, 0, 5_000_000)
  let bad_datum: Data = 42
  let fee_out =
    Output {
      address: script_address(fee_script_hash),
      value: assets.from_lovelace(8_000_000),
      datum: InlineDatum(bad_datum),
      reference_script: None,
    }
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: [fee_in],
      outputs: [fee_out],
      fee: 0,
    }
  let unit: Data = Void
  !fee_contract.fee_contract.spend(
    ref_nft_policy,
    ref_nft_name,
    Some(unit),
    Replenish,
    fee_in.output_reference,
    tx,
  )
}

test replenish_rejects_native_asset_in_output() fail {
  // Spec §3 Replenish rule 3: no native assets in fee input/output.
  // `expect_ada_only_lovelace(fee_output.value)` aborts on the dirty output.
  let fee_in = fee_shard_input(fee_input_byte, 0, 5_000_000)
  let unit: Data = Void
  let dirty_value =
    assets.merge(
      assets.from_lovelace(8_000_000),
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
      inputs: [fee_in],
      outputs: [fee_out],
      fee: 0,
    }
  fee_contract.fee_contract.spend(
    ref_nft_policy,
    ref_nft_name,
    Some(unit),
    Replenish,
    fee_in.output_reference,
    tx,
  )
}

// ---------------------------------------------------------------------------
// Replenish — perimeter rules on continuing fee output (audit H-01, M-01).
// Same logic as the PayMixFee perimeter tests above, but reached via the
// Replenish branch (the strict-increase top-up path).
// ---------------------------------------------------------------------------

test replenish_rejects_fee_output_with_attacker_stake_vk() fail {
  let attacker_stake: ByteArray =
    #"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
  let bad_addr = script_address_with_stake_vk(fee_script_hash, attacker_stake)
  let fee_in = fee_shard_input(fee_input_byte, 0, 5_000_000)
  let fee_out = fee_shard_output_with_address(bad_addr, 8_000_000)
  let user_change = vk_output_lovelace(random_user_vk, 1_000_000)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: [fee_in],
      outputs: [fee_out, user_change],
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

test replenish_rejects_fee_output_with_reference_script_attached() fail {
  let attacker_ref: ByteArray =
    #"abadbabeabadbabeabadbabeabadbabeabadbabeabadbabeabadbabe"
  let fee_in = fee_shard_input(fee_input_byte, 0, 5_000_000)
  let fee_out = fee_shard_output_with_ref_script(8_000_000, attacker_ref)
  let user_change = vk_output_lovelace(random_user_vk, 1_000_000)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: [fee_in],
      outputs: [fee_out, user_change],
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

test replenish_rejects_native_asset_in_input() fail {
  // Spec §3 Replenish rule 3 applied to the input side. A fee shard that
  // accidentally accumulated a native asset can't be replenished — the only
  // way to clean it up is via the Rule-2 recovery path (datum != unit), which
  // doesn't apply to a properly-`()`-tagged shard. Same `expect_ada_only`
  // abort as the output case, on the input fold.
  let unit: Data = Void
  let dirty_value =
    assets.merge(
      assets.from_lovelace(5_000_000),
      assets.from_asset(
        #"33333333333333333333333333333333333333333333333333333333",
        "junk",
        1,
      ),
    )
  let dirty_fee_in =
    Input {
      output_reference: out_ref(fee_input_byte, 0),
      output: Output {
        address: script_address(fee_script_hash),
        value: dirty_value,
        datum: InlineDatum(unit),
        reference_script: None,
      },
    }
  let fee_out = fee_shard_output(8_000_000)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: [dirty_fee_in],
      outputs: [fee_out],
      fee: 0,
    }
  fee_contract.fee_contract.spend(
    ref_nft_policy,
    ref_nft_name,
    Some(unit),
    Replenish,
    dirty_fee_in.output_reference,
    tx,
  )
}
