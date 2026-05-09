//// `one_shot_mint` validator tests.
////
//// Spec: §1, rules:
////  - The seed UTxO is consumed in the mint tx.
////  - Exactly one (asset_name, quantity) pair under this policy.
////  - asset_name == "lovejoin" (hex 6c6f76656a6f696e).
////  - quantity == 1.
////  - The minted NFT is at the `reference_holder` script (audit L-01).
////  - The destination's inline datum decodes as `ReferenceDatum` with sane
////    field values (audit L-02).
////
//// We exercise every rule with positive + negative cases.

use cardano/address
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use lovejoin/test_fixtures.{
  default_reference_datum, reference_holder_hash, script_address,
  script_address_with_stake_pointer, script_address_with_stake_script,
  script_address_with_stake_vk,
}
use lovejoin/types.{ReferenceDatum}
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

// An arbitrary script hash that is NOT the reference_holder. Used to build
// the L-01 negative where the deployer mints the NFT but parks it at the
// wrong address (e.g. their own wallet, or some other script).
const wrong_script_hash: ByteArray =
  #"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

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

/// A canonical reference-holder output: 2 ADA + the protocol NFT, parked at
/// the `reference_holder` script with an inline `ReferenceDatum`.
fn canonical_reference_output() -> Output {
  let datum: Data = default_reference_datum()
  Output {
    address: script_address(reference_holder_hash),
    value: assets.add(assets.from_lovelace(2_000_000), policy_id, asset_name, 1),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

/// Helper: build a reference-holder output where the inline datum is
/// supplied as raw `Data`. Used to test wrong-constructor / out-of-range
/// datum negatives.
fn reference_output_with_datum(datum: Data) -> Output {
  Output {
    address: script_address(reference_holder_hash),
    value: assets.add(assets.from_lovelace(2_000_000), policy_id, asset_name, 1),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn tx_with(
  inputs: List<Input>,
  mint: assets.Value,
  outputs: List<Output>,
) -> Transaction {
  Transaction { ..transaction.placeholder, inputs, mint, outputs }
}

fn run_mint(tx: Transaction) -> Bool {
  one_shot_mint.one_shot_mint.mint(
    seed.transaction_id,
    seed.output_index,
    reference_holder_hash,
    Void,
    policy_id,
    tx,
  )
}

// ---------------------------------------------------------------------------
// Positive: seed consumed + quantity == 1 + NFT at reference_holder + sane datum
// ---------------------------------------------------------------------------

test one_shot_mint_accepts_canonical_bootstrap_tx() {
  let tx =
    tx_with(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name, 1),
      [canonical_reference_output()],
    )
  run_mint(tx)
}

test one_shot_mint_positive_seed_among_others() {
  // Seed in the middle of an input list still satisfies the rule.
  let tx =
    tx_with(
      [placeholder_input(other_ref), placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name, 1),
      [canonical_reference_output()],
    )
  run_mint(tx)
}

test one_shot_mint_accepts_change_output_alongside_reference() {
  // Realistic bootstrap shape: one reference-holder output plus one change
  // output back to the deployer's wallet. The validator finds the
  // reference-holder output regardless of position.
  let change_output =
    Output {
      address: address.from_verification_key(
        #"22222222222222222222222222222222222222222222222222222222",
      ),
      value: assets.from_lovelace(50_000_000),
      datum: NoDatum,
      reference_script: None,
    }
  let tx =
    tx_with(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name, 1),
      [change_output, canonical_reference_output()],
    )
  run_mint(tx)
}

// ---------------------------------------------------------------------------
// Negative: seed not consumed
// ---------------------------------------------------------------------------

test one_shot_mint_rejects_seed_missing() {
  let tx =
    tx_with(
      [placeholder_input(other_ref)],
      assets.from_asset(policy_id, asset_name, 1),
      [canonical_reference_output()],
    )
  !run_mint(tx)
}

test one_shot_mint_rejects_no_inputs() {
  let tx =
    tx_with(
      [],
      assets.from_asset(policy_id, asset_name, 1),
      [canonical_reference_output()],
    )
  !run_mint(tx)
}

// ---------------------------------------------------------------------------
// Negative: wrong mint quantity
// ---------------------------------------------------------------------------

test one_shot_mint_rejects_quantity_zero() fail {
  // No tokens minted under the policy at all → `dict.to_pairs` returns []
  // and the `expect [Pair(_, _)]` pattern aborts. Marked `fail` because
  // the validator path takes the abort route rather than returning False.
  let tx =
    tx_with(
      [placeholder_input(seed)],
      assets.zero,
      [canonical_reference_output()],
    )
  run_mint(tx)
}

test one_shot_mint_rejects_quantity_two() fail {
  // Quantity 2 means the reference-holder output (which carries exactly 1)
  // doesn't account for both tokens; the find returns the holder output
  // but `quantity == 1` fails. Marked `fail` because the find can also
  // miss when there is no output that holds both — depending on shape the
  // path may abort on `expect Some(target)`. Either way this is rejected.
  let tx =
    tx_with(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name, 2),
      [canonical_reference_output()],
    )
  run_mint(tx)
}

test one_shot_mint_rejects_burn() fail {
  // Burning the NFT (-1) must be rejected — the reference NFT has to live
  // forever. The minted quantity check fails (1 != -1), and additionally
  // the find never locates an output carrying quantity == 1 of the NFT
  // because there's nothing to send. `fail` covers either reject path.
  let tx =
    tx_with(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name, -1),
      [canonical_reference_output()],
    )
  run_mint(tx)
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
  let tx =
    tx_with([placeholder_input(seed)], value, [canonical_reference_output()])
  run_mint(tx)
}

