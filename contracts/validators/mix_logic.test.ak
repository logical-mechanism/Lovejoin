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
use cardano/address.{Script}
use cardano/assets
use cardano/certificate.{
  AlwaysAbstain, AuthorizeConstitutionalCommitteeProxy, DelegateBlockProduction,
  DelegateBoth, DelegateCredential, DelegateVote, RegisterAndDelegateCredential,
  RegisterCredential, RegisterDelegateRepresentative, RegisterStakePool,
  Registered, RetireFromConstitutionalCommittee, RetireStakePool,
  UnregisterCredential, UnregisterDelegateRepresentative,
  UpdateDelegateRepresentative,
}
use cardano/transaction.{Input, Output, Transaction}
use lovejoin/schnorr.{SchnorrProof}
use lovejoin/sigma_or.{SigmaOrBranch, SigmaOrProof}
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
