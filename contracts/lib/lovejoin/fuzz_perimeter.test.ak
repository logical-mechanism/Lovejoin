//// Property tests for the H-01 / M-01 perimeter checks on continuing
//// protocol outputs.
////
//// Spec / audit: docs/audit_report.md H-01 (stake-credential hijack) and
//// M-01 (reference-script injection); the matching unit-level negatives
//// live in `mix_logic.test.ak` and `fee_contract.test.ak`.
////
//// Properties tested:
////   1. `output_at_script` returns False whenever `stake_credential` is any
////      of the three non-None shapes (Inline VK, Inline Script, Pointer),
////      holding payment credential and reference_script at canonical None.
////   2. `output_at_script` returns False whenever `reference_script` is
////      `Some(_)`, holding payment credential matched and stake_credential
////      at None.
////   3. Same two properties for `output_at_fee`.
////   4. Positive-sanity: with `stake_credential == None`,
////      `reference_script == None`, and matching payment credential,
////      both helpers return True for arbitrary (deterministic) hash bytes.
////
//// The fuzzer drives the script-hash bytes so we exercise hash equality
//// (not just one fixed pair) and confirm the rule is purely structural.

use aiken/fuzz
use cardano/address.{
  Address, Credential, Inline, Pointer, Script, VerificationKey,
}
use cardano/assets
use cardano/transaction.{InlineDatum, Output}
use lovejoin/fee.{output_at_fee}
use lovejoin/mixbox.{output_at_script}

// 28-byte ScriptHash / VerificationKeyHash bytes; matches the on-chain
// invariant — anything else is invalid Plutus context input.
const cred_len: Int = 28

fn hash28() -> Fuzzer<ByteArray> {
  fuzz.bytearray_fixed(cred_len)
}

// Build an Address with the given payment script hash and a non-None stake
// credential. We pass the stake credential AS Option<Credential> rather than
// as a typed StakeCredential so the same generator covers both Inline-VK and
// Inline-Script shapes — the stdlib's Pointer variant is generated separately
// via `pointer_address`.
fn script_address_with_inline_stake(
  payment_hash: ByteArray,
  stake_cred: Credential,
) -> Address {
  Address {
    payment_credential: Script(payment_hash),
    stake_credential: Some(Inline(stake_cred)),
  }
}

fn pointer_address(payment_hash: ByteArray) -> Address {
  Address {
    payment_credential: Script(payment_hash),
    stake_credential: Some(
      Pointer { slot_number: 1, transaction_index: 0, certificate_index: 0 },
    ),
  }
}

fn script_address_none(payment_hash: ByteArray) -> Address {
  Address { payment_credential: Script(payment_hash), stake_credential: None }
}

// Canonical-shaped output (datum + value as a typical mix-box) at the given
// address with optional `reference_script`. The exact datum / value bytes
// don't matter — `output_at_*` only inspects address and reference_script.
fn output_at(address: Address, reference_script: Option<ByteArray>) -> Output {
  let unit: Data = Void
  Output {
    address,
    value: assets.from_lovelace(2_000_000),
    datum: InlineDatum(unit),
    reference_script,
  }
}

// ---------------------------------------------------------------------------
// Property 1 — stake_credential ∈ {Inline VK, Inline Script} rejects.
// (Pointer covered by Property 1b below — Aiken's fuzz combinators can't
// directly construct a Referenced<Credential> with a Pointer arm because
// Pointer carries integer fields, so we test it as a separate property.)
// ---------------------------------------------------------------------------

test prop_output_at_script_rejects_inline_stake_vk(payment_hash via hash28()) {
  // Inline VerificationKey stake credential — the H-01 attack shape. Must
  // reject regardless of the (matching) payment hash. The fuzzer varies the
  // payment hash so we exercise hash equality, not just one fixed pair.
  let stake_vk: ByteArray =
    #"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
  let addr =
    script_address_with_inline_stake(payment_hash, VerificationKey(stake_vk))
  let out = output_at(addr, None)
  !output_at_script(out, payment_hash)
}

test prop_output_at_script_rejects_inline_stake_script(
  payment_hash via hash28(),
) {
  let stake_script: ByteArray =
    #"baadcafebaadcafebaadcafebaadcafebaadcafebaadcafebaadcafe"
  let addr =
    script_address_with_inline_stake(payment_hash, Script(stake_script))
  let out = output_at(addr, None)
  !output_at_script(out, payment_hash)
}

