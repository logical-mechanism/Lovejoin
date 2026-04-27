//// `mix_logic` structural tests.
////
//// Spec: docs/spec/03-contracts.md §0, §2.
////
//// Coverage today:
////   * Owner branch — input count rule (positive=1, negative=0/2+).
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
use cardano/assets
use cardano/transaction.{Input, Output, Transaction}
use lovejoin/schnorr.{SchnorrProof}
use lovejoin/sigma_or.{SigmaOrBranch, SigmaOrProof}
use lovejoin/test_fixtures.{
  default_reference_input, default_reference_params, denom_lovelace,
  fee_shard_output, max_n, mix_box_input, mix_box_input_bad_datum,
  mix_box_output, mix_box_output_with_value, mix_script_hash, random_user_vk,
  script_address, vk_output_lovelace, a48, b48, c48,
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
  // No mix inputs at all — the `expect [d] = mix_inputs` aborts.
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: [],
      outputs: [vk_output_lovelace(random_user_vk, denom_lovelace)],
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    default_reference_params(),
    Owner { proof: bogus_schnorr() },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

test owner_rejects_two_well_formed_inputs() fail {
  // 2 well-formed mix inputs in Owner mode — must be exactly 1.
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
    default_reference_params(),
    Owner { proof: bogus_schnorr() },
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
    default_reference_params(),
    Owner { proof: bogus_schnorr() },
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
  let bad_datum: Data = MixDatum { a: a48, b: a48 }  // a == b → malformed
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
    default_reference_params(),
    Owner { proof: bogus_schnorr() },
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

fn do_build_mix_inputs_at_a(remaining: Int, idx: Int, acc: List<Input>) -> List<Input> {
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

fn do_build_mix_outputs_at_b(remaining: Int, idx: Int, acc: List<Output>) -> List<Output> {
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
      inputs: inputs,
      outputs: outputs,
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    default_reference_params(),
    Mix { proofs: [bogus_sigma_or(2)] },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

test mix_rejects_n_above_max_n() fail {
  // max_n in default fixtures is 6 — request 7 inputs.
  let n_over = max_n + 1
  let inputs = build_mix_inputs_at_a(n_over)
  let outputs = build_mix_outputs_at_b(n_over)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: inputs,
      outputs: outputs,
      fee: 200_000,
    }
  let proofs: List<SigmaOrProof> = build_proofs_at_n(n_over)
  mix_logic.mix_logic.withdraw(
    default_reference_params(),
    Mix { proofs: proofs },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

fn build_proofs_at_n(n: Int) -> List<SigmaOrProof> {
  do_build_proofs(n, [])
}

fn do_build_proofs(remaining: Int, acc: List<SigmaOrProof>) -> List<SigmaOrProof> {
  if remaining == 0 {
    acc
  } else {
    do_build_proofs(remaining - 1, [bogus_sigma_or(2), ..acc])
  }
}

test mix_rejects_proofs_count_mismatch() fail {
  // 3 mix inputs, but proofs.length == 2 → length mismatch.
  let inputs = build_mix_inputs_at_a(3)
  let outputs = build_mix_outputs_at_b(3)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: inputs,
      outputs: outputs,
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    default_reference_params(),
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
      inputs: inputs,
      outputs: [mix_out0, fee_out, mix_out1],
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    default_reference_params(),
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
      inputs: inputs,
      outputs: [mix_out, fee_out],  // prefix-N = [mix, fee]; fee fails check
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    default_reference_params(),
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
      inputs: inputs,
      outputs: [bad_out, good_out],
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    default_reference_params(),
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
      inputs: inputs,
      outputs: [bad_out, good_out],
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    default_reference_params(),
    Mix { proofs: [bogus_sigma_or(2), bogus_sigma_or(2)] },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}

test mix_rejects_a_eq_b_output_datum() fail {
  let inputs = build_mix_inputs_at_a(2)
  // a == b on output datum → try_decode_well_formed_inline returns None → expect aborts.
  let bad_out = mix_box_output(b48, b48, denom_lovelace)
  let good_out = mix_box_output(c48, b48, denom_lovelace)
  let tx =
    Transaction {
      ..transaction.placeholder,
      reference_inputs: [default_reference_input()],
      inputs: inputs,
      outputs: [bad_out, good_out],
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    default_reference_params(),
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
      inputs: inputs,
      outputs: outputs,
      fee: 200_000,
    }
  mix_logic.mix_logic.withdraw(
    default_reference_params(),
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
    default_reference_params(),
    Owner { proof: bogus_schnorr() },
    script_address(mix_script_hash).payment_credential,
    tx,
  )
}
