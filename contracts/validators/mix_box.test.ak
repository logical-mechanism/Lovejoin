//// `mix_box` (spend; withdraw-zero pass-through) tests.
////
//// Spec: docs/spec/03-contracts.md §0 (rules), §2 (mix_box validator).
////
//// Two paths to verify:
////   1. Well-formed `MixDatum` → require `tx.withdrawals` to contain the configured
////      `mix_logic` credential. Amount is unconstrained.
////   2. Missing or malformed datum → True (Rule 2: hyperstructure recovery).

use cardano/address.{Credential, Script}
use cardano/transaction.{OutputReference, Transaction}
use lovejoin/types.{MixDatum, Replenish}
use mix_box

const mix_logic_hash: ByteArray =
  #"33333333333333333333333333333333333333333333333333333333"

const other_hash: ByteArray =
  #"44444444444444444444444444444444444444444444444444444444"

// (mix_box now takes the script hash directly as a flat ByteArray param.)

const dummy_utxo: OutputReference =
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
    output_index: 0,
  }

const a48: ByteArray =
  #"97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb"

const b48: ByteArray =
  #"a572cbea904d67468808c8eb50a9450c9721db309128012543902d0ac358a62ae28f75bb8f1c7c42c39a8c5529bf0f4e"

fn well_formed_datum() -> Data {
  let md: Data = MixDatum { a: a48, b: b48 }
  md
}

fn tx_with_withdrawals(withdrawals: Pairs<Credential, Int>) -> Transaction {
  Transaction { ..transaction.placeholder, withdrawals: withdrawals }
}

// ---------------------------------------------------------------------------
// Well-formed datum branch: requires withdraw-zero to be present
// ---------------------------------------------------------------------------

test mix_box_accepts_when_mix_logic_withdraws_zero() {
  let tx = tx_with_withdrawals([Pair(Script(mix_logic_hash), 0)])
  mix_box.mix_box.spend(mix_logic_hash,Some(well_formed_datum()), Void, dummy_utxo, tx)
}

test mix_box_accepts_when_mix_logic_withdraws_nonzero() {
  // Amount doesn't matter; presence does. Mixers / users could plausibly route
  // real rewards through the same withdrawal — the validator is amount-agnostic.
  let tx = tx_with_withdrawals([Pair(Script(mix_logic_hash), 1_000_000)])
  mix_box.mix_box.spend(mix_logic_hash,Some(well_formed_datum()), Void, dummy_utxo, tx)
}

test mix_box_accepts_with_other_withdrawals_present() {
  // Ordering: Pairs<Credential, Lovelace> is sorted by ascending credential per
  // the ledger; `pairs.has_key` finds the entry regardless of position.
  let tx =
    tx_with_withdrawals(
      [Pair(Script(other_hash), 0), Pair(Script(mix_logic_hash), 0)],
    )
  mix_box.mix_box.spend(mix_logic_hash,Some(well_formed_datum()), Void, dummy_utxo, tx)
}

test mix_box_rejects_missing_withdrawal() {
  let tx = tx_with_withdrawals([])
  !mix_box.mix_box.spend(mix_logic_hash,Some(well_formed_datum()), Void, dummy_utxo, tx)
}

test mix_box_rejects_wrong_withdrawal_credential() {
  let tx = tx_with_withdrawals([Pair(Script(other_hash), 0)])
  !mix_box.mix_box.spend(mix_logic_hash,Some(well_formed_datum()), Void, dummy_utxo, tx)
}

// ---------------------------------------------------------------------------
// Hyperstructure recovery: bad/missing datum → True
// ---------------------------------------------------------------------------

test mix_box_accepts_no_datum_no_withdraw() {
  // NoDatum on the spend (datum: None at the handler) — recovery is allowed
  // without the withdraw-zero check.
  let tx = tx_with_withdrawals([])
  mix_box.mix_box.spend(mix_logic_hash,None, Void, dummy_utxo, tx)
}

test mix_box_accepts_a_eq_b_datum_no_withdraw() {
  // a == b is malformed per spec §2; recovery path applies.
  let bad: Data = MixDatum { a: a48, b: a48 }
  let tx = tx_with_withdrawals([])
  mix_box.mix_box.spend(mix_logic_hash,Some(bad), Void, dummy_utxo, tx)
}

test mix_box_accepts_short_bytes_datum_no_withdraw() {
  let short: Data = MixDatum { a: #"01", b: b48 }
  let tx = tx_with_withdrawals([])
  mix_box.mix_box.spend(mix_logic_hash,Some(short), Void, dummy_utxo, tx)
}

test mix_box_accepts_int_datum_no_withdraw() {
  // Datum that doesn't even look like a Constr — definitely not a MixDatum.
  let i: Data = 42
  let tx = tx_with_withdrawals([])
  mix_box.mix_box.spend(mix_logic_hash,Some(i), Void, dummy_utxo, tx)
}

test mix_box_accepts_wrong_constr_idx_datum_no_withdraw() {
  // A Constr 1 [a, b] decodes structurally but has the wrong constructor index.
  // Aiken types with `pub type Foo { Bar { ... } | Baz { ... } }` give Bar idx 0
  // and Baz idx 1, etc. We can't construct a Constr 1 directly here without
  // adding a fake type, so we use FeeRedeemer.Replenish whose Constr is 1.
  let r: Data = Replenish
  let tx = tx_with_withdrawals([])
  mix_box.mix_box.spend(mix_logic_hash,Some(r), Void, dummy_utxo, tx)
}
