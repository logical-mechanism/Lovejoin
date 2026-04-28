//// `mix_logic` — withdraw-zero validator. Runs once per Mix or Owner tx;
//// carries the real per-input proof verification.
////
//// Spec: docs/spec/03-contracts.md §0 (rules), §2 (Owner branch, Mix branch
////   — variable N).
//// Crypto: docs/spec/02-cryptography.md §"Hash function and Fiat-Shamir
////   context binding" for `ctx`, and §"N-way Sigma-OR" for the OR-proof
////   verifier.
////
//// Hyperstructure quirk (Rule 2 application at the withdrawal layer):
//// We filter `tx.inputs` down to mix-script inputs whose datums decode as
//// well-formed `MixDatum`. Inputs with bad/missing datums at the same script
//// address are silently dropped — those exit via `mix_box`'s True path
//// independently. The Mix / Owner rules below are applied only to the
//// well-formed subset.
////
//// Inputs are already lexicographically sorted by `(txid, output_index)` per
//// ledger semantics, and `list.filter_map` preserves that order. The Mix
//// redeemer's `proofs[i]` is therefore the proof for the i-th sorted
//// well-formed mix input.

use aiken/builtin
use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{Credential}
use cardano/assets.{AssetName, PolicyId}
use cardano/certificate.{Certificate, RegisterCredential}
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use lovejoin/mixbox.{
  input_at_script, output_at_script, try_decode_well_formed_inline,
}
use lovejoin/reference.{read_reference_datum}
use lovejoin/schnorr
use lovejoin/sigma_or.{DHTupleStatement, DHTupleStatementPt, SigmaOrProof}
use lovejoin/types.{Mix, MixDatum, MixLogicRedeemer, Owner, ReferenceDatum}
use lovejoin/value.{ada_only}

// Flat params — one CBOR atom per `aiken blueprint apply` call.
validator mix_logic(
  reference_nft_policy: PolicyId,
  reference_nft_name: AssetName,
) {
  withdraw(redeemer: MixLogicRedeemer, _account: Credential, self: Transaction) {
    let reference_datum =
      read_reference_datum(self, reference_nft_policy, reference_nft_name)
    let mix_inputs =
      collect_well_formed_mix_inputs(self, reference_datum.mix_script_hash)

    when redeemer is {
      Owner { proof } ->
        validate_owner(self, reference_datum, mix_inputs, proof)
      Mix { proofs } -> validate_mix(self, reference_datum, mix_inputs, proofs)
    }
  }

  // The stake-credential registration cert in stage 1 fires `mix_logic` with
  // purpose=Publish. We allow ONLY the one-time RegisterCredential and reject
  // every other publish op — particularly UnregisterCredential, which would
  // brick the protocol. Delegation, redelegation, and governance certs are
  // rejected by the same default: "the credential exists, is registered, and
  // nothing else can ever happen to it."
  publish(_redeemer: Data, certificate: Certificate, _self: Transaction) {
    when certificate is {
      RegisterCredential { .. } -> True
      _ -> False
    }
  }

  else(_) {
    fail
  }
}

// ---------------------------------------------------------------------------
// Owner branch — exactly one well-formed mix input, Schnorr proof against
// (a, b) bound to the tx's full output set.
// ---------------------------------------------------------------------------

fn validate_owner(
  self: Transaction,
  reference_datum: ReferenceDatum,
  mix_inputs: List<MixDatum>,
  proof: schnorr.SchnorrProof,
) -> Bool {
  expect [mix_input] = mix_inputs

  // ctx = blake2b_256( serialise(self.outputs) || mix_script_hash )
  let outputs_bytes = builtin.serialise_data(self.outputs)
  let ctx_preimage =
    outputs_bytes |> bytearray.concat(reference_datum.mix_script_hash)
  let ctx = builtin.blake2b_256(ctx_preimage)

  // Owner: prover knows x with b = [x] a → Schnorr with base = a, u = b.
  schnorr.verify(mix_input.a, mix_input.b, proof, ctx)
}

// ---------------------------------------------------------------------------
// Mix branch — variable N (≥ 2). No upper bound on N: the natural ceiling is
// the chain's per-tx CPU/mem budget. The validator only enforces N >= 2 and
// the structural rules below.
// ---------------------------------------------------------------------------

