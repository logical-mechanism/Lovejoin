//! BLS12-381 G1 wrappers backed by `blst` (independent of @noble/curves on the
//! TS side). Exposes the minimum API the sigma-protocol verifiers need.

use blst::min_pk::PublicKey;
use blst::{
    blst_p1, blst_p1_add_or_double, blst_p1_affine, blst_p1_compress, blst_p1_from_affine,
    blst_p1_mult, blst_p1_uncompress, BLST_ERROR,
};
use num_bigint::BigUint;
use num_traits::Num;

/// 48-byte compressed G1 element size.
pub const G1_COMPRESSED_BYTES: usize = 48;

/// 32-byte canonical scalar size.
pub const SCALAR_BYTES: usize = 32;

/// Subgroup order r as a hex string (matches docs/spec/02-cryptography.md).
const SCALAR_ORDER_HEX: &str =
    "73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001";

pub fn scalar_order() -> BigUint {
    BigUint::from_str_radix(SCALAR_ORDER_HEX, 16).expect("r is a valid hex literal")
}

#[derive(Debug)]
pub enum CryptoError {
    BadPointEncoding,
    NotInSubgroup,
    BadScalar,
    BadLength,
}

#[derive(Debug, Clone, Copy)]
pub struct G1(pub blst_p1);

impl G1 {
    /// Decompress a 48-byte compressed G1 element. Subgroup check enforced.
    pub fn from_compressed(bytes: &[u8]) -> Result<Self, CryptoError> {
        if bytes.len() != G1_COMPRESSED_BYTES {
            return Err(CryptoError::BadLength);
        }
        // PublicKey::deserialize performs both validity AND subgroup checks.
        if PublicKey::deserialize(bytes).is_err() {
            return Err(CryptoError::NotInSubgroup);
        }
        let mut affine = blst_p1_affine::default();
        let err = unsafe { blst_p1_uncompress(&mut affine, bytes.as_ptr()) };
        if err != BLST_ERROR::BLST_SUCCESS {
            return Err(CryptoError::BadPointEncoding);
        }
        let mut p = blst_p1::default();
        unsafe { blst_p1_from_affine(&mut p, &affine) };
        Ok(G1(p))
    }

    pub fn to_compressed(&self) -> [u8; G1_COMPRESSED_BYTES] {
        let mut out = [0u8; G1_COMPRESSED_BYTES];
        unsafe { blst_p1_compress(out.as_mut_ptr(), &self.0) };
        out
    }

    /// Group equality (compares the canonical compressed encodings).
    pub fn equal(&self, other: &G1) -> bool {
        self.to_compressed() == other.to_compressed()
    }

    /// Group addition: self + other.
    pub fn add(&self, other: &G1) -> G1 {
        let mut out = blst_p1::default();
        unsafe { blst_p1_add_or_double(&mut out, &self.0, &other.0) };
        G1(out)
    }

    /// Scalar multiplication: [k]·self.
    pub fn scalar_mul(&self, k: &BigUint) -> G1 {
        // blst_p1_mult expects little-endian bytes with a bit length.
        let k_be = k.to_bytes_be();
        let mut k_padded = [0u8; SCALAR_BYTES];
        let off = SCALAR_BYTES.saturating_sub(k_be.len());
        if k_be.len() <= SCALAR_BYTES {
            k_padded[off..].copy_from_slice(&k_be);
        } else {
            // Caller is responsible for reducing mod r before calling.
            k_padded.copy_from_slice(&k_be[k_be.len() - SCALAR_BYTES..]);
        }
        let mut k_le = k_padded;
        k_le.reverse();
        let mut out = blst_p1::default();
        unsafe {
            blst_p1_mult(&mut out, &self.0, k_le.as_ptr(), 256);
        }
        G1(out)
    }
}

/// Decode a 32-byte big-endian scalar to a BigUint, rejecting non-canonical
/// (>= r) encodings. Mirrors the TS prover's `scalarFromBytes` policy.
pub fn scalar_from_canonical_be(bytes: &[u8]) -> Result<BigUint, CryptoError> {
    if bytes.len() != SCALAR_BYTES {
        return Err(CryptoError::BadLength);
    }
    let v = BigUint::from_bytes_be(bytes);
    if v >= scalar_order() {
        return Err(CryptoError::BadScalar);
    }
    Ok(v)
}

/// Reduce arbitrary-length big-endian bytes mod r (used for FS challenges and
/// for c_i bytes in sigma-OR).
pub fn scalar_from_bytes_mod(bytes: &[u8]) -> BigUint {
    BigUint::from_bytes_be(bytes) % scalar_order()
}
