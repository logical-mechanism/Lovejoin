//// Protocol types shared across validators.
////
//// Spec: §1, §2, §3.
////
//// All on-chain types use the proper stdlib aliases:
////   * ScriptHash for Plutus script hashes (Hash<Blake2b_224, Script>)
////   * PolicyId   for minting-policy ids   (same underlying as ScriptHash)
////   * AssetName  for token names          (ByteArray, ≤ 32 bytes)
//// The cryptographic proof types live in M1 modules (`lovejoin/schnorr`,
//// `lovejoin/sigma_or`).

use aiken/crypto.{ScriptHash}
use cardano/assets.{AssetName, PolicyId}
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
///
/// No `fee_shard_target` either, as of M4.5: the canonical 10-shard pool is
/// off-chain coordination — no validator reads the count, and committing it
/// on-chain forced every reference-datum decode to walk one more field.
/// Dropped as part of the M4.5 redeploy schema cleanup.
///
/// Box value (docs/generalize-lovejoin.md): every mix-box in a launch holds
/// exactly `box_lovelace` plus, for a token pool, `token_quantity` of
/// `(token_policy, token_name)`. An ADA-only pool sets `token_policy` and
/// `token_name` to `#""` and `token_quantity` to 0. The token is stored as
/// three explicit fields rather than an `Assets` value: a datum-supplied
/// value in non-canonical form could never equal a ledger value, and Aiken
/// rejects casting `Data` into the opaque `Assets` type. `one_shot_mint`
/// checks the field shapes at launch time.
///
/// The live mainnet and Preprod ADA pools predate this layout and still
/// carry the 5-field datum (`denom_lovelace` in place of the four box-value
/// fields) on their own immutable bytecode.
pub type ReferenceDatum {
  box_lovelace: Int,
  token_policy: PolicyId,
  token_name: AssetName,
  token_quantity: Int,
  max_fee_per_mix_lovelace: Int,
  mix_script_hash: ScriptHash,
  mix_logic_script_hash: ScriptHash,
  fee_script_hash: ScriptHash,
}

/// `mix_box` inline datum. `a` and `b` are 48-byte compressed BLS12-381 G1 points.
pub type MixDatum {
  a: ByteArray,
  b: ByteArray,
}

/// `mix_logic` redeemer. Owner spends N well-formed mix-boxes (N ≥ 1, the
/// bulk-withdraw extension) and supplies one Schnorr proof per input; Mix
/// spends N well-formed mix-boxes (2 ≤ N) and produces N fresh ones.
pub type MixLogicRedeemer {
  Owner { proofs: List<SchnorrProof> }
  Mix { proofs: List<SigmaOrProof> }
}

/// `fee_contract` redeemer. PayMixFee is consumed by a Mix tx (value drop
/// equals tx.fee); Replenish is a strict-increase top-up.
pub type FeeRedeemer {
  PayMixFee
  Replenish
}