test prop_output_at_script_rejects_pointer_stake(payment_hash via hash28()) {
  let addr = pointer_address(payment_hash)
  let out = output_at(addr, None)
  !output_at_script(out, payment_hash)
}

// ---------------------------------------------------------------------------
// Property 2 — reference_script == Some(_) rejects.
// ---------------------------------------------------------------------------

test prop_output_at_script_rejects_attached_reference_script(
  payment_hash via hash28(),
) {
  let ref_bytes: ByteArray =
    #"abadbabeabadbabeabadbabeabadbabeabadbabeabadbabeabadbabe"
  let addr = script_address_none(payment_hash)
  let out = output_at(addr, Some(ref_bytes))
  !output_at_script(out, payment_hash)
}

// ---------------------------------------------------------------------------
// Property 3 — same two for `output_at_fee`. Fee helper is structurally
// identical to the mix helper; we run the property suite against both so a
// future divergence in either implementation would break a fuzz test.
// ---------------------------------------------------------------------------

test prop_output_at_fee_rejects_inline_stake_vk(payment_hash via hash28()) {
  let stake_vk: ByteArray =
    #"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
  let addr =
    script_address_with_inline_stake(payment_hash, VerificationKey(stake_vk))
  let out = output_at(addr, None)
  !output_at_fee(out, payment_hash)
}

test prop_output_at_fee_rejects_inline_stake_script(payment_hash via hash28()) {
  let stake_script: ByteArray =
    #"baadcafebaadcafebaadcafebaadcafebaadcafebaadcafebaadcafe"
  let addr =
    script_address_with_inline_stake(payment_hash, Script(stake_script))
  let out = output_at(addr, None)
  !output_at_fee(out, payment_hash)
}

test prop_output_at_fee_rejects_pointer_stake(payment_hash via hash28()) {
  let addr = pointer_address(payment_hash)
  let out = output_at(addr, None)
  !output_at_fee(out, payment_hash)
}

test prop_output_at_fee_rejects_attached_reference_script(
  payment_hash via hash28(),
) {
  let ref_bytes: ByteArray =
    #"abadbabeabadbabeabadbabeabadbabeabadbabeabadbabeabadbabe"
  let addr = script_address_none(payment_hash)
  let out = output_at(addr, Some(ref_bytes))
  !output_at_fee(out, payment_hash)
}

// ---------------------------------------------------------------------------
// Positive sanity — with the perimeter at None / None and a matching
// payment hash, both helpers return True for arbitrary (deterministic) hash
// bytes. Without this property the negative tests above could pass trivially
// from a too-strict implementation that always returns False.
// ---------------------------------------------------------------------------

test prop_output_at_script_accepts_clean_perimeter(payment_hash via hash28()) {
  let addr = script_address_none(payment_hash)
  let out = output_at(addr, None)
  output_at_script(out, payment_hash)
}

test prop_output_at_fee_accepts_clean_perimeter(payment_hash via hash28()) {
  let addr = script_address_none(payment_hash)
  let out = output_at(addr, None)
  output_at_fee(out, payment_hash)
}

// ---------------------------------------------------------------------------
// Negative sanity — payment-credential mismatch always rejects (regardless
// of stake / reference-script perimeter). Pins the helpers to "match exact
// payment hash" rather than "match any script payment credential."
// ---------------------------------------------------------------------------

test prop_output_at_script_rejects_wrong_payment_hash(payment_hash via hash28()) {
  // Every real ScriptHash is 28 bytes. The empty bytearray is therefore
  // guaranteed to differ from any fuzzed `payment_hash`, exercising the
  // "different hash" branch even when the fuzzer happens to pick repeated
  // values.
  let wrong: ByteArray = #""
  let addr = script_address_none(payment_hash)
  let out = output_at(addr, None)
  !output_at_script(out, wrong)
}

test prop_output_at_fee_rejects_wrong_payment_hash(payment_hash via hash28()) {
  let wrong: ByteArray = #""
  let addr = script_address_none(payment_hash)
  let out = output_at(addr, None)
  !output_at_fee(out, wrong)
}
