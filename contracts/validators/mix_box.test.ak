//// `mix_box` (spend; withdraw-zero pass-through) tests.
////
//// Spec: §0 (rules), §2 (mix_box validator).
//// Audit: docs/audit-2026-05-03.md F-2 (inline-only well-formedness gate).
////
//// Three paths to verify:
////   1. InlineDatum + well-formed `MixDatum` → require `tx.withdrawals` to
////      contain the configured `mix_logic` credential.
////   2. InlineDatum but malformed datum → True (Rule 2).
////   3. NoDatum or DatumHash → True (Rule 2; mix_logic doesn't see these,
////      so mix_box must not gate them through the proof-required path
////      either — see audit F-2).

use cardano/address.{Address, Credential, Script}
use cardano/assets
use cardano/transaction.{
  Datum, DatumHash, InlineDatum, Input, NoDatum, Output, OutputReference,
  Transaction,
}
use lovejoin/types.{MixDatum, Replenish}
use mix_box

const mix_logic_hash: ByteArray =
  #"33333333333333333333333333333333333333333333333333333333"

const other_hash: ByteArray =
  #"44444444444444444444444444444444444444444444444444444444"

const mix_script_hash: ByteArray =
  #"55555555555555555555555555555555555555555555555555555555"

const own_utxo: OutputReference =
  OutputReference {
    transaction_id: #"00000000000000000000000000000000000000000000000000000000000000aa",
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

/// Build an Input at mix-script address with the supplied `Datum` field.
/// The validator only looks at `output.datum`; address shape doesn't matter
/// for mix_box (it runs because Cardano routed the spend), so we use a
/// neutral mix-script payment credential.
fn mix_input_with_datum(datum: Datum) -> Input {
  Input {
    output_reference: own_utxo,
    output: Output {
      address: Address {
        payment_credential: Script(mix_script_hash),
        stake_credential: None,
      },
      value: assets.from_lovelace(10_000_000),
      datum,
      reference_script: None,
    },
  }
}

/// Synthetic tx whose only input is at `own_utxo` with the supplied datum
/// and the supplied withdrawals.
fn tx_with(datum: Datum, withdrawals: Pairs<Credential, Int>) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [mix_input_with_datum(datum)],
    withdrawals,
  }
}

// ---------------------------------------------------------------------------
// InlineDatum + well-formed MixDatum: requires withdraw-zero to be present
// ---------------------------------------------------------------------------

test mix_box_accepts_when_mix_logic_withdraws_zero() {
  let tx =
    tx_with(InlineDatum(well_formed_datum()), [Pair(Script(mix_logic_hash), 0)])
  mix_box.mix_box.spend(mix_logic_hash, None, Void, own_utxo, tx)
}

test mix_box_accepts_when_mix_logic_withdraws_nonzero() {
  // Amount doesn't matter; presence does. Mixers / users could plausibly
  // route real rewards through the same withdrawal — the validator is
  // amount-agnostic.
  let tx =
    tx_with(
      InlineDatum(well_formed_datum()),
      [Pair(Script(mix_logic_hash), 1_000_000)],
    )
  mix_box.mix_box.spend(mix_logic_hash, None, Void, own_utxo, tx)
}

test mix_box_accepts_with_other_withdrawals_present() {
  // Ordering: Pairs<Credential, Lovelace> is sorted by ascending credential
  // per the ledger; `pairs.has_key` finds the entry regardless of position.
  let tx =
    tx_with(
      InlineDatum(well_formed_datum()),
      [Pair(Script(other_hash), 0), Pair(Script(mix_logic_hash), 0)],
    )
  mix_box.mix_box.spend(mix_logic_hash, None, Void, own_utxo, tx)
}

test mix_box_rejects_missing_withdrawal() {
  let tx = tx_with(InlineDatum(well_formed_datum()), [])
  !mix_box.mix_box.spend(mix_logic_hash, None, Void, own_utxo, tx)
}

test mix_box_rejects_wrong_withdrawal_credential() {
  let tx =
    tx_with(InlineDatum(well_formed_datum()), [Pair(Script(other_hash), 0)])
  !mix_box.mix_box.spend(mix_logic_hash, None, Void, own_utxo, tx)
}

