//// Value-shape helpers shared by mix and fee validators.
////
//// All Lovejoin protocol UTxOs (mix-boxes, fee shards) are ADA-only —
//// native assets are forbidden because they would let an attacker poison
//// a mix-box with a token, gating later spends behind a token transfer.
//// Both `mix_logic.validate_mix` and `fee_contract.{PayMixFee, Replenish}`
//// enforce ada-only; this is the one place that check lives.

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
