//// `mix_box` — pooled mix-box spend validator (withdraw-zero pass-through).
////
//// Spec: docs/spec/03-contracts.md §0 (rules), §2 (validator design).
////
//// This validator is intentionally tiny. The actual Owner / Mix logic — proof
//// verification, output structure, ctx computation — lives in `mix_logic`, which
//// runs once per tx via the withdraw-zero pattern. Here we only do two things:
////
////   1. If the input's datum is a well-formed `MixDatum`, require that the tx's
////      `withdrawals` includes the `mix_logic` credential. The amount is unconstrained
////      (typically 0) — only presence matters. That presence forces `mix_logic` to
////      run and validate the spend.
////   2. If the input's datum is missing or malformed (Rule 2 — hyperstructure datum
////      tolerance), return True. Those UTxOs were never part of the privacy pool;
////      anyone can sweep them.

use aiken/collection/pairs
use cardano/address.{Credential}
use cardano/transaction.{OutputReference, Transaction}
use lovejoin/mixbox.{try_decode_well_formed_optional}

validator mix_box(mix_logic_credential: Credential) {
  spend(
    datum: Option<Data>,
    _redeemer: Data,
    _utxo: OutputReference,
    self: Transaction,
  ) {
    when try_decode_well_formed_optional(datum) is {
      Some(_md) -> pairs.has_key(self.withdrawals, mix_logic_credential)
      None -> True
    }
  }
}