// ---------------------------------------------------------------------------
// Hyperstructure recovery via InlineDatum: bad-shape inline → True
// ---------------------------------------------------------------------------

test mix_box_accepts_a_eq_b_datum_no_withdraw() {
  // a == b is malformed per spec §2; recovery path applies.
  let bad: Data = MixDatum { a: a48, b: a48 }
  let tx = tx_with(InlineDatum(bad), [])
  mix_box.mix_box.spend(mix_logic_hash, None, Void, own_utxo, tx)
}

test mix_box_accepts_short_bytes_datum_no_withdraw() {
  let short: Data = MixDatum { a: #"01", b: b48 }
  let tx = tx_with(InlineDatum(short), [])
  mix_box.mix_box.spend(mix_logic_hash, None, Void, own_utxo, tx)
}

test mix_box_accepts_int_datum_no_withdraw() {
  // Datum that doesn't even look like a Constr — definitely not a MixDatum.
  let i: Data = 42
  let tx = tx_with(InlineDatum(i), [])
  mix_box.mix_box.spend(mix_logic_hash, None, Void, own_utxo, tx)
}

test mix_box_accepts_wrong_constr_idx_datum_no_withdraw() {
  // A Constr 1 [a, b] decodes structurally but has the wrong constructor
  // index. Aiken types with `pub type Foo { Bar | Baz }` give Bar idx 0 and
  // Baz idx 1; we use FeeRedeemer.Replenish whose Constr is 1.
  let r: Data = Replenish
  let tx = tx_with(InlineDatum(r), [])
  mix_box.mix_box.spend(mix_logic_hash, None, Void, own_utxo, tx)
}

// ---------------------------------------------------------------------------
// F-2 — NoDatum and DatumHash mix-script inputs MUST take the recovery path,
// not gate through "needs mix_logic withdraw-zero". `mix_logic` silently
// drops both, so requiring withdraw-zero here would consume the input
// without any proof check (the asymmetry that F-2 closes).
// ---------------------------------------------------------------------------

test mix_box_no_datum_takes_recovery_path() {
  // No withdrawal in the tx. Recovery must succeed regardless.
  let tx = tx_with(NoDatum, [])
  mix_box.mix_box.spend(mix_logic_hash, None, Void, own_utxo, tx)
}

test mix_box_datum_hash_with_well_formed_preimage_takes_recovery_path() {
  // The CRITICAL F-2 case. A mix-script input stored as `DatumHash(h)` —
  // even when the resolved witness data decodes as a perfectly valid
  // `MixDatum` — must NOT route through the "require mix_logic" gate.
  // Otherwise mix_logic.collect_well_formed_mix_inputs would silently drop
  // it (only counting InlineDatum) and the input would be consumed without
  // a proof. Recovery is the only consistent treatment.
  //
  // We don't put any withdrawal into the tx; if the validator wrongly
  // gated this through "needs withdraw-zero", `pairs.has_key` would return
  // False and the spend would reject. With the F-2 fix, the typed-datum
  // walk hits the `_ -> True` arm before any withdrawal lookup.
  let zero32: ByteArray =
    #"0000000000000000000000000000000000000000000000000000000000000000"
  let tx = tx_with(DatumHash(zero32), [])
  mix_box.mix_box.spend(mix_logic_hash, None, Void, own_utxo, tx)
}

test mix_box_datum_hash_recovery_succeeds_even_when_other_withdrawals_present() {
  // Belt-and-suspenders: present a tx that DOES have the mix_logic
  // withdrawal (i.e., the rest of the tx looks like a real Mix tx for some
  // OTHER mix-script input). The DatumHash input here must STILL take the
  // recovery path — it isn't part of the privacy pool, and including the
  // withdrawal doesn't change that.
  let zero32: ByteArray =
    #"0000000000000000000000000000000000000000000000000000000000000000"
  let tx = tx_with(DatumHash(zero32), [Pair(Script(mix_logic_hash), 0)])
  mix_box.mix_box.spend(mix_logic_hash, None, Void, own_utxo, tx)
}
