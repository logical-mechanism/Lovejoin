//// Protocol types shared across validators.
////
//// Spec: docs/spec/03-contracts.md §1, §2, §3.
////
//// All on-chain types use the proper stdlib aliases:
////   * ScriptHash for Plutus script hashes (Hash<Blake2b_224, Script>)
////   * PolicyId   for minting-policy ids   (same underlying as ScriptHash)
////   * AssetName  for token names          (ByteArray, ≤ 32 bytes)
//// The cryptographic proof types live in M1 modules (`lovejoin/schnorr`,
//// `lovejoin/sigma_or`).

use aiken/crypto.{ScriptHash}
use lovejoin/schnorr.{SchnorrProof}
use lovejoin/sigma_or.{SigmaOrProof}

/// On-chain protocol parameters, kept as an inline datum on the reference UTxO
/// at `reference_holder`. Permanent — `reference_holder` is always-False, so
/// this datum cannot be modified after bootstrap.
///
/// Flat layout (no intermediate wrapper) matches the canonical hyperstructure
/// pattern: a single Constr-0 with all fields directly addressable.
///
/// No `max_n`: the validator only enforces `N >= 2`. The natural ceiling for
/// N is whatever fits in the chain's per-tx CPU/mem budget. Hard-coding a
/// max would make the protocol get stuck if Cardano's per-tx limits ever
/// rise (or if validator costs drop). SDKs can still carry a recommended N
/// as off-chain config (network.<net>.json), but it's not protocol-level.
pub type ReferenceDatum {
  denom_lovelace: Int,
  max_fee_per_mix_lovelace: Int,
  mix_script_hash: ScriptHash,
  mix_logic_script_hash: ScriptHash,
  fee_script_hash: ScriptHash,
  fee_shard_target: Int,
}

/// `mix_box` inline datum. `a` and `b` are 48-byte compressed BLS12-381 G1 points.
pub type MixDatum {
  a: ByteArray,
  b: ByteArray,
}

/// `mix_logic` redeemer. Owner spends one well-formed mix-box; Mix spends N
/// well-formed mix-boxes (2 ≤ N ≤ max_n) and produces N fresh ones.
pub type MixLogicRedeemer {
  Owner { proof: SchnorrProof }
  Mix { proofs: List<SigmaOrProof> }
}

/// `fee_contract` redeemer. PayMixFee is consumed by a Mix tx (value drop
/// equals tx.fee); Replenish is a strict-increase top-up.
pub type FeeRedeemer {
  PayMixFee
  Replenish
}