// ---------------------------------------------------------------------------
// Negative: wrong asset name (audit F-17, next-redeploy bundle Q-2).
// The pre-fix policy would have minted under any asset name; post-fix the
// validator pins the name to "lovejoin" and rejects every other value.
// ---------------------------------------------------------------------------

test one_shot_mint_rejects_wrong_asset_name() {
  // "lovejon" — a realistic typo. quantity is right (1), seed is consumed,
  // and the reference-holder output carries the wrongly-named token (so
  // the L-01 destination check passes for the typo'd name). The asset-name
  // equality check still rejects.
  let typo_output =
    Output {
      address: script_address(reference_holder_hash),
      value: assets.add(
        assets.from_lovelace(2_000_000),
        policy_id,
        asset_name_typo,
        1,
      ),
      datum: InlineDatum(
        {
          let d: Data = default_reference_datum()
          d
        },
      ),
      reference_script: None,
    }
  let tx =
    tx_with(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name_typo, 1),
      [typo_output],
    )
  !run_mint(tx)
}

test one_shot_mint_rejects_empty_asset_name() {
  // Empty asset name was the previous test fixture and is also a common
  // mis-bootstrap shape (forgetting to set REF_NFT_ASSET_NAME at all).
  let empty_output =
    Output {
      address: script_address(reference_holder_hash),
      value: assets.add(assets.from_lovelace(2_000_000), policy_id, "", 1),
      datum: InlineDatum(
        {
          let d: Data = default_reference_datum()
          d
        },
      ),
      reference_script: None,
    }
  let tx =
    tx_with(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, "", 1),
      [empty_output],
    )
  !run_mint(tx)
}

