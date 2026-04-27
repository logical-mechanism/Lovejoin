//! N-way sigma-OR verifier. Mirrors `contracts/lib/lovejoin/sigma_or.ak` and
//! `offchain/src/crypto/sigma_or.ts`.

use crate::bls::{
    scalar_from_bytes_mod, scalar_from_canonical_be, CryptoError, G1, SCALAR_BYTES,
};
use crate::hash::fs_hash_sigma_or;

pub struct SigmaOrBranchProof<'a> {
    pub t0: &'a [u8],
    pub t1: &'a [u8],
    pub c: &'a [u8],
    pub z: &'a [u8],
}

pub struct DHTupleStatement<'a> {
    pub ap: &'a [u8],
    pub bp: &'a [u8],
}

pub fn verify(
    a: &[u8],
    b: &[u8],
    statements: &[DHTupleStatement],
    branches: &[SigmaOrBranchProof],
    ctx: &[u8],
) -> Result<bool, CryptoError> {
    let n = statements.len();
    if n < 2 {
        return Err(CryptoError::BadLength);
    }
    if branches.len() != n {
        return Err(CryptoError::BadLength);
    }
    for br in branches {
        if br.t0.len() != 48 || br.t1.len() != 48 || br.c.len() != 32 || br.z.len() != SCALAR_BYTES {
            return Err(CryptoError::BadLength);
        }
    }
    let a_pt = G1::from_compressed(a)?;
    let b_pt = G1::from_compressed(b)?;

    // Build owned vectors for fs_hash_sigma_or's borrowed-slice signature.
    let stmt_owned: Vec<(Vec<u8>, Vec<u8>)> = statements
        .iter()
        .map(|s| (s.ap.to_vec(), s.bp.to_vec()))
        .collect();
    let comm_owned: Vec<(Vec<u8>, Vec<u8>)> = branches
        .iter()
        .map(|br| (br.t0.to_vec(), br.t1.to_vec()))
        .collect();

    let c_global = fs_hash_sigma_or(a, b, &stmt_owned, &comm_owned, ctx);

    // c_global == XOR_i c_i (bytewise).
    let mut xor_acc = [0u8; 32];
    for br in branches {
        for (acc, ci) in xor_acc.iter_mut().zip(br.c.iter()) {
            *acc ^= *ci;
        }
    }
    if c_global != xor_acc {
        return Ok(false);
    }

    // Per-branch DH-tuple equations.
    for (stmt, br) in statements.iter().zip(branches.iter()) {
        let ap_pt = G1::from_compressed(stmt.ap)?;
        let bp_pt = G1::from_compressed(stmt.bp)?;
        let t0_pt = G1::from_compressed(br.t0)?;
        let t1_pt = G1::from_compressed(br.t1)?;
        let z = scalar_from_canonical_be(br.z)?;
        let c = scalar_from_bytes_mod(br.c);

        let lhs0 = a_pt.scalar_mul(&z);
        let rhs0 = t0_pt.add(&ap_pt.scalar_mul(&c));
        if !lhs0.equal(&rhs0) {
            return Ok(false);
        }
        let lhs1 = b_pt.scalar_mul(&z);
        let rhs1 = t1_pt.add(&bp_pt.scalar_mul(&c));
        if !lhs1.equal(&rhs1) {
            return Ok(false);
        }
    }
    Ok(true)
}
