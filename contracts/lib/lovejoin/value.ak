//// Value-shape helpers shared by mix and fee validators.
////
//// Fee shards are always ADA-only, and mix-boxes carry exactly the launch's
//// box value: `box_lovelace` alone for an ADA pool, or `box_lovelace` plus
//// `token_quantity` of one `(token_policy, token_name)` for a token pool.
//// Any other asset is forbidden because it would let an attacker poison a
//// box with a junk token, gating later spends behind a token transfer.
//// `mix_logic.validate_mix` enforces the exact box value and
//// `fee_contract.{PayMixFee, Replenish}` enforce ada-only; both checks are
//// built from the helpers in this module.

use aiken/collection/dict
use cardano/assets.{Assets}
use lovejoin/types.{ReferenceDatum}

/// The exact value every mix-box in this launch must hold.
///
/// Built with `assets.from_lovelace` and `assets.add`, so the result is in
/// canonical form (sorted policies and names, no zero entries) by
/// construction and compares equal to a ledger-provided output value with
/// the same contents. An ADA-only pool (`token_policy == #""`) skips the
/// `assets.add`; `one_shot_mint` guarantees `token_quantity > 0` whenever
/// the policy is set, so the token entry is never silently dropped.
pub fn box_value(reference_datum: ReferenceDatum) -> Assets {
  let lovelace = assets.from_lovelace(reference_datum.box_lovelace)
  if reference_datum.token_policy == assets.ada_policy_id {
    lovelace
  } else {
    assets.add(
      lovelace,
      reference_datum.token_policy,
      reference_datum.token_name,
      reference_datum.token_quantity,
    )
  }
}

/// True iff the value carries only ADA.
///
/// `Value` is canonicalised so that policies are kept in a sorted map; an
/// ADA-only value's `policies` is either `[]` (when the lovelace amount is
/// zero) or `[ada_policy_id]` (when non-zero). Mix and fee outputs always
/// carry non-zero ADA, so the empty case is an extra correctness margin.
pub fn ada_only(value: Assets) -> Bool {
  when assets.policies(value) is {
    [] -> True
    [policy] -> policy == assets.ada_policy_id
    _ -> False
  }
}

/// Enforce ada-only AND return the lovelace amount in a single dict walk.
///
/// Replaces the common `expect ada_only(value)` + `assets.lovelace_of(value)`
/// pair, which walks the underlying dict twice. We pattern-match the
/// canonical ada-only pairs shape `[Pair(ada_policy_id, [Pair("", n)])]`
/// directly via `head_list` / `snd_pair` builtins — same security contract
/// (rejects values with extra policies or extra asset names under the ada
/// policy), one walk.
///
/// Hard-fails on:
///   * empty value (no policies),
///   * any non-ada policy present (even if ada also present),
///   * the ada policy carrying a non-canonical asset name (anything other
///     than `""`),
///   * the ada policy holding more than one asset entry.
///
/// All Lovejoin mix and fee outputs always carry exactly one asset (ada at
/// the empty asset name), so the canonical-shape match is the right shape
/// to enforce.
pub fn expect_ada_only_lovelace(value: Assets) -> Int {
  let pairs = value |> assets.to_dict |> dict.to_pairs
  expect [Pair(policy, ada_assets)] = pairs
  expect policy == assets.ada_policy_id
  expect [Pair(asset_name, lovelace)] = ada_assets |> dict.to_pairs
  expect asset_name == assets.ada_asset_name
  lovelace
}
