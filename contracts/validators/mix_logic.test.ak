//// `mix_logic` structural tests.
////
//// Spec: §0, §2.
////
//// Coverage today:
////   * Owner branch — input/proof count rules (positive=N inputs + N proofs,
////     negative=zero inputs, length mismatch).
////   * Mix branch  — N bounds, proofs-list length, output positions, output
////     well-formedness (denom, ada_only, datum decode), Rule 2 input filtering.
////   * Reference UTxO present / absent / malformed.
////
//// What's deferred to a follow-up commit:
////   * Owner-branch *proof-positive* (real Schnorr proof binding to ctx =
////     blake2b_256(serialise_data(self.outputs) || mix_script_hash)).
////   * Mix-branch *proof-positive* at N ∈ {2,3,4,6,8} (real OR proofs).
////   These need a TS-side `serialise_data(List<Output>)` shim that matches
////   Aiken's CBOR exactly so the prover can compute the same ctx the
////   validator does.  Tracked in docs/perf.md "M2 follow-ups".

use aiken/collection/list
use aiken/fuzz
use cardano/address.{Script}
use cardano/assets
use cardano/certificate.{
  AlwaysAbstain, AuthorizeConstitutionalCommitteeProxy, Certificate,
  DelegateBlockProduction, DelegateBoth, DelegateCredential, DelegateVote,
  RegisterAndDelegateCredential, RegisterCredential,
  RegisterDelegateRepresentative, RegisterStakePool, Registered,
  RetireFromConstitutionalCommittee, RetireStakePool, UnregisterCredential,
  UnregisterDelegateRepresentative, UpdateDelegateRepresentative,
}
use cardano/transaction.{Input, Output, Transaction}
use lovejoin/schnorr.{SchnorrProof}
use lovejoin/sigma_or.{DHTupleStatement, SigmaOrBranch, SigmaOrProof}
use lovejoin/test_fixtures.{
  a48, b48, c48, default_reference_input, denom_lovelace, fee_shard_output,
  mix_box_input, mix_box_input_bad_datum, mix_box_output,
  mix_box_output_with_address, mix_box_output_with_ref_script,
  mix_box_output_with_value, mix_logic_hash, mix_script_hash, random_user_vk,
  ref_nft_name, ref_nft_policy, script_address,
  script_address_with_stake_pointer, script_address_with_stake_script,
  script_address_with_stake_vk, vk_output_lovelace,
}
use lovejoin/types.{Mix, MixDatum, Owner}
use mix_logic

// ---------------------------------------------------------------------------
// Bogus proof shapes — used to exercise the structural rules in negative tests.
// The validator's structural rules run BEFORE proof verification, so a bogus
// proof never reaches the verifier in those cases. Using minimum-valid byte
// lengths keeps the inner well-formedness checks of the verifier itself happy
// (or doesn't matter, because the rule that's failing fails first).
// ---------------------------------------------------------------------------

const zero32: ByteArray =
  #"0000000000000000000000000000000000000000000000000000000000000000"

const zero48: ByteArray =
  #"000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

fn bogus_schnorr() -> SchnorrProof {
  SchnorrProof { t: zero48, z: zero32 }
}

fn bogus_sigma_or(n: Int) -> SigmaOrProof {
  SigmaOrProof { branches: replicate_branch(n, []) }
}

fn replicate_branch(n: Int, acc: List<SigmaOrBranch>) -> List<SigmaOrBranch> {
  if n == 0 {
    acc
  } else {
    let br = SigmaOrBranch { t0: zero48, t1: zero48, c: zero32, z: zero32 }
    replicate_branch(n - 1, [br, ..acc])
  }
}

// ---------------------------------------------------------------------------
// Owner branch — input count
// ---------------------------------------------------------------------------

