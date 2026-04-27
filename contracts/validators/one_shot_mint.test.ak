//// `one_shot_mint` validator tests.
////
//// Spec: docs/spec/03-contracts.md §1, rules:
////  - The seed UTxO is consumed in the mint tx.
////  - The total mint quantity under this policy is exactly 1.
////
//// We exercise both rules with positive + negative cases.

use cardano/assets
use cardano/transaction.{Input, Output, OutputReference, Transaction, NoDatum}
use cardano/address
use one_shot_mint

const seed: OutputReference =
  OutputReference {
    transaction_id: #"00000000000000000000000000000000000000000000000000000000000000aa",
    output_index: 0,
  }

const other_ref: OutputReference =
  OutputReference {
    transaction_id: #"00000000000000000000000000000000000000000000000000000000000000bb",
    output_index: 0,
  }

const policy_id: assets.PolicyId =
  #"11111111111111111111111111111111111111111111111111111111"

const asset_name: assets.AssetName = ""

fn placeholder_input(out_ref: OutputReference) -> Input {
  Input {
    output_reference: out_ref,
    output: Output {
      address: address.from_verification_key(
        #"22222222222222222222222222222222222222222222222222222222",
      ),
      value: assets.from_lovelace(2_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

fn tx_with_inputs_and_mint(inputs: List<Input>, mint: assets.Value) -> Transaction {
  Transaction { ..transaction.placeholder, inputs: inputs, mint: mint }
}

// ---------------------------------------------------------------------------
// Positive: seed consumed + quantity == 1
// ---------------------------------------------------------------------------

test one_shot_mint_positive() {
  let tx =
    tx_with_inputs_and_mint(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name, 1),
    )
  one_shot_mint.one_shot_mint.mint(
    seed.transaction_id,
    seed.output_index,
    Void,
    policy_id,
    tx,
  )
}

test one_shot_mint_positive_seed_among_others() {
  // Seed in the middle of an input list still satisfies the rule.
  let tx =
    tx_with_inputs_and_mint(
      [placeholder_input(other_ref), placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name, 1),
    )
  one_shot_mint.one_shot_mint.mint(
    seed.transaction_id,
    seed.output_index,
    Void,
    policy_id,
    tx,
  )
}

// ---------------------------------------------------------------------------
// Negative: seed not consumed
// ---------------------------------------------------------------------------

test one_shot_mint_rejects_seed_missing() {
  let tx =
    tx_with_inputs_and_mint(
      [placeholder_input(other_ref)],
      assets.from_asset(policy_id, asset_name, 1),
    )
  !one_shot_mint.one_shot_mint.mint(
    seed.transaction_id,
    seed.output_index,
    Void,
    policy_id,
    tx,
  )
}

test one_shot_mint_rejects_no_inputs() {
  let tx =
    tx_with_inputs_and_mint([], assets.from_asset(policy_id, asset_name, 1))
  !one_shot_mint.one_shot_mint.mint(
    seed.transaction_id,
    seed.output_index,
    Void,
    policy_id,
    tx,
  )
}

// ---------------------------------------------------------------------------
// Negative: wrong mint quantity
// ---------------------------------------------------------------------------

test one_shot_mint_rejects_quantity_zero() {
  let tx = tx_with_inputs_and_mint([placeholder_input(seed)], assets.zero)
  !one_shot_mint.one_shot_mint.mint(
    seed.transaction_id,
    seed.output_index,
    Void,
    policy_id,
    tx,
  )
}

test one_shot_mint_rejects_quantity_two() {
  let tx =
    tx_with_inputs_and_mint(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name, 2),
    )
  !one_shot_mint.one_shot_mint.mint(
    seed.transaction_id,
    seed.output_index,
    Void,
    policy_id,
    tx,
  )
}

test one_shot_mint_rejects_burn() {
  // Burning the NFT (-1) must be rejected — the reference NFT has to live forever.
  let tx =
    tx_with_inputs_and_mint(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name, -1),
    )
  !one_shot_mint.one_shot_mint.mint(
    seed.transaction_id,
    seed.output_index,
    Void,
    policy_id,
    tx,
  )
}

test one_shot_mint_rejects_two_asset_names() {
  // (name1, 2) + (name2, -1) sums to 1 but is two distinct assets under the
  // policy. The strict size check rejects this even though the ledger's
  // balancing rules would also reject it in practice (no UTxO carries name2
  // to back the burn at genesis).
  let value =
    assets.merge(
      assets.from_asset(policy_id, asset_name, 2),
      assets.from_asset(policy_id, "alt", -1),
    )
  let tx = tx_with_inputs_and_mint([placeholder_input(seed)], value)
  !one_shot_mint.one_shot_mint.mint(
    seed.transaction_id,
    seed.output_index,
    Void,
    policy_id,
    tx,
  )
}
