//// `mix_logic` — withdraw-zero validator. Runs once per Mix or Owner tx; carries the
//// real per-input proof verification.
////
//// Spec: docs/spec/03-contracts.md §0 (rules), §2 (Owner branch, Mix branch — variable N).
//// Crypto: docs/spec/02-cryptography.md §"Hash function and Fiat-Shamir context binding"
//// for `ctx`, and §"N-way Sigma-OR" for the OR-proof verifier.
////
//// Hyperstructure quirk (Rule 2 application at the withdrawal layer):
//// We filter `tx.inputs` down to inputs at `mix_script_hash` whose datums decode as
//// well-formed `MixDatum`. Inputs with bad/missing datums at the same script address
//// are *ignored* — those go through `mix_box`'s True path independently. The Mix /
//// Owner rules below are then applied only to the well-formed subset.
////
//// Inputs are already lexicographically sorted by `(txid, output_index)` per ledger
//// semantics, and `list.filter_map` preserves that order. The Mix redeemer's
//// `proofs[i]` is therefore the proof for the i-th sorted *well-formed* mix input.

use aiken/builtin
use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{Credential}
use cardano/assets
use cardano/certificate.{Certificate, RegisterCredential}
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use lovejoin/mixbox.{
  output_at_script, try_decode_well_formed_inline,
}
use cardano/assets.{AssetName, PolicyId}
use lovejoin/reference.{read_reference_datum}
use lovejoin/schnorr
use lovejoin/sigma_or.{DHTupleStatement, SigmaOrProof}
use lovejoin/types.{MixDatum, Mix, MixLogicRedeemer, Owner, ReferenceDatum}

// Flat params (PolicyId, AssetName of the protocol's reference NFT) — one
// CBOR atom per `aiken blueprint apply` call.
validator mix_logic(reference_nft_policy: PolicyId, reference_nft_name: AssetName) {
  withdraw(redeemer: MixLogicRedeemer, _account: Credential, self: Transaction) {
    let datum = read_reference_datum(self, reference_nft_policy, reference_nft_name)
    let mix_inputs = collect_well_formed_mix_inputs(self, datum.mix_script_hash)

    when redeemer is {
      Owner { proof } -> validate_owner(self, datum, mix_inputs, proof)
      Mix { proofs } -> validate_mix(self, datum, mix_inputs, proofs)
    }
  }

  // The stake credential registration cert in 01-mint-and-lock fires `mix_logic`
  // with purpose=Publish. We allow ONLY the one-time RegisterCredential cert and
  // reject every other publish operation — including UnregisterCredential, which
  // would brick the protocol (no more withdraw-zero, every mix_box spend rejected
  // forever after). Delegation, redelegation, and governance certs are likewise
  // rejected: hyperstructure-coherent default is "the credential exists, is
  // registered, and nothing else can ever happen to it."
  publish(_redeemer: Data, certificate: Certificate, _self: Transaction) {
    when certificate is {
      RegisterCredential { .. } -> True
      _ -> False
    }
  }
}

// ---------------------------------------------------------------------------
// Owner branch (1 well-formed mix input, Schnorr proof against (a, b)).
// ---------------------------------------------------------------------------

fn validate_owner(
  self: Transaction,
  datum: ReferenceDatum,
  mix_inputs: List<MixDatum>,
  proof: schnorr.SchnorrProof,
) -> Bool {
  expect [d] = mix_inputs

  // ctx = blake2b_256( serialize(self.outputs) || mix_script_hash )
  let outputs_bytes = builtin.serialise_data(self.outputs)
  let ctx_preimage =
    outputs_bytes |> bytearray.concat(datum.mix_script_hash)
  let ctx = builtin.blake2b_256(ctx_preimage)

  // Owner: prover knows x with b = [x] a → Schnorr with base = a, u = b.
  schnorr.verify(d.a, d.b, proof, ctx)
}

// ---------------------------------------------------------------------------
// Mix branch (variable N, 2 ≤ N ≤ max_n).
// ---------------------------------------------------------------------------

