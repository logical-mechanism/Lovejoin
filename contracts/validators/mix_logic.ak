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
use lovejoin/hash as hash_mod
use lovejoin/mixbox.{
  decode_mix_datum_strict, input_at_script, output_at_script,
  try_decode_well_formed_inline,
}
use lovejoin/reference.{read_reference_datum}
use lovejoin/schnorr
use lovejoin/sigma_or.{DHTupleStatementPt, SigmaOrProof}
use lovejoin/types.{Mix, MixDatum, MixLogicRedeemer, Owner, ReferenceDatum}
use lovejoin/value.{expect_ada_only_lovelace}

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
// Every proof binds to the same `ctx` (the tx's full output set + every
// input's `output_reference` + mix script hash), so output substitution OR
// input substitution invalidates every proof at once. Each proof is checked
// against the (a_i, b_i) of its corresponding input — proofs cannot be
// swapped between inputs because each Schnorr is bound to a specific (a, b).
//
// Audit F-4: hashing only `self.outputs` is insufficient when two distinct
// mix-boxes share the same `(a, b)` (which the standard SDK's per-deposit
// HKDF index avoids, but a non-conforming depositor could induce). An
// attacker observing the owner's withdraw of box 1 with proof π could
// rebuild the same outputs against box 2 and reuse π verbatim, redirecting
// box 2's denom to themselves. Mixing input refs into the ctx pins the
// proof to a specific input set; Cardano's UTxO model already prevents
// rebuilding a tx with an identical input set (those UTxOs are consumed
// once). Mirrors the Mix branch's "one ctx, N proofs share it" pattern.
//
// Bulk withdraw safety:
//   * `ctx` covers `self.outputs` AND `self.inputs[].output_reference` so
//     the destination(s), amounts, and the input set are all committed; an
//     attacker who reuses N-1 of the user's proofs in a different tx must
//     produce identical outputs AND an identical input set (the Nth input
//     would need a forged proof for its (a, b)). Conservation of value plus
//     UTxO uniqueness block any partial-input replay.
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

  // ctx = blake2b_256(
  //   serialise(self.outputs)
  //     || serialise(self.inputs[].output_reference)
  //     || mix_script_hash
  // )
  let outputs_bytes = builtin.serialise_data(self.outputs)
  let input_refs_bytes =
    builtin.serialise_data(
      self.inputs |> list.map(fn(i) { i.output_reference }),
    )
  let ctx_preimage =
    outputs_bytes
      |> bytearray.concat(input_refs_bytes)
      |> bytearray.concat(reference_datum.mix_script_hash)
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

  // Single-walk validate_mix prologue. Subsumes ALL prior traversals:
  //   * list.take(self.outputs, n) — N walks + N-cell allocation.
  //   * list.drop(self.outputs, n) — N walks past the prefix.
  //   * list.all on prefix (`output_at_script`) — N walks.
  //   * list.all on tail (`!output_at_script`) — T walks.
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
  //
  // Every prefix output is forced ada-only at exactly `denom_lovelace`,
  // so `serialise_data(output.value)` produces byte-identical output for
  // all N. We compute the cached denom-value bytes once and reuse them in
  // the values fold — saves N-1 `serialise_data` calls per Mix tx.
  // Byte-equivalence between `assets.from_lovelace(denom)` and a real
  // Value at that lovelace amount is pinned by `value_serialise_parity.test.ak`.
  let denom_value_bytes =
    builtin.serialise_data(assets.from_lovelace(reference_datum.denom_lovelace))
  let (statements_rev, datums_bytes, values_bytes) =
    walk_outputs(
      self.outputs,
      n,
      reference_datum,
      denom_value_bytes,
      [],
      #"",
      #"",
    )
  let statements = list.reverse(statements_rev)

  let ctx =
    builtin.blake2b_256(
      datums_bytes
        |> bytearray.concat(values_bytes)
        |> bytearray.concat(reference_datum.mix_script_hash),
    )

  // Per-input OR-proof verification. `proofs[i]` proves "input i's witness
  // re-randomized to one of the N outputs" — see
  // docs/spec/02-cryptography.md §"N-way Sigma-OR". `header_const_prefix`
  // (= DOMAIN || 0x03 || N(1 byte)) is computed once and shared across all
  // N inputs; only the per-input (a, b) gets appended in `verify_pre`.
  // Saves N `from_int_big_endian` + 2N concats per Mix tx.
  expect n <= 255
  let header_const_prefix = hash_mod.fs_hash_sigma_or_header_const_prefix(n)
  pairs_match_and_all(
    mix_inputs,
    proofs,
    fn(mix_input, proof) {
      sigma_or.verify_pre(
        mix_input.a,
        mix_input.b,
        statements,
        proof,
        ctx,
        header_const_prefix,
      )
    },
  )
}

