//// Reference holder — always-False spend, parameterized by the protocol's
//// reference NFT identity.
////
//// Spec: docs/spec/03-contracts.md §1.
////
//// The protocol's hyperstructure anchor: the one-of-one NFT and the inline
//// `ReferenceDatum` live forever at this validator. Cardano reads
//// `reference_inputs` without executing the script, so this validator never
//// runs in normal operation. Always-False is defense-in-depth — any direct
//// spend attempt rejects.
////
//// We parameterize the validator by `(reference_nft_policy, reference_nft_name)`
//// so the script's hash (and therefore its address) is unique per protocol
//// deployment, even though the body always rejects. Two different mixers using
//// the same Aiken source still get distinct reference_holder addresses
//// because their NFTs differ. Aiken bakes the parameters into the compiled
//// UPLC even when the body doesn't reference them, so the underscore-prefixed
//// names are correct: they're "unused inside the body" but very much used by
//// the script-hash derivation.

use aiken/primitive/bytearray
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{OutputReference, Transaction}

validator reference_holder(
  reference_nft_policy: PolicyId,
  reference_nft_name: AssetName,
) {
  spend(
    _d: Option<Data>,
    _r: Data,
    _utxo: OutputReference,
    _self: Transaction,
  ) {
    // Always-False, with the parameters folded into the result expression so
    // the optimizer can't strip them. `bytearray.length` is non-negative, so
    // both `< 0` checks are always False and the `||` is always False — but
    // because the parameters appear in the returned value, they're part of the
    // compiled UPLC and therefore part of the script hash. (Aiken eliminates
    // unused let-bindings, so a `let _ = …` would NOT keep them.)
    bytearray.length(reference_nft_policy) < 0
      || bytearray.length(reference_nft_name) < 0
  }
}
