//// Reference holder — always-False spend.
////
//// Spec: docs/spec/03-contracts.md §1.
////
//// The protocol's hyperstructure anchor: the one-of-one NFT and the inline
//// `ReferenceDatum` carrying `ProtocolParams` live forever at this validator. Cardano
//// reads `reference_inputs` without executing the script, so this validator never
//// actually runs in normal operation. Always-False is defense-in-depth: even if
//// someone tried to *spend* the reference UTxO, the script rejects.

use cardano/transaction.{OutputReference, Transaction}

validator reference_holder {
  spend(
    _d: Option<Data>,
    _r: Data,
    _utxo: OutputReference,
    _self: Transaction,
  ) {
    False
  }
}