test owner_rejects_zero_well_formed_inputs() fail {
  // No mix inputs at all — the `n >= 1` expect aborts.
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: [],
      outputs: [vk_output_lovelace(random_user_vk, denom_lovelace)],
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Owner { proofs: [bogus_schnorr()] },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

test owner_rejects_proof_count_mismatch() fail {
  // 2 well-formed mix inputs but only 1 proof — must be N==N.
  let i0 = mix_box_input(0xa0, 0, a48, b48, denom_lovelace)
  let i1 = mix_box_input(0xa1, 0, a48, c48, denom_lovelace)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: [i0, i1],
      outputs: [vk_output_lovelace(random_user_vk, denom_lovelace * 2)],
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Owner { proofs: [bogus_schnorr()] },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

test owner_with_two_inputs_rejects_bogus_proofs() fail {
  // 2 well-formed mix inputs + 2 proofs (count matches) — but the proofs are
  // zero-bytes, so `bls12_381_g1_uncompress` aborts on the first one. This
  // exercises the bulk-owner code path: structural length checks pass and we
  // reach per-input Schnorr verification.
  let i0 = mix_box_input(0xa0, 0, a48, b48, denom_lovelace)
  let i1 = mix_box_input(0xa1, 0, a48, c48, denom_lovelace)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: [i0, i1],
      outputs: [vk_output_lovelace(random_user_vk, denom_lovelace * 2)],
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Owner { proofs: [bogus_schnorr(), bogus_schnorr()] },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

test owner_with_one_well_formed_input_rejects_bogus_proof() fail {
  // 1 well-formed input → structural rules pass → schnorr.verify is called.
  // The bogus zero48 t commitment isn't a valid G1 point (the all-zero
  // compressed encoding fails subgroup check), so `point_from_bytes` aborts
  // — that's still a script rejection, just via the abort path rather than
  // returning False from the equation check.
  let i0 = mix_box_input(0xa0, 0, a48, b48, denom_lovelace)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: [i0],
      outputs: [vk_output_lovelace(random_user_vk, denom_lovelace)],
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Owner { proofs: [bogus_schnorr()] },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

test owner_ignores_bad_datum_inputs() fail {
  // Two mix-script inputs but ONE has a bad datum (Rule 2 — silently dropped
  // by mix_logic). The remaining well-formed count is 1 → Owner mode would be
  // structurally OK but proof verification fails (bogus proof). However the
  // bad-datum input ALSO has length-mismatch; mix_logic ignores it. Result:
  // we exercise the "skip malformed" path and the validator reaches proof verify,
  // where it crashes on `bls12_381_g1_uncompress` of the zero48 t commitment.
  // We mark this `fail` because the bogus zero48 isn't a valid G1 point.
  let bad_datum: Data = MixDatum { a: a48, b: a48 }
  // a == b → malformed
  let bad_input = mix_box_input_bad_datum(0xa0, 0, bad_datum)
  let good = mix_box_input(0xa1, 0, a48, b48, denom_lovelace)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: [bad_input, good],
      outputs: [vk_output_lovelace(random_user_vk, denom_lovelace * 2)],
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Owner { proofs: [bogus_schnorr()] },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

// ---------------------------------------------------------------------------
// Mix branch — N bounds + proofs.length
// ---------------------------------------------------------------------------

fn build_mix_inputs_at_a(n: Int) -> List<Input> {
  do_build_mix_inputs_at_a(n, 0, [])
}

fn do_build_mix_inputs_at_a(
  remaining: Int,
  idx: Int,
  acc: List<Input>,
) -> List<Input> {
  if remaining == 0 {
    list.reverse(acc)
  } else {
    let inp = mix_box_input(0xa0 + idx, 0, a48, b48, denom_lovelace)
    do_build_mix_inputs_at_a(remaining - 1, idx + 1, [inp, ..acc])
  }
}

fn build_mix_outputs_at_b(n: Int) -> List<Output> {
  do_build_mix_outputs_at_b(n, 0, [])
}

fn do_build_mix_outputs_at_b(
  remaining: Int,
  idx: Int,
  acc: List<Output>,
) -> List<Output> {
  if remaining == 0 {
    list.reverse(acc)
  } else {
    do_build_mix_outputs_at_b(
      remaining - 1,
      idx + 1,
      [mix_box_output(b48, c48, denom_lovelace), ..acc],
    )
  }
}

test mix_rejects_n_eq_1() fail {
  let inputs = build_mix_inputs_at_a(1)
  let outputs = build_mix_outputs_at_b(1)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs,
      outputs,
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Mix { proofs: [bogus_sigma_or(2)] },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

// (No `mix_rejects_n_above_max_n` test — the on-chain protocol no longer
// enforces an upper bound on N. The natural ceiling is the chain's per-tx
// CPU/mem budget, which can't be unit-tested without a real cost model.)

test mix_rejects_proofs_count_mismatch() fail {
  // 3 mix inputs, but proofs.length == 2 → length mismatch.
  let inputs = build_mix_inputs_at_a(3)
  let outputs = build_mix_outputs_at_b(3)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs,
      outputs,
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Mix { proofs: [bogus_sigma_or(3), bogus_sigma_or(3)] },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

// ---------------------------------------------------------------------------
// Mix branch — output position rules
// ---------------------------------------------------------------------------

test mix_rejects_mix_output_in_tail() fail {
  // 2 inputs but only 1 mix output at position 0; the other mix output is at
  // position 2 (after a fee/non-mix output at position 1). The take/drop split
  // means the prefix-N has [mix_out, fee_out] which fails the "all prefix at
  // mix_script" check.
  let inputs = build_mix_inputs_at_a(2)
  let mix_out0 = mix_box_output(b48, c48, denom_lovelace)
  let fee_out = fee_shard_output(1_000_000)
  let mix_out1 = mix_box_output(c48, b48, denom_lovelace)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs,
      outputs: [mix_out0, fee_out, mix_out1],
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Mix { proofs: [bogus_sigma_or(2), bogus_sigma_or(2)] },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

test mix_rejects_non_mix_output_in_prefix() fail {
  // 2 inputs, but the prefix-N has 1 mix output and 1 fee output.
  let inputs = build_mix_inputs_at_a(2)
  let mix_out = mix_box_output(b48, c48, denom_lovelace)
  let fee_out = fee_shard_output(1_000_000)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs,
      outputs: [mix_out, fee_out],
      // prefix-N = [mix, fee]; fee fails check
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Mix { proofs: [bogus_sigma_or(2), bogus_sigma_or(2)] },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

// ---------------------------------------------------------------------------
// Mix branch — output well-formedness (denom, ada_only, datum well-formed)
// ---------------------------------------------------------------------------

test mix_rejects_wrong_denom_output() fail {
  // Output value is denom-1 lovelace.
  let inputs = build_mix_inputs_at_a(2)
  let bad_out = mix_box_output(b48, c48, denom_lovelace - 1)
  let good_out = mix_box_output(c48, b48, denom_lovelace)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs,
      outputs: [bad_out, good_out],
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Mix { proofs: [bogus_sigma_or(2), bogus_sigma_or(2)] },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

test mix_rejects_native_asset_in_output() fail {
  let inputs = build_mix_inputs_at_a(2)
  let dirty =
    assets.merge(
      assets.from_lovelace(denom_lovelace),
      assets.from_asset(
        #"33333333333333333333333333333333333333333333333333333333",
        "junk",
        1,
      ),
    )
  let bad_out = mix_box_output_with_value(b48, c48, dirty)
  let good_out = mix_box_output(c48, b48, denom_lovelace)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs,
      outputs: [bad_out, good_out],
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Mix { proofs: [bogus_sigma_or(2), bogus_sigma_or(2)] },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

test mix_rejects_a_eq_b_output_datum() fail {
  let inputs = build_mix_inputs_at_a(2)
  // a == b on output datum → decode_mix_datum_strict aborts.
  let bad_out = mix_box_output(b48, b48, denom_lovelace)
  let good_out = mix_box_output(c48, b48, denom_lovelace)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs,
      outputs: [bad_out, good_out],
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Mix { proofs: [bogus_sigma_or(2), bogus_sigma_or(2)] },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

test mix_rejects_short_bytes_output_datum() fail {
  // Spec §2 Mix rule 3: output `MixDatum` well-formedness includes
  // `length(a) == 48 && length(b) == 48`. A 1-byte `a` field must be
  // rejected by `decode_mix_datum_strict`.
  let inputs = build_mix_inputs_at_a(2)
  let bad_out = mix_box_output(#"01", b48, denom_lovelace)
  let good_out = mix_box_output(c48, b48, denom_lovelace)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs,
      outputs: [bad_out, good_out],
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Mix { proofs: [bogus_sigma_or(2), bogus_sigma_or(2)] },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

// ---------------------------------------------------------------------------
// Mix branch — perimeter rules on continuing outputs (audit H-01, M-01).
//
// `output_at_script` requires `stake_credential == None` AND
// `reference_script == None` for any output at the mix-script payment
// credential. The four shape variants below all have a valid mix-script
// payment credential and a well-formed `MixDatum` at canonical denom — only
// the perimeter field is wrong, isolating the new check.
//
// We keep both prefix outputs structurally well-formed except for the bad
// perimeter on output 0; output 1 is the canonical good output. The prefix
// walk visits output 0 first, so `expect output_at_script(...)` aborts and
// the test passes via the `fail` annotation.
// ---------------------------------------------------------------------------

const attacker_stake_vk: ByteArray =
  #"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

const attacker_stake_script: ByteArray =
  #"baadcafebaadcafebaadcafebaadcafebaadcafebaadcafebaadcafe"

const attacker_ref_script: ByteArray =
  #"abadbabeabadbabeabadbabeabadbabeabadbabeabadbabeabadbabe"

test mix_rejects_continuing_output_with_attacker_stake_vk() fail {
  // H-01: a Mix tx attaches the attacker's stake-key credential to the
  // continuing mix-box output, redirecting the staking rewards on the
  // entire pool to the attacker until the next Mix contests it. The new
  // perimeter check (stake_credential == None) must reject.
  let inputs = build_mix_inputs_at_a(2)
  let bad_addr =
    script_address_with_stake_vk(mix_script_hash, attacker_stake_vk)
  let bad_out = mix_box_output_with_address(bad_addr, b48, c48, denom_lovelace)
  let good_out = mix_box_output(c48, b48, denom_lovelace)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs,
      outputs: [bad_out, good_out],
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Mix { proofs: [bogus_sigma_or(2), bogus_sigma_or(2)] },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

test mix_rejects_continuing_output_with_attacker_stake_script() fail {
  // H-01 variant: stake credential is a script (e.g. an attacker-controlled
  // withdraw-zero contract that auto-routes rewards). Same perimeter rule;
  // any non-None stake credential is rejected.
  let inputs = build_mix_inputs_at_a(2)
  let bad_addr =
    script_address_with_stake_script(mix_script_hash, attacker_stake_script)
  let bad_out = mix_box_output_with_address(bad_addr, b48, c48, denom_lovelace)
  let good_out = mix_box_output(c48, b48, denom_lovelace)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs,
      outputs: [bad_out, good_out],
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Mix { proofs: [bogus_sigma_or(2), bogus_sigma_or(2)] },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

test mix_rejects_continuing_output_with_pointer_stake_credential() fail {
  // H-01 completeness: pointer stake credentials (CIP-19 type 04/05) are
  // a valid Shelley-era address shape; the perimeter check rejects them
  // for the same reason as the inline variants. Rare on chain today but
  // we don't want any blind spot in the rule.
  let inputs = build_mix_inputs_at_a(2)
  let bad_addr = script_address_with_stake_pointer(mix_script_hash)
  let bad_out = mix_box_output_with_address(bad_addr, b48, c48, denom_lovelace)
  let good_out = mix_box_output(c48, b48, denom_lovelace)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs,
      outputs: [bad_out, good_out],
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Mix { proofs: [bogus_sigma_or(2), bogus_sigma_or(2)] },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

test mix_rejects_continuing_output_with_reference_script_attached() fail {
  // M-01: a Mix tx attaches an arbitrary reference_script payload to the
  // continuing mix-box output, using our pool as free reference-script
  // storage. Bounded min-ADA bloat per output, recurring on every Mix.
  // The new perimeter check (reference_script == None) must reject.
  let inputs = build_mix_inputs_at_a(2)
  let bad_out =
    mix_box_output_with_ref_script(
      b48,
      c48,
      denom_lovelace,
      attacker_ref_script,
    )
  let good_out = mix_box_output(c48, b48, denom_lovelace)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs,
      outputs: [bad_out, good_out],
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Mix { proofs: [bogus_sigma_or(2), bogus_sigma_or(2)] },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

test mix_rejects_fewer_outputs_than_inputs() fail {
  // Spec §2 Mix rule 2: `length(mix_outputs) == N` and they occupy positions
  // 0..N-1. Two well-formed mix inputs but only one mix output → the
  // `walk_outputs` prefix walk reaches end-of-list with `prefix_remaining == 1`
  // and the `expect prefix_remaining == 0` aborts.
  let inputs = build_mix_inputs_at_a(2)
  let only_out = mix_box_output(b48, c48, denom_lovelace)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs,
      outputs: [only_out],
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Mix { proofs: [bogus_sigma_or(2), bogus_sigma_or(2)] },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

// ---------------------------------------------------------------------------
// Reference UTxO present / absent
// ---------------------------------------------------------------------------

test mix_rejects_no_reference_input() fail {
  // Forgetting to attach the reference UTxO → read_protocol_params aborts.
  let inputs = build_mix_inputs_at_a(2)
  let outputs = build_mix_outputs_at_b(2)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [],
      inputs,
      outputs,
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Mix { proofs: [bogus_sigma_or(2), bogus_sigma_or(2)] },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

test owner_rejects_no_reference_input() fail {
  let i0 = mix_box_input(0xa0, 0, a48, b48, denom_lovelace)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [],
      inputs: [i0],
      outputs: [vk_output_lovelace(random_user_vk, denom_lovelace)],
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Owner { proofs: [bogus_schnorr()] },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

// ---------------------------------------------------------------------------
// Publish purpose — stake credential lifecycle. Spec:  §0.
//
// The mix_logic credential MUST be registered exactly once (per network) so
// withdraw-zero spends are valid going forward. After that, no further cert
// involving the credential should ever succeed — particularly de-registration,
// which would brick every mix_box spend forever after.
// ---------------------------------------------------------------------------

test publish_allows_register_credential() {
  let cert =
    RegisterCredential { credential: Script(mix_logic_hash), deposit: Never }
  mix_logic.mix_logic.publish(
    ref_nft_policy,
    ref_nft_name,
    Void,
    cert,
    transaction.placeholder,
  )
}

test publish_rejects_unregister_credential() {
  // Hyperstructure: unregistering would brick the protocol. Must reject.
  let cert =
    UnregisterCredential { credential: Script(mix_logic_hash), refund: Never }
  !mix_logic.mix_logic.publish(
    ref_nft_policy,
    ref_nft_name,
    Void,
    cert,
    transaction.placeholder,
  )
}

// Conway Certificate matrix (audit F-5). The mix_logic credential is for
// withdraw-zero only; we never want it delegating, voting, registering as a
// DRep, holding a stake pool, or sitting on the constitutional committee.
// The handler's `_ -> False` arm should reject every non-Register variant.
// One test per Aiken stdlib `Certificate` variant other than
// RegisterCredential / UnregisterCredential (already covered above).

test publish_rejects_delegate_credential() {
  let delegate = DelegateBlockProduction { stake_pool: random_user_vk }
  let cert = DelegateCredential { credential: Script(mix_logic_hash), delegate }
  !mix_logic.mix_logic.publish(
    ref_nft_policy,
    ref_nft_name,
    Void,
    cert,
    transaction.placeholder,
  )
}

test publish_rejects_register_and_delegate_credential() {
  let delegate =
    DelegateBoth {
      stake_pool: random_user_vk,
      delegate_representative: Registered(Script(mix_logic_hash)),
    }
  let cert =
    RegisterAndDelegateCredential {
      credential: Script(mix_logic_hash),
      delegate,
      deposit: 2_000_000,
    }
  !mix_logic.mix_logic.publish(
    ref_nft_policy,
    ref_nft_name,
    Void,
    cert,
    transaction.placeholder,
  )
}

test publish_rejects_vote_delegation() {
  // DelegateCredential + DelegateVote variant — the "delegate the credential's
  // governance voice without delegating block production" path.
  let delegate = DelegateVote { delegate_representative: AlwaysAbstain }
  let cert = DelegateCredential { credential: Script(mix_logic_hash), delegate }
  !mix_logic.mix_logic.publish(
    ref_nft_policy,
    ref_nft_name,
    Void,
    cert,
    transaction.placeholder,
  )
}

test publish_rejects_register_delegate_representative() {
  let cert =
    RegisterDelegateRepresentative {
      delegate_representative: Script(mix_logic_hash),
      deposit: 500_000_000,
    }
  !mix_logic.mix_logic.publish(
    ref_nft_policy,
    ref_nft_name,
    Void,
    cert,
    transaction.placeholder,
  )
}

test publish_rejects_update_delegate_representative() {
  let cert =
    UpdateDelegateRepresentative {
      delegate_representative: Script(mix_logic_hash),
    }
  !mix_logic.mix_logic.publish(
    ref_nft_policy,
    ref_nft_name,
    Void,
    cert,
    transaction.placeholder,
  )
}

test publish_rejects_unregister_delegate_representative() {
  let cert =
    UnregisterDelegateRepresentative {
      delegate_representative: Script(mix_logic_hash),
      refund: 500_000_000,
    }
  !mix_logic.mix_logic.publish(
    ref_nft_policy,
    ref_nft_name,
    Void,
    cert,
    transaction.placeholder,
  )
}

test publish_rejects_register_stake_pool() {
  // Defensive: a script credential isn't a valid stake-pool id, so the
  // ledger would reject this anyway. Validator should still fail closed.
  let cert =
    RegisterStakePool { stake_pool: random_user_vk, vrf: random_user_vk }
  !mix_logic.mix_logic.publish(
    ref_nft_policy,
    ref_nft_name,
    Void,
    cert,
    transaction.placeholder,
  )
}

test publish_rejects_retire_stake_pool() {
  let cert = RetireStakePool { stake_pool: random_user_vk, at_epoch: 9999 }
  !mix_logic.mix_logic.publish(
    ref_nft_policy,
    ref_nft_name,
    Void,
    cert,
    transaction.placeholder,
  )
}

test publish_rejects_authorize_constitutional_committee_proxy() {
  let cert =
    AuthorizeConstitutionalCommitteeProxy {
      constitutional_committee_member: Script(mix_logic_hash),
      proxy: Script(mix_logic_hash),
    }
  !mix_logic.mix_logic.publish(
    ref_nft_policy,
    ref_nft_name,
    Void,
    cert,
    transaction.placeholder,
  )
}

test publish_rejects_retire_from_constitutional_committee() {
  let cert =
    RetireFromConstitutionalCommittee {
      constitutional_committee_member: Script(mix_logic_hash),
    }
  !mix_logic.mix_logic.publish(
    ref_nft_policy,
    ref_nft_name,
    Void,
    cert,
    transaction.placeholder,
  )
}

// ---------------------------------------------------------------------------
// Mix branch — positive-prologue cost benchmarks.
//
// These tests build a *fully valid* Mix-tx prefix (N inputs, N outputs at
// positions 0..N-1, ada-only at the canonical denom, well-formed `MixDatum`
// on every output) and supply OR proofs of CORRECT LENGTH with all-zero
// t0/t1/c/z bytes. The validator runs every check in `validate_mix`:
//
//   1. structural pre-checks (`output_at_script` on prefix + tail),
//   2. per-output well-formedness (ada_only, denom, decode datum),
//   3. context computation (`compute_mix_ctx` — datum + value serialise),
//   4. statement pre-uncompression (`precompute_statements` — a48/b48/c48 ARE
//      valid G1 points, so this succeeds at every position),
//   5. into the per-input proof-verification loop, where the FIRST branch's
//      `bls.point_from_bytes(br.t0)` aborts (zero48 isn't on the curve).
//
// The script-cost numbers from these tests therefore measure the full Mix
// prologue plus the minimum amount of `verify_pre` work — which is the
// dominant contributor to a Mix tx's per-tx CPU/mem on chain. They give us
// a *positive-path proxy* for `validate_mix` that the rest of mix_logic.test
// (all early-failure cases) does not. Use them when judging refactors of
// the prologue: cumulative test CPU here moving DOWN means chain CPU on
// real Mix txs moves down by at least as much.
// ---------------------------------------------------------------------------

fn run_mix_full_prologue(n: Int) -> Bool {
  let inputs = build_mix_inputs_at_a(n)
  let outputs = build_mix_outputs_at_b(n)
  mix_logic.mix_logic.withdraw(
    ref_nft_policy,
    ref_nft_name,
    Mix { proofs: replicate_bogus_sigma_or(n, []) },
    script_address(mix_script_hash).payment_credential,
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs,
      outputs,
      fee: 200_000,
    },
  )
}

fn replicate_bogus_sigma_or(
  n: Int,
  acc: List<SigmaOrProof>,
) -> List<SigmaOrProof> {
  if n == 0 {
    acc
  } else {
    replicate_bogus_sigma_or(n - 1, [bogus_sigma_or(n), ..acc])
  }
}

test mix_full_prologue_then_proof_fails_n2() fail {
  run_mix_full_prologue(2)
}

test mix_full_prologue_then_proof_fails_n3() fail {
  run_mix_full_prologue(3)
}

test mix_full_prologue_then_proof_fails_n4() fail {
  run_mix_full_prologue(4)
}

test mix_full_prologue_then_proof_fails_n6() fail {
  run_mix_full_prologue(6)
}

test mix_full_prologue_then_proof_fails_n8() fail {
  run_mix_full_prologue(8)
}

// ---------------------------------------------------------------------------
// Benchmarks (audit I-01 / CWC-026): mix_logic is the dominant on-chain
// cost contributor — sigma-OR verify scales as ~2N² G1 ops per Mix tx
// (N invocations of `sigma_or.verify`, each with N statements + N
// branches), and Schnorr verify scales linearly in N for Owner.
//
// We bench the dominant per-input cost contributors directly with real
// KAT vectors rather than driving the validator entry points end-to-end:
// `aiken bench` does not record cost on aborting scripts, and the
// validator's per-tx `expect c_global == xor` check aborts unless the
// proofs were generated against the synthetic tx's exact ctx (which
// requires a TS-side `serialise_data(List<Output>)` shim that is still
// deferred — see the prelude comment on `run_mix_full_prologue` and the
// `*_kat` test suites for the same vectors as positive-path proxies at
// `aiken check` time).
//
// Per-tx interpretation: a real Mix tx at N runs `sigma_or.verify_pre`
// N times sharing pre-uncompressed statements; per-tx cost ≈ prologue +
// N × per-input cost. The component benches below give the per-input
// cost; the prologue is captured by `aiken check`'s reported
// mix_full_prologue_then_proof_fails_n* numbers (already in this file).
//
// nMAX is N=8 — the highest sigma-OR KAT vector available. The
// audit-suggested N=12 isn't currently feasible without regenerating
// the KAT set; document delta when it lands.
// ---------------------------------------------------------------------------

// Real Schnorr KAT: `schnorr_kat_0` from lib/lovejoin/schnorr_kat.test.ak.
// Generator point as both pk_a and pk_b; ctx is empty.
fn run_schnorr_kat_verify() -> Bool {
  schnorr.verify(
    #"97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb",
    #"97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb",
    SchnorrProof {
      t: #"917da63224a510b8adb32b4e843c645f6b47f4fa65353db36cf99089f467217046026a04f6c6583cb3aaed69c467edbf",
      z: #"0d0e1ba5de6e62ebd6328f5d9290484498103ea13620ba33c0f592d0cd787dbd",
    },
    #"",
  )
}

// `repeat_n_verifies` runs the verify K times and ANDs the results, so
// the bench body returns Bool and aiken bench can record cost. The
// constant work of looping over K elements is small relative to the
// per-iteration verify cost we're measuring.
fn repeat_schnorr_verify(k: Int, acc: Bool) -> Bool {
  if k == 0 {
    acc
  } else {
    repeat_schnorr_verify(k - 1, acc && run_schnorr_kat_verify())
  }
}

// Real sigma-OR KATs. n2 = `sigma_or_kat_n2_0`, n8 = `sigma_or_kat_n8_0`
// from lib/lovejoin/sigma_or_kat.test.ak. Inlined here so the bench
// doesn't depend on extracting `pub const`s out of the auto-generated
// KAT module.
fn run_sigma_or_n2_kat_verify() -> Bool {
  sigma_or.verify(
    #"8d42a79b300e3cfc5a708c76e6558639caecb40186166884e46a8831fadd93190400b95b9ed3ea36522905c07e89018b",
    #"967981fac78b02e787322bbe5c8265ae35bb149b4082d241aae4dccab70889f091c1fec866fb8d6932357603ab5c8eef",
    [
      DHTupleStatement {
        ap: #"97ee523d902c442288a6637e358a37eb382fd2bf517f912099a4648561fa5262d6581973375c0b0285c9423f426aa7f3",
        bp: #"8d554752f84951879e21ea17d8f4983037668641ad9732dd1f270222b03980bd31e15ef032be5ee30267ada3853c9b0e",
      },
      DHTupleStatement {
        ap: #"b831bdce184d5f4a04093e448b6bda3df1b3a657cdf2011ca96a5d5fd202c88af3e7f759f38c09539ff07117c0a34e27",
        bp: #"a9fa78d62ced4db606bff312ecc70d3b774316b5f49d82ecd404e0611f5ece955ecfd13d0335e387c474ff340ad41d11",
      },
    ],
    SigmaOrProof {
      branches: [
        SigmaOrBranch {
          t0: #"a1e16c303d3aa58bbc7328ebccc8688338e64638676433865d8974eae08a669858b8a256d3a6ba14dd31d8a8d0fd4c7a",
          t1: #"ab7b8c37bfef6feb9fa2d6522af46a6a97ad712da89c6709de2c8f73306dafb9d2fb2f34add4252636b0a238355b89d2",
          c: #"a5786dce1d56619647a7d510554c08b1bc5a0be344d0618906812655b5b30d64",
          z: #"014fdf5bb53b0789317dde0071dac5fc4bc2f09bfc276c9d735127cf020700b0",
        },
        SigmaOrBranch {
          t0: #"924a8d77971c51a7f4f2d7b53d91e40570ed41ac6a183ecfd0cac98c6a88f5995b3f62c09093b25400f1fb9158744bad",
          t1: #"851ef6884053d7c772d03a6021cc9b408d35596855a047743df18521c7c7379e45d03bab6040aceb50c0d5d077f0f848",
          c: #"f709e0a234ffac61c33d1304b13449681c3221ff3c9ecf33e46169493580cb52",
          z: #"5aba7abe3e0e02b919090a5159965144e4ff0d5280b750e97d009c2e5a08a34c",
        },
      ],
    },
    #"4f",
  )
}

fn run_sigma_or_n8_kat_verify() -> Bool {
  sigma_or.verify(
    #"9542cd2545228e48fdb9247340e93c9fdb0d127127263e3fd34466842a7c8b7265b686e5e69e36444c8440f2956c27c8",
    #"91ed07283b2796b51683d812547d917ebda2767a84247dd5ce75a4ac1a9aea8820e7d89af1d75f4d87e56ae3abd5bd4e",
    [
      DHTupleStatement {
        ap: #"8b1bc279fd323ea3c92ac05fe954baab6ec6016dc5bc9569cd1440b08cb5e21246c25784137bee2a93c2bc16c8c0cc70",
        bp: #"8db9a1ad6347a4b65144cb0eb8a7331836ac4da16353544d32d727923b295581a79ae31be5bc92892a1205d35ccf4480",
      },
      DHTupleStatement {
        ap: #"a03c92488b4178908c37418af3a94064b22a289741b9ef7f363d93344d1f23101f70ebca286a45de96bc3435a34eb4f6",
        bp: #"8b6d43b193495d876910fcd162b79cdbef6f9f450b4a9f0cbd73854e1bcebf7bdd18a1273d5b662a00678f0433d6feb1",
      },
      DHTupleStatement {
        ap: #"a54d6c3cfec61b7187c7176e290524fff46e06a608a8a168a97640fadbd1866e7f84a698447cf0ff0b20b13dcabadd06",
        bp: #"a4627b575204881bb70d438029734d6dcd4db3182eee5970abf8fc0a0cb04a4df6b5e6f99e50d7a789bf6151a18e82f2",
      },
      DHTupleStatement {
        ap: #"99df68823e11bd1e2e2b2feabf8000f13a378db1341af2476267130c91785289223f44e350013ed06f0bb333ef995eb8",
        bp: #"a2653210a776974923f81dcba51cf183f01e7f9bd59b89d950798d479aebc8eb25789913c5a06f88cebc4228c4be7f0e",
      },
      DHTupleStatement {
        ap: #"95dcc2c82562110c89ce686a0e14b0f38dd5d758dbd92c1c10cef0ba0aad7a6f1ac0677f9b04ad58523572f00d9b8392",
        bp: #"aa74c9f0031eb340a00566ec79ab0edd45d58504593d1412d0d0fbd3fcce8f16aa191586416a95a616afe899c45bf62c",
      },
      DHTupleStatement {
        ap: #"923aa558b01a113e18347ffe83f08666c7ed97712808e2e3cf252f42eb264097ea6053b6825143f5320b5d11265fcdba",
        bp: #"a22c1184112891a1aae092b678c8ad52e629d4a3d376fec80487206c07cb8595551ea3bfe6a9d5860580b6e7316b9a6f",
      },
      DHTupleStatement {
        ap: #"a4e72915dd84b443e0d1902dd13a27e80a3e446132ba7801b655aa3e40c3d974429322f120b1f101dce78d6681248fbc",
        bp: #"aa953eb3ebc05ebce56dc03e1455771598925b1b0c29ec2fcdf36b8955b34b40774152eb32e520af365dd4da4a691781",
      },
      DHTupleStatement {
        ap: #"b595bc8c58c88204840282f743e14ffe215af3eb4941ecbf426a96dc0099c86b1dda8af0322e499d9c06cd3d64b09fda",
        bp: #"8cd743f998db78bfc56956407e7b659c78df59d0bcf55786081c7581cf40ef6037aa24d2d7fc7733cddf17c7ebf977b2",
      },
    ],
    SigmaOrProof {
      branches: [
        SigmaOrBranch {
          t0: #"b04ab2839cfcd6a7df02342bfa70080c3b860b40e56b68f2d39cc14d2dcaa85562099978152e56de68b2cb521fa53b5b",
          t1: #"8234f7b3e0429ca09aab1ba2fcd07abf14b3f025cc4fb700753be32595e0a2325bd5298f527fa4c47e38782acad01433",
          c: #"55bb9da311c652f73aca3c32ee367ae4c05bacc7059ffc2c67f94d8df3676f5b",
          z: #"0fdbbddd83cb6b7a1b96b1a1a1d0fde4053be33356e2cf35d43ad2489cc7159b",
        },
        SigmaOrBranch {
          t0: #"ae7178f65ced2f30e04bf52284c1f789fa32d02898dbf6855a597af9b8e6d57821b68bad423c423a395e24179b84c11b",
          t1: #"b3c1f6c8fdd0c9286c1d53f9099d0e4019c5800308f13e60259bda21301c3f3c3f0e3c43aea2cdf41573930da6977d98",
          c: #"1ab894d6273980137faf5089fa29ca15153e7384fed6523c333d0f52cabdd31e",
          z: #"2f34b95f914b26acece302a412c92510ac3a6d73f8254202fa37b3c340063c3c",
        },
        SigmaOrBranch {
          t0: #"8f69da57c85270795842c2b18e6ef5ae69e29dea57768a62ba1fbafdd5862812414aa59eb4c984f3b407b1a6d022914a",
          t1: #"a589ee8a16b9e57a679b326234e34712cc000f344e9d13cb8b77425939254e059710a4bbe484d881b277fad44dcc702f",
          c: #"5235d7ff88e598da3851810f4d98d929bf949afb4c65eef69e0ac2cd128eeeae",
          z: #"16795458e213a9d34b54fe282c884bcedc03bf8998ef78187c62c3ad181687b7",
        },
        SigmaOrBranch {
          t0: #"976974f124ee90f3a2d916606582ab65acc8f9ff2bdde3f2fd6514631fa59e761ba463b98d50ddc2f4ab317018e5e982",
          t1: #"a5341cf7393aa23d35d5b2dcc3645fe0e1776b17a3864bea9f61c8f79c3640eb491d60fde899c1e93d1948708f1ec1d0",
          c: #"d27f7586cebc26cc2405b1b548ee8406117ed4ddbccb158d4c55c6d34fb7069a",
          z: #"4f7af69a23754dc4577c46feeac2901a55163d07f58ae31cf6e915bea4a9ea0c",
        },
        SigmaOrBranch {
          t0: #"9567533a4459817e89a2c0f53f2fc6029076a64260a74309a9ac01a084ba5a1550de3c8f7662bc313e0448ff473029a9",
          t1: #"b1534107966009bbe9df62651dba3c5590a60dbf29c8baf6da6319119966599aa81d42d6eea31a6d53f75b860856e226",
          c: #"d101b217f692c8f7817cfc1f595cff4c294f39359032c5f1a047ef55bef7b2f5",
          z: #"52437a06cd547a5498aadd013ab25232be2196c18a98339708ef1dc8ae0b95e0",
        },
        SigmaOrBranch {
          t0: #"914465967b34ceaf1c00e2a3bd12b7c4b726a3c84b2643cb49199cc1caaa0963a985b0ce2416e00b70868c75bb9d6f69",
          t1: #"acdbaa3d80271fa7d7565ce273831b9a51f1958e8532e1452e8db95a136e2e0f5f52f772b14c01d13978336e7a3b4501",
          c: #"5a0a2231d0ce114da371ab814ad15f37dfdae6d77f1d52d8182204a4433171df",
          z: #"099be8ecce8e3459f10b82e9b6eddba0751292dc9882c166d0d2aded0ce4a89f",
        },
        SigmaOrBranch {
          t0: #"add3ba1e03ac61a6777be94deb34103683a6af0751bf506b1fafd114abc6972aff4b3e0c2027863731abc89f5404687c",
          t1: #"a94ebc05e04fba7414c1403894c728a76d7f6cb7e48d1cc6c2f117147bc1270f956d51fcf658fbccf5420f717fec73ff",
          c: #"1ed90445d99c33e40835c826ed62c6885c0d8ea5d67447528d1760a0425d1754",
          z: #"1835202f33bfcb74d8230883bd5e861af1753f4e1f165efb1e40772071add9ef",
        },
        SigmaOrBranch {
          t0: #"88900e77cdfabf42941b85f68d80d7061345ee3c5e7f57ec6cd2733e87798ecfa3784db9b8d1ab4674dd5c7e2b756d8a",
          t1: #"b123c4f1a6843ae1c443d7b9c7cc9b92dd9ca00e00a6a796cd864076f5c57a57dde1f96f6d854a99e6e61540fa059334",
          c: #"fdff211f307d9f4e783a46863c396ae98653a334a94e0d68d271d87221b245aa",
          z: #"5c1eac5965bf30554babdaee58f62c9bd23eac383b8c33abdc02eb0c2c224384",
        },
      ],
    },
    #"",
  )
}

fn const_unit(_size: Int) -> Fuzzer<Int> {
  fuzz.constant(0)
}

bench mix_logic__owner__n1_realistic_inputs(_n: Int via const_unit) {
  // Per-input Schnorr verify (real KAT). The Owner branch runs this
  // helper once per input; per-tx cost ≈ N × this number + ctx-hash
  // and prologue overhead.
  run_schnorr_kat_verify()
}

bench mix_logic__owner__n8_bulk_withdraw_realistic(_n: Int via const_unit) {
  // 8 sequential per-input Schnorr verifies — proxy for an N=8 Owner
  // bulk withdraw. The validator amortises ctx hashing across the 8
  // inputs so the on-chain cost is 8 × per_input + small ctx; this
  // bench captures the 8 × per_input dominant term.
  repeat_schnorr_verify(8, True)
}

bench mix_logic__owner__nMAX_high_N(_n: Int via const_unit) {
  // 12 sequential per-input Schnorr verifies. Above today's empirical
  // Plutus ceiling; the bench number tells us how much headroom an
  // optimization pass would need to reach N=12.
  repeat_schnorr_verify(12, True)
}

bench mix_logic__mix__n2_realistic_inputs(_n: Int via const_unit) {
  // Per-input sigma-OR verify at N=2 (real KAT). The Mix-branch
  // validator runs this 2× per Mix tx (one per input, sharing
  // pre-uncompressed statements); per-tx cost ≈ 2 × this + ctx hash
  // + statement uncompression.
  run_sigma_or_n2_kat_verify()
}

bench mix_logic__mix__n8_realistic(_n: Int via const_unit) {
  // Per-input sigma-OR verify at N=8 (real KAT). The N² scaling is in
  // the per-input cost: each verify uncompresses N branch points and
  // recomputes a fold over N statements + N branches, so the per-tx
  // total is N × (N²-flavored work).
  run_sigma_or_n8_kat_verify()
}

bench mix_logic__mix__nMAX_high_N(_n: Int via const_unit) {
  // Same N=8 KAT — the highest sigma-OR KAT vector currently
  // generated. Audit-suggested N=12 awaits a regenerated KAT set.
  run_sigma_or_n8_kat_verify()
}

const register_credential_cert: Certificate =
  RegisterCredential { credential: Script(mix_logic_hash), deposit: Never }

fn const_register_cert(_size: Int) -> Fuzzer<Certificate> {
  fuzz.constant(register_credential_cert)
}

bench mix_logic__publish__register_credential(
  cert: Certificate via const_register_cert,
) {
  // One-time stake-credential registration. Cold path, runs once per
  // network deployment. Anchors a publish-handler floor.
  mix_logic.mix_logic.publish(
    ref_nft_policy,
    ref_nft_name,
    Void,
    cert,
    transaction.placeholder,
  )
}
