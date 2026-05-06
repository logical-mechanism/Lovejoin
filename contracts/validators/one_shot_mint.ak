//// One-shot minting policy.
////
//// Spec: docs/spec/03-contracts.md §1.
////
//// Parameterized by a seed `OutputReference`: the policy permits a single mint event
//// in which (a) the seed UTxO is consumed and (b) exactly one token is minted under
//// this policy at the canonical asset name `"lovejoin"`. After the seed UTxO is
//// consumed once, the policy can never fire again — this is what makes the
//// reference NFT a one-of-one for life.
////
//// Audit F-17 (next-redeploy bundle Q-2): the asset name is baked into the
//// validator (`#"6c6f76656a6f696e"` = ASCII "lovejoin"). Pre-fix it was
//// supplied at bootstrap time via the `REF_NFT_ASSET_NAME` env-var; a typo
//// would mint the protocol NFT under a non-canonical name and the rest of
//// the bootstrap (which derives addresses from `(policy, name)`) would
//// silently sail past the mistake. With the literal baked in, the policy
//// id captures the protocol's identity and the asset name is no longer a
//// runtime degree of freedom.

use aiken/collection/dict
use aiken/collection/list
use cardano/assets
use cardano/transaction.{OutputReference, Transaction, TransactionId}

// Flat params so `aiken blueprint apply` can supply them as separate CBOR
// atoms (one CBOR atom per call). The bash side encodes seed_tx_id as bytes
// and seed_idx as int via cbor2; the validator reconstructs the
// OutputReference internally for the consumption check.
validator one_shot_mint(seed_tx_id: TransactionId, seed_idx: Int) {
  mint(_redeemer: Data, policy_id: assets.PolicyId, self: Transaction) {
    let seed =
      OutputReference { transaction_id: seed_tx_id, output_index: seed_idx }
    let seed_consumed =
      self.inputs
        |> list.any(fn(input) { input.output_reference == seed })

    // Exactly one (asset_name, quantity) pair under this policy. The
    // pattern-match on `[Pair(_, _)]` enforces dict size == 1, so the
    // explicit size check folds away. Asset name is pinned to
    // `"lovejoin"` (hex 6c6f76656a6f696e); quantity is pinned to 1.
    let tokens_under_policy = assets.tokens(self.mint, policy_id)
    expect [Pair(asset_name, quantity)] =
      tokens_under_policy |> dict.to_pairs

    and {
      seed_consumed,
      asset_name == #"6c6f76656a6f696e",
      quantity == 1,
    }
  }

  else(_) {
    fail
  }
}
