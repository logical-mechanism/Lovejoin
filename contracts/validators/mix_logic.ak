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
use lovejoin/bls
use lovejoin/mixbox.{
  input_at_script, output_at_script, try_decode_well_formed_data,
  try_decode_well_formed_inline,
}
use lovejoin/reference.{read_reference_datum}
use lovejoin/schnorr
use lovejoin/sigma_or.{DHTupleStatementPt, SigmaOrProof}
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
      Owner { proofs } ->
        validate_owner(self, reference_datum, mix_inputs, proofs)
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
// Owner branch — N ≥ 1 well-formed mix inputs and N matching Schnorr proofs.
// Every proof binds to the same `ctx` (the tx's full output set + mix script
// hash), so output substitution invalidates every proof at once. Each proof
// is checked against the (a_i, b_i) of its corresponding input — proofs
// cannot be swapped between inputs because each Schnorr is bound to a
// specific (a, b).
//
// Bulk withdraw safety:
//   * `ctx` covers `self.outputs` so the destination(s) and amounts are
//     committed; an attacker who reuses N-1 of the user's proofs in a
//     different tx must produce identical outputs AND identical inputs (the
//     Nth input would need a forged proof for its (a, b)). Conservation of
//     value blocks any partial-input replay.
//   * No collateral input check — same as the single-input path. The owner's
//     wallet supplies collateral and signs the tx envelope.
// ---------------------------------------------------------------------------

fn validate_owner(
  self: Transaction,
  reference_datum: ReferenceDatum,
  mix_inputs: List<MixDatum>,
  proofs: List<schnorr.SchnorrProof>,
) -> Bool {
  let n = list.length(mix_inputs)
  expect n >= 1
  expect list.length(proofs) == n

  // ctx = blake2b_256( serialise(self.outputs) || mix_script_hash )
  let outputs_bytes = builtin.serialise_data(self.outputs)
  let ctx_preimage =
    outputs_bytes |> bytearray.concat(reference_datum.mix_script_hash)
  let ctx = builtin.blake2b_256(ctx_preimage)

  // Per-input Schnorr verification. Each proof proves "I know x_i such that
  // b_i = [x_i] a_i" against the shared ctx — see docs/spec/02-cryptography.md
  // §"Schnorr".
  pairs_match_and_all(
    mix_inputs,
    proofs,
    fn(mix_input, proof) {
      schnorr.verify(mix_input.a, mix_input.b, proof, ctx)
    },
  )
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

  // Cheap structural pre-checks first — the N mix outputs MUST occupy
  // positions 0..N-1; later positions (fee shard, change, etc.) must NOT
  // be at the mix script. Keeping these as `list.all` walks lets a
  // wrong-at_script position fail fast without paying for the per-output
  // decode + uncompress + serialise work below.
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

  // Single tail-recursive walk over the prefix that subsumes FOUR previous
  // traversals (and four intermediate N-element list allocations):
  //   * `list.map(check_and_decode_mix_output)` — datum decode + ada_only
  //     + denom check.
  //   * `compute_mix_ctx` datums fold — `serialise_data(output.datum)`.
  //   * `compute_mix_ctx` values fold — `serialise_data(output.value)`.
  //   * `sigma_or.precompute_statements` — uncompress (a', b') into G1.
  // Wire layout of the FS preimage is byte-identical to the old
  // `compute_mix_ctx` (datum bytes 0..N-1 then value bytes 0..N-1 then
  // mix_script_hash). The existing positive-prologue tests at N ∈
  // {2,3,4,6,8} (mix_logic.test.ak `mix_full_prologue_then_proof_fails_n*`)
  // exercise this whole region against the same byte-equal ctx that
  // `verify_pre` re-derives from `proof.branches`.
  let (statements_rev, datums_bytes, values_bytes) =
    decode_prefix_into_statements_and_ctx_bytes(prefix_outputs, reference_datum)
  let statements = list.reverse(statements_rev)

  let ctx =
    builtin.blake2b_256(
      datums_bytes
        |> bytearray.concat(values_bytes)
        |> bytearray.concat(reference_datum.mix_script_hash),
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

/// Walk the N prefix outputs once; for each:
///   * validate ada-only + canonical denom,
///   * decode the inline `MixDatum`,
///   * uncompress (a', b') into a `DHTupleStatementPt`,
///   * accumulate `serialise_data(output.datum)` and
///     `serialise_data(output.value)` into the FS-preimage byte strings.
///
/// `output_at_script` was already verified by the caller's `list.all`, so we
/// pattern-match the inline data directly without re-checking the script
/// credential. Statements are accumulated in REVERSE order (cheap cons);
/// the caller `list.reverse`s once.
///
/// Tuple return rather than a record — Aiken compiles tuples with less
/// per-step overhead than a 3-field record literal in this hot path.
fn decode_prefix_into_statements_and_ctx_bytes(
  outputs: List<Output>,
  reference_datum: ReferenceDatum,
) -> (List<DHTupleStatementPt>, ByteArray, ByteArray) {
  do_decode_prefix(outputs, reference_datum, [], #"", #"")
}

fn do_decode_prefix(
  outputs: List<Output>,
  reference_datum: ReferenceDatum,
  stmts_rev: List<DHTupleStatementPt>,
  datums_acc: ByteArray,
  values_acc: ByteArray,
) -> (List<DHTupleStatementPt>, ByteArray, ByteArray) {
  when outputs is {
    [] -> (stmts_rev, datums_acc, values_acc)
    [output, ..rest] -> {
      expect ada_only(output.value)
      expect assets.lovelace_of(output.value) == reference_datum.denom_lovelace
      expect InlineDatum(inline_data) = output.datum
      expect Some(mix_datum) = try_decode_well_formed_data(inline_data)
      let stmt =
        DHTupleStatementPt {
          ap: mix_datum.a,
          bp: mix_datum.b,
          ap_pt: bls.point_from_bytes(mix_datum.a),
          bp_pt: bls.point_from_bytes(mix_datum.b),
        }
      do_decode_prefix(
        rest,
        reference_datum,
        [stmt, ..stmts_rev],
        datums_acc |> bytearray.concat(builtin.serialise_data(inline_data)),
        values_acc |> bytearray.concat(builtin.serialise_data(output.value)),
      )
    }
  }
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
/// intermediate list of pairs in the validator. Generic so the helper is
/// shared between `validate_mix` (MixDatum × SigmaOrProof) and
/// `validate_owner` (MixDatum × SchnorrProof).
fn pairs_match_and_all(xs: List<a>, ys: List<b>, pred: fn(a, b) -> Bool) -> Bool {
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
