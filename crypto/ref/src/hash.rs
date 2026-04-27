//! Fiat-Shamir challenge construction in the reference impl. Layout MUST match
//! `offchain/src/crypto/hash.ts` and `contracts/lib/lovejoin/hash.ak` byte-for-byte
//! — the encoding-parity test in the SDK test suite locks this in.

use blake2::digest::consts::U32;
use blake2::{Blake2b, Digest};

type Blake2b256 = Blake2b<U32>;

pub const DOMAIN_TAG_V1: &[u8] = b"lovejoin/sigmajoin/v1/";
pub const STATEMENT_ID_PROVE_DLOG: u8 = 0x01;
pub const STATEMENT_ID_PROVE_DH_TUPLE: u8 = 0x02;
pub const STATEMENT_ID_SIGMA_OR_N: u8 = 0x03;

pub fn blake2b_256(bytes: &[u8]) -> [u8; 32] {
    let mut h = Blake2b256::new();
    h.update(bytes);
    let out = h.finalize();
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&out);
    arr
}

pub fn fs_hash_schnorr(g: &[u8], u: &[u8], t: &[u8], ctx: &[u8]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(DOMAIN_TAG_V1.len() + 1 + g.len() + u.len() + t.len() + ctx.len());
    buf.extend_from_slice(DOMAIN_TAG_V1);
    buf.push(STATEMENT_ID_PROVE_DLOG);
    buf.extend_from_slice(g);
    buf.extend_from_slice(u);
    buf.extend_from_slice(t);
    buf.extend_from_slice(ctx);
    blake2b_256(&buf)
}

pub fn fs_hash_dh_tuple(
    g: &[u8],
    h: &[u8],
    u: &[u8],
    v: &[u8],
    t0: &[u8],
    t1: &[u8],
    ctx: &[u8],
) -> [u8; 32] {
    let mut buf = Vec::new();
    buf.extend_from_slice(DOMAIN_TAG_V1);
    buf.push(STATEMENT_ID_PROVE_DH_TUPLE);
    buf.extend_from_slice(g);
    buf.extend_from_slice(h);
    buf.extend_from_slice(u);
    buf.extend_from_slice(v);
    buf.extend_from_slice(t0);
    buf.extend_from_slice(t1);
    buf.extend_from_slice(ctx);
    blake2b_256(&buf)
}

/// Layout: DOMAIN || 0x03 || N(1 byte) || a || b || (a'_i, b'_i)... || (t_{i,0}, t_{i,1})... || ctx
pub fn fs_hash_sigma_or(
    a: &[u8],
    b: &[u8],
    statements: &[(Vec<u8>, Vec<u8>)],
    commitments: &[(Vec<u8>, Vec<u8>)],
    ctx: &[u8],
) -> [u8; 32] {
    assert_eq!(
        statements.len(),
        commitments.len(),
        "sigma-OR statements and commitments must have equal length"
    );
    let n = statements.len();
    assert!(n >= 2 && n <= 255, "sigma-OR width must be in [2, 255]");

    let mut buf = Vec::new();
    buf.extend_from_slice(DOMAIN_TAG_V1);
    buf.push(STATEMENT_ID_SIGMA_OR_N);
    buf.push(n as u8);
    buf.extend_from_slice(a);
    buf.extend_from_slice(b);
    for (ap, bp) in statements {
        buf.extend_from_slice(ap);
        buf.extend_from_slice(bp);
    }
    for (t0, t1) in commitments {
        buf.extend_from_slice(t0);
        buf.extend_from_slice(t1);
    }
    buf.extend_from_slice(ctx);
    blake2b_256(&buf)
}