fn validate_mix(
  self: Transaction,
  datum: ReferenceDatum,
  mix_inputs: List<MixDatum>,
  proofs: List<SigmaOrProof>,
) -> Bool {
  let n = list.length(mix_inputs)
  expect n >= 2
  expect n <= datum.max_n
  expect list.length(proofs) == n

  // Outputs at mix_script_hash MUST occupy the first N positions; later positions
  // (typically the fee-contract output and change) must NOT be at the mix script.
  let prefix_outputs = list.take(self.outputs, n)
  let tail_outputs = list.drop(self.outputs, n)
  expect list.all(prefix_outputs, fn(o) { output_at_script(o, datum.mix_script_hash) })
  expect list.all(tail_outputs, fn(o) { !output_at_script(o, datum.mix_script_hash) })

  // Per-output well-formedness (denom, no native assets, valid MixDatum).
  let mix_output_data: List<MixDatum> =
    list.map(prefix_outputs, fn(o) { check_and_decode_mix_output(o, datum) })

  // ctx = blake2b_256(
  //     serialise(out_0.datum) || ... || serialise(out_{N-1}.datum)
  //  || serialise(out_0.value) || ... || serialise(out_{N-1}.value)
  //  || mix_script_hash
  // )
  let ctx = compute_mix_ctx(prefix_outputs, datum.mix_script_hash)

  // Build the OR-statement vector once: every input's OR-proof is over the SAME N
  // output (a', b') pairs.
  let statements: List<DHTupleStatement> =
    list.map(
      mix_output_data,
      fn(d) { DHTupleStatement { ap: d.a, bp: d.b } },
    )

  // Per-input OR-proof verification. proofs[i] proves "input i's witness re-randomized
  // to one of the N outputs" — see docs/spec/02-cryptography.md §"N-way Sigma-OR".
  pairs_match_and_all(mix_inputs, proofs, fn(d, p) {
    sigma_or.verify(d.a, d.b, statements, p, ctx)
  })
}

fn check_and_decode_mix_output(output: Output, datum: ReferenceDatum) -> MixDatum {
  // Lovelace == denom and no native assets. Same `ada_only` check as fee_contract.
  expect ada_only(output.value)
  expect assets.lovelace_of(output.value) == datum.denom_lovelace
  expect Some(d) = try_decode_well_formed_inline(output.datum)
  d
}

fn compute_mix_ctx(outputs: List<Output>, mix_script_hash: ByteArray) -> ByteArray {
  let datums_bytes =
    list.foldl(
      outputs,
      #"",
      fn(o, acc) {
        when o.datum is {
          InlineDatum(d) -> bytearray.concat(acc, builtin.serialise_data(d))
          _ -> acc
        }
      },
    )
  let values_bytes =
    list.foldl(
      outputs,
      #"",
      fn(o, acc) {
        bytearray.concat(acc, builtin.serialise_data(o.value))
      },
    )
  let preimage =
    datums_bytes
      |> bytearray.concat(values_bytes)
      |> bytearray.concat(mix_script_hash)
  builtin.blake2b_256(preimage)
}

// ---------------------------------------------------------------------------
// Helpers shared with the Owner / Mix branches.
// ---------------------------------------------------------------------------

/// Filter `tx.inputs` to mix-script inputs with well-formed datums, preserving the
/// ledger's lexicographic input order. Bad-datum inputs at the same script address
/// are silently dropped (Rule 2 — they exit via `mix_box`'s True path).
fn collect_well_formed_mix_inputs(
  self: Transaction,
  mix_script_hash: ByteArray,
) -> List<MixDatum> {
  list.filter_map(
    self.inputs,
    fn(i: Input) {
      if mixbox.input_at_script(i, mix_script_hash) {
        try_decode_well_formed_inline(i.output.datum)
      } else {
        None
      }
    },
  )
}

fn ada_only(v: assets.Value) -> Bool {
  when assets.policies(v) is {
    [] -> True
    [policy] -> policy == assets.ada_policy_id
    _ -> False
  }
}

/// `list.all(zip(xs, ys), pred)`-style fold that rejects unequal-length lists.
/// Length equality is pre-asserted by the caller; this helper just exists because
/// stdlib doesn't have an exact `all2` shaped this way.
fn pairs_match_and_all(
  xs: List<MixDatum>,
  ys: List<SigmaOrProof>,
  pred: fn(MixDatum, SigmaOrProof) -> Bool,
) -> Bool {
  when (xs, ys) is {
    ([], []) -> True
    ([x, ..xs_t], [y, ..ys_t]) ->
      if pred(x, y) {
        pairs_match_and_all(xs_t, ys_t, pred)
      } else {
        False
      }
    _ -> False
  }
}
