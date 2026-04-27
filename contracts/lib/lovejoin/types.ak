//// Protocol types shared across validators.
////
//// Spec: docs/spec/03-contracts.md §1 (ProtocolParams), §2 (MixDatum, MixLogicRedeemer),
//// §3 (FeeRedeemer). The cryptographic proof types live in M1 modules
//// (`lovejoin/schnorr`, `lovejoin/sigma_or`) and are re-exported by their respective
//// validators.

use lovejoin/schnorr.{SchnorrProof}
use lovejoin/sigma_or.{SigmaOrProof}

/// 28-byte Blake2b-224 hash; matches Cardano's ScriptHash / VerificationKeyHash width.
pub type Hash28 =
  ByteArray

/// Identifies the reference NFT that anchors the protocol's hyperstructure.
/// `mix_logic` and `fee_contract` are parameterized by this; `mix_box` is parameterized
/// by `mix_logic`'s credential directly so it can do its withdraw-zero check without
/// touching the reference UTxO.
pub type ReferenceParams {
  reference_nft_policy: Hash28,
  reference_nft_name: ByteArray,
}

/// On-chain protocol parameters, kept in the inline datum of the reference UTxO at
/// `reference_holder`. Permanent: `reference_holder` is always-False, so this datum
/// cannot be modified after bootstrap.
pub type ProtocolParams {
  denom_lovelace: Int,
  max_fee_per_mix_lovelace: Int,
  max_n: Int,
  mix_script_hash: Hash28,
  mix_logic_script_hash: Hash28,
  fee_script_hash: Hash28,
  fee_shard_target: Int,
}

/// Datum on the reference UTxO. Wrapping `protocol` keeps room for future top-level
/// fields without breaking the constructor index.
pub type ReferenceDatum {
  protocol: ProtocolParams,
}

/// `mix_box` inline datum. `a` and `b` are 48-byte compressed BLS12-381 G1 points.
pub type MixDatum {
  a: ByteArray,
  b: ByteArray,
}

/// `mix_logic` redeemer. Owner spends one well-formed mix-box; Mix spends N well-formed
/// mix-boxes (2 ≤ N ≤ max_n) and produces N fresh ones.
pub type MixLogicRedeemer {
  Owner { proof: SchnorrProof }
  Mix { proofs: List<SigmaOrProof> }
}

/// `fee_contract` redeemer. PayMixFee is consumed by a Mix tx (value drop equals tx.fee);
/// Replenish is a strict-increase top-up.
pub type FeeRedeemer {
  PayMixFee
  Replenish
}
