//// One-shot minting policy.
////
//// Spec: docs/spec/03-contracts.md §1.
////
//// Parameterized by a seed `OutputReference`: the policy permits a single mint event
//// in which (a) the seed UTxO is consumed and (b) exactly one token is minted under
//// this policy. After the seed UTxO is consumed once, the policy can never fire
//// again — this is what makes the reference NFT a one-of-one for life.

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

    // Exactly one asset name under this policy with quantity 1. Tightening past
    // a simple sum rules out `[(n1, 2), (n2, -1)]`-style mints that the ledger's
    // balancing already blocks in practice but that the spec ("exactly one NFT")
    // is unambiguous about.
    let tokens_under_policy = assets.tokens(self.mint, policy_id)
    let total_minted =
      tokens_under_policy
        |> dict.foldr(0, fn(_asset_name, quantity, acc) { quantity + acc })

    and {
      seed_consumed,
      dict.size(tokens_under_policy) == 1,
      total_minted == 1,
    }
  }

  else(_) {
    fail
  }
}
