//// `one_shot_mint` validator tests.
////
//// Spec: §1, rules:
////  - The seed UTxO is consumed in the mint tx.
////  - Exactly one (asset_name, quantity) pair under this policy.
////  - asset_name == "lovejoin" (hex 6c6f76656a6f696e).
////  - quantity == 1.
////
//// We exercise every rule with positive + negative cases.

use cardano/address
use cardano/assets
use cardano/transaction.{Input, NoDatum, Output, OutputReference, Transaction}
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

// Canonical asset name baked into the validator: ASCII "lovejoin".
const asset_name: assets.AssetName = #"6c6f76656a6f696e"

// "lovejon" — one missing 'i'. The realistic typo from F-17.
const asset_name_typo: assets.AssetName = #"6c6f76656a6f6e"

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

fn tx_with_inputs_and_mint(
  inputs: List<Input>,
  mint: assets.Value,
) -> Transaction {
  Transaction { ..transaction.placeholder, inputs, mint }
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

test one_shot_mint_rejects_quantity_zero() fail {
  // No tokens minted under the policy at all → `dict.to_pairs` returns []
  // and the `expect [Pair(_, _)]` pattern aborts. Marked `fail` because
  // the validator path takes the abort route rather than returning False.
  let tx = tx_with_inputs_and_mint([placeholder_input(seed)], assets.zero)
  one_shot_mint.one_shot_mint.mint(
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

test one_shot_mint_rejects_two_asset_names() fail {
  // (name1, 2) + (name2, -1) sums to 1 but is two distinct assets under
  // the policy. The strict pattern-match `[Pair(_, _)]` rejects this
  // (size != 1) by aborting on the pattern. Even though the ledger's
  // balancing rules would also reject it in practice (no UTxO carries
  // name2 to back the burn at genesis), the validator-level rejection
  // is what we want to pin.
  let value =
    assets.merge(
      assets.from_asset(policy_id, asset_name, 2),
      assets.from_asset(policy_id, "alt", -1),
    )
  let tx = tx_with_inputs_and_mint([placeholder_input(seed)], value)
  one_shot_mint.one_shot_mint.mint(
    seed.transaction_id,
    seed.output_index,
    Void,
    policy_id,
    tx,
  )
}

// ---------------------------------------------------------------------------
// Negative: wrong asset name (audit F-17, next-redeploy bundle Q-2).
// The pre-fix policy would have minted under any asset name; post-fix the
// validator pins the name to "lovejoin" and rejects every other value.
// ---------------------------------------------------------------------------

test one_shot_mint_rejects_wrong_asset_name() {
  // "lovejon" — a realistic typo. quantity is right (1), seed is consumed.
  // Pre-F-17 fix this would have minted under the wrong name and the
  // bootstrap would have silently sailed past the mistake.
  let tx =
    tx_with_inputs_and_mint(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name_typo, 1),
    )
  !one_shot_mint.one_shot_mint.mint(
    seed.transaction_id,
    seed.output_index,
    Void,
    policy_id,
    tx,
  )
}

test one_shot_mint_rejects_empty_asset_name() {
  // Empty asset name was the previous test fixture and is also a common
  // mis-bootstrap shape (forgetting to set REF_NFT_ASSET_NAME at all).
  let tx =
    tx_with_inputs_and_mint(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, "", 1),
    )
  !one_shot_mint.one_shot_mint.mint(
    seed.transaction_id,
    seed.output_index,
    Void,
    policy_id,
    tx,
  )
}
