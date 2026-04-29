//// `mix_box` — pooled mix-box spend validator (withdraw-zero pass-through).
////
//// Spec: docs/spec/03-contracts.md §0 (rules), §2 (validator design).
////
//// This validator is intentionally tiny. The actual Owner / Mix logic — proof
//// verification, output structure, ctx computation — lives in `mix_logic`, which
//// runs once per tx via the withdraw-zero pattern. Here we only do two things:
////
////   1. If the input's datum is a well-formed *inline* `MixDatum`, require that
////      the tx's `withdrawals` includes the `mix_logic` credential. The amount
////      is unconstrained (typically 0) — only presence matters. That presence
////      forces `mix_logic` to run and validate the spend.
////   2. Otherwise — datum is missing, hash-stored, or doesn't decode to the
////      expected shape — return True (Rule 2: hyperstructure datum tolerance).
////      Those UTxOs were never part of the privacy pool; anyone can sweep them.
////
//// Inline-only gate (audit finding F-2). The Plutus V3 spend handler delivers
//// the resolved datum bytes for BOTH `InlineDatum` and `DatumHash`-with-
//// witness as `Some(data)`, indistinguishable from the `Option<Data>` param
//// alone. `mix_logic.collect_well_formed_mix_inputs`, in contrast, walks
//// `tx.inputs[].output.datum` (the typed `Datum` enum) and silently drops
//// `DatumHash(_)` mix-script inputs. Without this distinction in `mix_box`,
//// a `DatumHash` mix-script input would gate through the "needs proof" path
//// here while being skipped over there — meaning the input is consumed
//// without a proof. We close the asymmetry by walking `tx.inputs` to find
//// our own input, inspecting its typed datum, and only requiring withdraw-
//// zero when the datum is `InlineDatum(d)` AND `d` decodes as a well-formed
//// `MixDatum`. Hash-datum and no-datum mix-script UTxOs become recovery-
//// sweepable, identical to the way `mix_logic` already treats them.

use aiken/collection/list
use aiken/collection/pairs
use aiken/crypto.{ScriptHash}
use cardano/address.{Credential, Script}
use cardano/transaction.{InlineDatum, OutputReference, Transaction}
use lovejoin/mixbox.{try_decode_well_formed_data}

// Flat param (ScriptHash of mix_logic) — one CBOR bytes atom for
// `aiken blueprint apply`. We build the Credential from the hash inside.
validator mix_box(mix_logic_script_hash: ScriptHash) {
  spend(
    _datum: Option<Data>,
    _redeemer: Data,
    utxo: OutputReference,
    self: Transaction,
  ) {
    // Find this input on `tx.inputs` so we can read the typed `Datum`
    // (`InlineDatum` vs `DatumHash` vs `NoDatum`) instead of the
    // already-resolved `Option<Data>` we get from the spend handler.
    // Cardano guarantees exactly one match; missing match means the
    // ledger gave us a bad context — fail closed.
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == utxo })

    when own_input.output.datum is {
      InlineDatum(inline_data) ->
        when try_decode_well_formed_data(inline_data) is {
          Some(_md) -> {
            let mix_logic_credential: Credential = Script(mix_logic_script_hash)
            pairs.has_key(self.withdrawals, mix_logic_credential)
          }
          // Inline but not a well-formed MixDatum (a == b, wrong length,
          // wrong constructor, etc.) — Rule 2 recovery.
          None -> True
        }
      // NoDatum or DatumHash(_): not part of the privacy pool. Recovery.
      _ -> True
    }
  }

  else(_) {
    fail
  }
}
