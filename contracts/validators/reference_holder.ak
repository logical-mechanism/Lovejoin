//// Reference holder — always-False spend.
////
//// Spec: §1.
////
//// The protocol's hyperstructure anchor: the one-of-one NFT and the inline
//// `ReferenceDatum` live forever at this validator. Cardano reads
//// `reference_inputs` without executing the script, so this validator never
//// runs in normal operation. Always-False is defense-in-depth — any direct
//// spend attempt rejects.
////
//// Audit L-01 / L-02 (issue #130): the validator takes no parameters. The
//// previous `(reference_nft_policy, reference_nft_name)` pair was documentary
//// only — the body never read it — and removing it lets `one_shot_mint` take
//// `reference_holder_hash` as a parameter without forming a compile-time
//// circular dependency. Bootstrap now computes the reference-holder hash
//// first (parameter-free) and threads it into `one_shot_mint`, which then
//// asserts on chain that the minted NFT lands at this script with a
//// well-formed `ReferenceDatum`.

use cardano/transaction.{OutputReference, Transaction}

validator reference_holder {
  spend(_d: Option<Data>, _r: Data, _utxo: OutputReference, _self: Transaction) {
    False
  }

  else(_) {
    fail
  }
}
