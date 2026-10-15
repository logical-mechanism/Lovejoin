//// One-shot minting policy.
////
//// Spec: §1.
////
//// Parameterized by a seed `OutputReference` and the always-False
//// `reference_holder` script hash. The policy permits a single mint event in
//// which:
////   (a) the seed UTxO is consumed,
////   (b) exactly one token is minted under this policy at the canonical
////       asset name `"lovejoin"`,
////   (c) that NFT lands at the `reference_holder` script address, and
////   (d) the corresponding output carries an inline `ReferenceDatum` with
////       sane field values.
////
//// After the seed UTxO is consumed once, the policy can never fire again —
//// this is what makes the reference NFT a one-of-one for life.
////
//// Audit F-17 (next-redeploy bundle Q-2): the asset name is baked into the
//// validator (`#"6c6f76656a6f696e"` = ASCII "lovejoin"). Pre-fix it was
//// supplied at bootstrap time via the `REF_NFT_ASSET_NAME` env-var; a typo
//// would mint the protocol NFT under a non-canonical name and the rest of
//// the bootstrap (which derives addresses from `(policy, name)`) would
//// silently sail past the mistake.
////
//// Audit L-01 / L-02 (issue #130): the destination + datum-sanity checks
//// move the bootstrap-time invariants on chain. Pre-fix they were enforced
//// only by the off-chain shell scripts — a deployer mistake (NFT to the
//// wrong address, malformed datum, zero box value) would brick the protocol
//// permanently because the seed UTxO is single-use. Post-fix the mint tx
//// rejects any deviation and the deployer can simply rebuild and resubmit.
////
//// Audit L-01 (audit-of-audit, next-redeploy bundle): the destination
//// predicate originally matched only `payment_credential` + NFT quantity.
//// The bootstrap deployer could therefore attach an arbitrary
//// `stake_credential` (siphoning staking rewards on the reference UTxO's
//// principal forever — `reference_holder` is always-False) or an
//// arbitrary `reference_script` payload (using the protocol's reference
//// UTxO min-ADA budget as free script storage). The destination predicate
//// now delegates to `reference.output_at_reference_holder`, which pins
//// `stake_credential == None` and `reference_script == None` exactly like
//// the H-01 / M-01 perimeter rule on `output_at_script` / `output_at_fee`.
////
//// The `reference_holder` validator carries no parameters, so its hash is a
//// fixed compile-time constant computable before `one_shot_mint`. This
//// breaks what would otherwise be a circular `(policy, holder)` dependency.

use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{ScriptHash}
use aiken/primitive/bytearray
use cardano/assets
use cardano/transaction.{
  InlineDatum, OutputReference, Transaction, TransactionId,
}
use lovejoin/reference.{output_at_reference_holder}
use lovejoin/types.{ReferenceDatum}

// Flat params so `aiken blueprint apply` can supply them as separate CBOR
// atoms (one CBOR atom per call). The bash side encodes seed_tx_id /
// reference_holder_hash as bytes and seed_idx as int via cbor2; the validator
// reconstructs the OutputReference internally for the consumption check.
validator one_shot_mint(
  seed_tx_id: TransactionId,
  seed_idx: Int,
  reference_holder_hash: ScriptHash,
) {
  mint(_redeemer: Data, policy_id: assets.PolicyId, self: Transaction) {
    let seed = OutputReference {
      transaction_id: seed_tx_id,
      output_index: seed_idx,
    }
    let seed_consumed = self.inputs
      |> list.any(fn(input) { input.output_reference == seed })

    // Exactly one (asset_name, quantity) pair under this policy. The
    // pattern-match on `[Pair(_, _)]` enforces dict size == 1, so the
    // explicit size check folds away. Asset name is pinned to
    // `"lovejoin"` (hex 6c6f76656a6f696e); quantity is pinned to 1.
    let tokens_under_policy = assets.tokens(self.mint, policy_id)
    expect [Pair(asset_name, quantity)] = tokens_under_policy |> dict.to_pairs

    // L-01: the NFT must land at the `reference_holder` script with a
    // clean perimeter (no stake credential, no attached reference script)
    // and carry quantity 1 of (policy, asset_name). The shared helper
    // keeps this rule shape-aligned with `output_at_script` /
    // `output_at_fee`; duplicate matches would still be rejected by the
    // ledger value-balance rule because the mint provides exactly one
    // token in total.
    expect Some(target) = self.outputs
      |> list.find(
          fn(o) {
            output_at_reference_holder(
              o,
              reference_holder_hash,
              policy_id,
              asset_name,
            )
          },
        )

    // L-02: the destination's datum must decode as a `ReferenceDatum` and
    // carry sane field values. We do NOT assert on the three downstream
    // script hashes — Aiken cannot derive a sibling script's hash at
    // compile time, so that invariant stays operationally enforced by the
    // bootstrap script (which writes all four hashes from the same compile
    // output). The bounds we DO check are the ones whose violation would
    // brick the protocol with no operator recourse: `box_lovelace <= 0`
    // makes every Deposit value-check vacuous; `max_fee >= box_lovelace`
    // lets a Mix tx drain a fee shard for more than a box's lovelace; a
    // malformed token triple describes a box value no ledger output can
    // ever hold, so no Mix could ever succeed.
    expect InlineDatum(datum_data) = target.datum
    expect parsed: ReferenceDatum = datum_data
    let datum_sane = and {
      parsed.box_lovelace > 0,
      parsed.max_fee_per_mix_lovelace > 0,
      parsed.max_fee_per_mix_lovelace < parsed.box_lovelace,
      token_sane(parsed),
    }

    and {
      seed_consumed,
      asset_name == #"6c6f76656a6f696e",
      quantity == 1,
      datum_sane,
    }
  }

  else(_) {
    fail
  }
}

/// Launch-time shape check for the pool token (docs/generalize-lovejoin.md).
///
/// ADA-only pool: `token_policy == #""`, `token_name == #""`,
/// `token_quantity == 0`. Token pool: a 28-byte policy id, an asset name of
/// at most 32 bytes, and `0 < token_quantity <= max_token_quantity` (the
/// ledger's per-asset ceiling; a larger `Q` could never sit in an output).
/// `value.box_value` relies on the quantity being positive whenever the
/// policy is set; a zero quantity would make `assets.add` drop the token
/// and silently turn a token launch into an ADA pool.
fn token_sane(datum: ReferenceDatum) -> Bool {
  if datum.token_policy == assets.ada_policy_id {
    and {
      datum.token_name == assets.ada_asset_name,
      datum.token_quantity == 0,
    }
  } else {
    and {
      bytearray.length(datum.token_policy) == 28,
      bytearray.length(datum.token_name) <= 32,
      datum.token_quantity > 0,
      datum.token_quantity <= max_token_quantity,
    }
  }
}

/// 2^64 - 1, the ledger's ceiling on one asset's quantity in an output
/// (Conway CDDL `positive_coin = 1 .. maxWord64`).
const max_token_quantity: Int = 18_446_744_073_709_551_615