fn validate_mix(
  self: Transaction,
  reference_datum: ReferenceDatum,
  mix_inputs: List<MixDatum>,
  proofs: List<SigmaOrProof>,
) -> Bool {
  let n = list.length(mix_inputs)
  expect n >= 2
  expect list.length(proofs) == n

  // The N mix outputs MUST occupy positions 0..N-1; later positions (the fee
  // shard, change, etc.) must NOT be at the mix script.
  let prefix_outputs = list.take(self.outputs, n)
  let tail_outputs = list.drop(self.outputs, n)
  expect
    list.all(
      prefix_outputs,
      fn(output) { output_at_script(output, reference_datum.mix_script_hash) },
    )
  expect
    list.all(
      tail_outputs,
      fn(output) { !output_at_script(output, reference_datum.mix_script_hash) },
    )

  // Per-output well-formedness (denom, no native assets, valid MixDatum).
  let mix_output_data: List<MixDatum> =
    list.map(
      prefix_outputs,
      fn(output) { check_and_decode_mix_output(output, reference_datum) },
    )

  // ctx = blake2b_256( serialise(out_0.datum) || ... || serialise(out_{N-1}.datum)
  //                 || serialise(out_0.value) || ... || serialise(out_{N-1}.value)
  //                 || mix_script_hash )
  let ctx = compute_mix_ctx(prefix_outputs, reference_datum.mix_script_hash)

  // Build the OR-statement vector once: every input's OR-proof is over the
  // SAME N output (a', b') pairs. Pre-uncompress each output (a', b')
  // here — without this, each of the N `sigma_or.verify_pre` calls would
  // re-uncompress every statement point (= N² uncompresses per tx). This
  // is the dominant CPU-budget optimisation; bringing N² down to N
  // uncompresses for statements is what lets `max_n` climb past 3.
  let statements: List<DHTupleStatementPt> =
    sigma_or.precompute_statements(
      list.map(
        mix_output_data,
        fn(mix_output) {
          DHTupleStatement { ap: mix_output.a, bp: mix_output.b }
        },
      ),
    )

  // Per-input OR-proof verification. `proofs[i]` proves "input i's witness
  // re-randomized to one of the N outputs" — see
  // docs/spec/02-cryptography.md §"N-way Sigma-OR". `n` is threaded through
  // so `verify_pre` doesn't re-measure `list.length(statements)` per call.
  pairs_match_and_all(
    mix_inputs,
    proofs,
    fn(mix_input, proof) {
      sigma_or.verify_pre(mix_input.a, mix_input.b, statements, proof, ctx, n)
    },
  )
}

fn check_and_decode_mix_output(
  output: Output,
  reference_datum: ReferenceDatum,
) -> MixDatum {
  expect ada_only(output.value)
  expect assets.lovelace_of(output.value) == reference_datum.denom_lovelace
  expect Some(mix_datum) = try_decode_well_formed_inline(output.datum)
  mix_datum
}

fn compute_mix_ctx(
  outputs: List<Output>,
  mix_script_hash: ByteArray,
) -> ByteArray {
  let datums_bytes =
    list.foldl(
      outputs,
      #"",
      fn(output, acc) {
        when output.datum is {
          InlineDatum(inline_data) ->
            bytearray.concat(acc, builtin.serialise_data(inline_data))
          _ -> acc
        }
      },
    )
  let values_bytes =
    list.foldl(
      outputs,
      #"",
      fn(output, acc) {
        bytearray.concat(acc, builtin.serialise_data(output.value))
      },
    )
  let preimage =
    datums_bytes
      |> bytearray.concat(values_bytes)
      |> bytearray.concat(mix_script_hash)
  builtin.blake2b_256(preimage)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Filter `tx.inputs` to mix-script inputs with well-formed datums, preserving
/// the ledger's lexicographic input order. Bad-datum inputs at the same script
/// address are silently dropped (Rule 2 — they exit via `mix_box`'s True path).
fn collect_well_formed_mix_inputs(
  self: Transaction,
  mix_script_hash: ByteArray,
) -> List<MixDatum> {
  list.filter_map(
    self.inputs,
    fn(input) {
      if input_at_script(input, mix_script_hash) {
        try_decode_well_formed_inline(input.output.datum)
      } else {
        None
      }
    },
  )
}

/// Apply `pred` pairwise to two equal-length lists; True iff every pair
/// passes. Length equality is pre-asserted by the caller. Stdlib has
/// `list.zip` + `list.all` but the explicit recursion avoids allocating an
/// intermediate list of pairs in the validator.
fn pairs_match_and_all(
  xs: List<MixDatum>,
  ys: List<SigmaOrProof>,
  pred: fn(MixDatum, SigmaOrProof) -> Bool,
) -> Bool {
  when (xs, ys) is {
    ([], []) -> True
    ([x, ..xs_tail], [y, ..ys_tail]) ->
      if pred(x, y) {
        pairs_match_and_all(xs_tail, ys_tail, pred)
      } else {
        False
      }
    _ -> False
  }
}
