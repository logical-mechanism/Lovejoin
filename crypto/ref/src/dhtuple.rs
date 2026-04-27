//! proveDHTuple verifier. Mirrors `contracts/lib/lovejoin/dhtuple.ak`.

use crate::bls::{
    scalar_from_bytes_mod, scalar_from_canonical_be, CryptoError, G1, SCALAR_BYTES,
};
use crate::hash::fs_hash_dh_tuple;

pub struct DHTupleProof<'a> {
    pub t0: &'a [u8],
    pub t1: &'a [u8],
    pub z: &'a [u8],
}

pub fn verify(
    g: &[u8],
    h: &[u8],
    u: &[u8],
    v: &[u8],
    proof: DHTupleProof,
    ctx: &[u8],
) -> Result<bool, CryptoError> {
    if proof.t0.len() != 48 || proof.t1.len() != 48 || proof.z.len() != SCALAR_BYTES {
        return Err(CryptoError::BadLength);
    }
    let g_pt = G1::from_compressed(g)?;
    let h_pt = G1::from_compressed(h)?;
    let u_pt = G1::from_compressed(u)?;
    let v_pt = G1::from_compressed(v)?;
    let t0_pt = G1::from_compressed(proof.t0)?;
    let t1_pt = G1::from_compressed(proof.t1)?;
    let z = scalar_from_canonical_be(proof.z)?;

    let c_bytes = fs_hash_dh_tuple(g, h, u, v, proof.t0, proof.t1, ctx);
    let c = scalar_from_bytes_mod(&c_bytes);

    let lhs0 = g_pt.scalar_mul(&z);
    let rhs0 = t0_pt.add(&u_pt.scalar_mul(&c));
    let lhs1 = h_pt.scalar_mul(&z);
    let rhs1 = t1_pt.add(&v_pt.scalar_mul(&c));
    Ok(lhs0.equal(&rhs0) && lhs1.equal(&rhs1))
}