// Reference-holder output with the address overridden — used to build the
// audit-of-audit L-01 negatives where the deployer mints the NFT to the
// right payment credential but attaches a non-None stake credential.
fn reference_output_with_address(address: address.Address) -> Output {
  let datum: Data = default_reference_datum()
  Output {
    address,
    value: assets.add(assets.from_lovelace(2_000_000), policy_id, asset_name, 1),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

// Reference-holder output with an attached `reference_script` — the
// audit-of-audit M-class negative on the bootstrap codepath. The script
// payload bytes themselves don't matter; the validator rejects on
// `Some(_)`, not on the contents.
fn reference_output_with_ref_script(ref_script_hash: ByteArray) -> Output {
  let datum: Data = default_reference_datum()
  Output {
    address: script_address(reference_holder_hash),
    value: assets.add(assets.from_lovelace(2_000_000), policy_id, asset_name, 1),
    datum: InlineDatum(datum),
    reference_script: Some(ref_script_hash),
  }
}

const attacker_stake_vk: ByteArray =
  #"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

const attacker_stake_script: ByteArray =
  #"baadcafebaadcafebaadcafebaadcafebaadcafebaadcafebaadcafe"

const attacker_ref_script: ByteArray =
  #"abadbabeabadbabeabadbabeabadbabeabadbabeabadbabeabadbabe"

// ---------------------------------------------------------------------------
// Negative: NFT not sent to the reference_holder address (audit L-01).
// Pre-fix, whoever first consumed the seed UTxO could put the NFT anywhere.
// ---------------------------------------------------------------------------

test one_shot_mint_rejects_when_nft_not_sent_to_reference_holder() fail {
  // Same canonical datum, same quantity, but the output is parked at an
  // arbitrary other script. `find` returns `None`, the `expect Some(target)`
  // aborts.
  let wrong_dest =
    Output {
      address: script_address(wrong_script_hash),
      value: assets.add(
        assets.from_lovelace(2_000_000),
        policy_id,
        asset_name,
        1,
      ),
      datum: InlineDatum(
        {
          let d: Data = default_reference_datum()
          d
        },
      ),
      reference_script: None,
    }
  let tx =
    tx_with(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name, 1),
      [wrong_dest],
    )
  run_mint(tx)
}

test one_shot_mint_rejects_when_nft_sent_to_payment_key_address() fail {
  // The realistic L-01 attack: the deployer (or attacker) mints into their
  // own wallet rather than the reference-holder script. Payment credential
  // is a verification key, so the `Script(h)` arm of `find` never matches.
  let vk_dest =
    Output {
      address: address.from_verification_key(
        #"33333333333333333333333333333333333333333333333333333333",
      ),
      value: assets.add(
        assets.from_lovelace(2_000_000),
        policy_id,
        asset_name,
        1,
      ),
      datum: InlineDatum(
        {
          let d: Data = default_reference_datum()
          d
        },
      ),
      reference_script: None,
    }
  let tx =
    tx_with(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name, 1),
      [vk_dest],
    )
  run_mint(tx)
}

// ---------------------------------------------------------------------------
// Negative: target datum is not in `ReferenceDatum` shape (audit L-02).
// ---------------------------------------------------------------------------

test one_shot_mint_rejects_when_target_datum_is_not_reference_datum_shape() fail {
  // A bare integer rather than a Constr-0 with five fields. The
  // `expect parsed: ReferenceDatum = datum_data` aborts.
  let wrong_shape: Data = 42
  let tx =
    tx_with(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name, 1),
      [reference_output_with_datum(wrong_shape)],
    )
  run_mint(tx)
}

test one_shot_mint_rejects_when_target_has_no_inline_datum() fail {
  // Hash-only datum (or no datum at all) is rejected: `ReferenceDatum`
  // must be inline so other validators can read it via reference_inputs
  // without needing the original datum body in their witness set.
  let no_datum_output =
    Output {
      address: script_address(reference_holder_hash),
      value: assets.add(
        assets.from_lovelace(2_000_000),
        policy_id,
        asset_name,
        1,
      ),
      datum: NoDatum,
      reference_script: None,
    }
  let tx =
    tx_with(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name, 1),
      [no_datum_output],
    )
  run_mint(tx)
}

// ---------------------------------------------------------------------------
// Negative: target datum has out-of-range field values (audit L-02).
// ---------------------------------------------------------------------------

test one_shot_mint_rejects_when_target_datum_has_zero_denom() {
  // denom_lovelace == 0 makes every Deposit value-check vacuous (any
  // amount of ADA satisfies "exactly denom_lovelace lovelace"). We reject
  // at bootstrap rather than ship a brick.
  let bad_datum: Data =
    ReferenceDatum { ..default_reference_datum(), denom_lovelace: 0 }
  let tx =
    tx_with(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name, 1),
      [reference_output_with_datum(bad_datum)],
    )
  !run_mint(tx)
}

test one_shot_mint_rejects_when_target_datum_has_negative_denom() {
  // Negative denom is even more obviously bad — fee shards would be
  // expected to "increase" by spending negative lovelace.
  let bad_datum: Data =
    ReferenceDatum { ..default_reference_datum(), denom_lovelace: -1 }
  let tx =
    tx_with(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name, 1),
      [reference_output_with_datum(bad_datum)],
    )
  !run_mint(tx)
}

