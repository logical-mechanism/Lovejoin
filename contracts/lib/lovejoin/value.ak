//// Value-shape helpers shared by mix and fee validators.
////
//// All Lovejoin protocol UTxOs (mix-boxes, fee shards) are ADA-only —
//// native assets are forbidden because they would let an attacker poison
//// a mix-box with a token, gating later spends behind a token transfer.
//// Both `mix_logic.validate_mix` and `fee_contract.{PayMixFee, Replenish}`
//// enforce ada-only; this is the one place that check lives.

use aiken/collection/dict
use cardano/assets.{Value}

/// True iff the value carries only ADA.
///
/// `Value` is canonicalised so that policies are kept in a sorted map; an
/// ADA-only value's `policies` is either `[]` (when the lovelace amount is
/// zero) or `[ada_policy_id]` (when non-zero). Mix and fee outputs always
/// carry non-zero ADA, so the empty case is an extra correctness margin.
pub fn ada_only(value: Value) -> Bool {
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
pub fn expect_ada_only_lovelace(value: Value) -> Int {
  let pairs = value |> assets.to_dict |> dict.to_pairs
  expect [Pair(policy, ada_assets)] = pairs
  expect policy == assets.ada_policy_id
  expect [Pair(asset_name, lovelace)] = ada_assets |> dict.to_pairs
  expect asset_name == assets.ada_asset_name
  lovelace
}
