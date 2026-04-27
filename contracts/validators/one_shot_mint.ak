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
use cardano/transaction.{OutputReference, Transaction}

validator one_shot_mint(seed: OutputReference) {
  mint(_r: Data, policy_id: assets.PolicyId, self: Transaction) {
    let seed_consumed =
      self.inputs
        |> list.any(fn(input) { input.output_reference == seed })

    let minted_quantity =
      assets.tokens(self.mint, policy_id)
        |> dict.foldr(0, fn(_name, qty, acc) { qty + acc })

    seed_consumed && minted_quantity == 1
  }
}