test one_shot_mint_rejects_when_target_datum_has_zero_max_fee() {
  // max_fee_per_mix_lovelace == 0 makes Mix txs un-payable (every shard
  // burn equals tx.fee, but tx.fee > 0 for any real tx). Bricked protocol.
  let bad_datum: Data =
    ReferenceDatum { ..default_reference_datum(), max_fee_per_mix_lovelace: 0 }
  let tx =
    tx_with(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name, 1),
      [reference_output_with_datum(bad_datum)],
    )
  !run_mint(tx)
}

test one_shot_mint_rejects_when_target_datum_has_max_fee_above_denom() {
  // max_fee >= denom means a single Mix tx can drain a fee shard for more
  // than the principal of one deposit, which inverts the protocol's
  // economics. Pin max_fee strictly less than denom.
  let bad_datum: Data =
    ReferenceDatum {
      ..default_reference_datum(),
      max_fee_per_mix_lovelace: 10_000_001,
    }
  let tx =
    tx_with(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name, 1),
      [reference_output_with_datum(bad_datum)],
    )
  !run_mint(tx)
}

test one_shot_mint_rejects_when_target_datum_has_max_fee_equal_to_denom() {
  // Equality is also rejected (strict less-than in the validator). A Mix
  // tx that pays its full denom as fee leaves the depositor with nothing.
  let bad_datum: Data =
    ReferenceDatum {
      ..default_reference_datum(),
      max_fee_per_mix_lovelace: 10_000_000,
    }
  let tx =
    tx_with(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name, 1),
      [reference_output_with_datum(bad_datum)],
    )
  !run_mint(tx)
}

// ---------------------------------------------------------------------------
// Negative: reference-holder output with non-None stake_credential or
// attached reference_script (audit L-01, audit-of-audit). Same H-01 / M-01
// rule that `output_at_script` / `output_at_fee` enforce on the ongoing
// pool/fee outputs, now applied to the one-time bootstrap output too.
// Without these checks the deployer could permanently siphon staking
// rewards on the reference UTxO's principal or park free reference-script
// bytes on the protocol's min-ADA budget — `reference_holder` is
// always-False so the gap would never close.
//
// All four are `fail` rather than `!run_mint`: when the destination
// predicate matches no output, `expect Some(target)` aborts the script
// (same rejection shape as `_when_nft_not_sent_to_reference_holder`).
// ---------------------------------------------------------------------------

test one_shot_mint_rejects_target_with_inline_vk_stake_credential() fail {
  // Deployer attaches their own stake-key credential to the reference
  // UTxO. Rewards on the locked principal would accrue to the deployer
  // forever. Predicate finds no clean-perimeter output → expect aborts.
  let bad_addr =
    script_address_with_stake_vk(reference_holder_hash, attacker_stake_vk)
  let tx =
    tx_with(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name, 1),
      [reference_output_with_address(bad_addr)],
    )
  run_mint(tx)
}

test one_shot_mint_rejects_target_with_inline_script_stake_credential() fail {
  // Variant: stake credential is a script (e.g. an attacker-controlled
  // withdraw-zero contract that auto-routes rewards). Same rule.
  let bad_addr =
    script_address_with_stake_script(
      reference_holder_hash,
      attacker_stake_script,
    )
  let tx =
    tx_with(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name, 1),
      [reference_output_with_address(bad_addr)],
    )
  run_mint(tx)
}

test one_shot_mint_rejects_target_with_pointer_stake_credential() fail {
  // Completeness: pointer stake credentials (CIP-19 type 04/05) are a
  // valid Shelley-era address shape. Rare on chain today but the
  // perimeter rule must reject every non-None stake-credential shape, not
  // just the inline ones.
  let bad_addr = script_address_with_stake_pointer(reference_holder_hash)
  let tx =
    tx_with(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name, 1),
      [reference_output_with_address(bad_addr)],
    )
  run_mint(tx)
}

test one_shot_mint_rejects_target_with_attached_reference_script() fail {
  // Deployer attaches an arbitrary reference_script payload to the
  // reference UTxO, riding on the protocol's min-ADA budget for free
  // script storage. The new `reference_script == None` perimeter rejects.
  let tx =
    tx_with(
      [placeholder_input(seed)],
      assets.from_asset(policy_id, asset_name, 1),
      [reference_output_with_ref_script(attacker_ref_script)],
    )
  run_mint(tx)
}
