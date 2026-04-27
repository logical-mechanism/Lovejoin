//! Schnorr / proveDlog verifier. Mirrors `contracts/lib/lovejoin/schnorr.ak`.

use crate::bls::{
    scalar_from_bytes_mod, scalar_from_canonical_be, CryptoError, G1, SCALAR_BYTES,
};
use crate::hash::fs_hash_schnorr;

pub struct SchnorrProof<'a> {
    pub t: &'a [u8],
    pub z: &'a [u8],
}

/// Verify a Schnorr proof for `u = [x]·base` bound to `ctx`. Returns
/// `Ok(true)` on accept, `Ok(false)` on a math-level rejection, and
/// `Err(_)` on a structural malformedness (matches the on-chain validator
/// behavior: bad encoding ⇒ script failure, bad math ⇒ False).
pub fn verify(
    base: &[u8],
    u: &[u8],
    proof: SchnorrProof,
    ctx: &[u8],
) -> Result<bool, CryptoError> {
    if proof.t.len() != 48 || proof.z.len() != SCALAR_BYTES {
        return Err(CryptoError::BadLength);
    }
    let base_pt = G1::from_compressed(base)?;
    let u_pt = G1::from_compressed(u)?;
    let t_pt = G1::from_compressed(proof.t)?;
    let z = scalar_from_canonical_be(proof.z)?;

    let c_bytes = fs_hash_schnorr(base, u, proof.t, ctx);
    let c = scalar_from_bytes_mod(&c_bytes);

    // [z]·base == t + [c]·u
    let lhs = base_pt.scalar_mul(&z);
    let rhs = t_pt.add(&u_pt.scalar_mul(&c));
    Ok(lhs.equal(&rhs))
}