/// Walk `self.outputs` once; for the first N elements (the mix-output
/// prefix):
///   * assert `output_at_script(output, mix_script_hash)`,
///   * assert ada-only + canonical denom (one dict walk),
///   * decode the inline `MixDatum`,
///   * uncompress (a', b') into a `DHTupleStatementPt`,
///   * accumulate `serialise_data(output.datum)` and the cached
///     `denom_value_bytes` into the FS-preimage byte strings.
/// For the remaining (tail) elements:
///   * assert `!output_at_script(output, mix_script_hash)`.
/// At end-of-list, assert we consumed exactly N prefix elements (i.e. that
/// `self.outputs` had at least N entries — `prefix_remaining == 0`).
///
/// Statements are accumulated in REVERSE order (cheap cons); the caller
/// `list.reverse`s once.
///
/// `denom_value_bytes` is `serialise_data(assets.from_lovelace(denom))`
/// computed once in `validate_mix`. Every prefix output is forced ada-only
/// at exactly `denom_lovelace`, so its serialised value bytes are identical
/// across all N — no need to call `serialise_data(output.value)` per step.
///
/// Tuple return rather than a record — Aiken compiles tuples with less
/// per-step overhead than a 3-field record literal in this hot path.
fn walk_outputs(
  outputs: List<Output>,
  prefix_remaining: Int,
  reference_datum: ReferenceDatum,
  denom_value_bytes: ByteArray,
  stmts_rev: List<DHTupleStatementPt>,
  datums_acc: ByteArray,
  values_acc: ByteArray,
) -> (List<DHTupleStatementPt>, ByteArray, ByteArray) {
  when outputs is {
    [] -> {
      // self.outputs must have had at least N elements (the prefix).
      expect prefix_remaining == 0
      (stmts_rev, datums_acc, values_acc)
    }
    [output, ..rest] ->
      if prefix_remaining > 0 {
        // Prefix step: at_script + decode + accumulate.
        expect output_at_script(output, reference_datum.mix_script_hash)
        expect
          expect_ada_only_lovelace(output.value) == reference_datum.denom_lovelace
        expect InlineDatum(inline_data) = output.datum
        let mix_datum = decode_mix_datum_strict(inline_data)
        let stmt =
          DHTupleStatementPt {
            ap: mix_datum.a,
            bp: mix_datum.b,
            ap_pt: bls.point_from_bytes(mix_datum.a),
            bp_pt: bls.point_from_bytes(mix_datum.b),
          }
        walk_outputs(
          rest,
          prefix_remaining - 1,
          reference_datum,
          denom_value_bytes,
          [stmt, ..stmts_rev],
          datums_acc |> bytearray.concat(builtin.serialise_data(inline_data)),
          values_acc |> bytearray.concat(denom_value_bytes),
        )
      } else {
        // Tail step: must NOT be at the mix script.
        expect !output_at_script(output, reference_datum.mix_script_hash)
        walk_outputs(
          rest,
          0,
          reference_datum,
          denom_value_bytes,
          stmts_rev,
          datums_acc,
          values_acc,
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
