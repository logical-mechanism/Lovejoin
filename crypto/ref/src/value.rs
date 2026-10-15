//! Plutus-Data CBOR of a Lovejoin box value, written independently of the TS
//! encoder (`offchain/src/tx/box-value.ts`) and Aiken's `serialise_data`.
//!
//! `mix_logic` hashes `serialise_data(box_value)` into the Mix Fiat-Shamir
//! context once per output, so a single differing byte between the prover
//! (TS) and the validator (Aiken) fails every token-pool Mix on chain. This
//! module is the third encoder the `box_value` vectors in
//! `test-vectors/encoding-parity.json` are checked against.
//!
//! A Plutus `Value` is `Map<PolicyId, Map<AssetName, Integer>>`: definite
//! maps, keys sorted bytewise, smallest-form integers. ADA's policy and name
//! are both the empty byte string, so ADA sorts first.

/// The pool token: policy id (28 bytes), asset name (0..=32 bytes), quantity.
pub struct Token<'a> {
    pub policy: &'a [u8],
    pub name: &'a [u8],
    pub quantity: u64,
}

/// Encode `lovelace` (plus the optional pool token) as canonical Plutus Data.
pub fn encode_box_value(lovelace: u64, token: Option<&Token>) -> Vec<u8> {
    let mut out = Vec::new();
    // Major type 5 (map), definite length: one entry for ADA, two with a token.
    out.push(0xa0 | if token.is_some() { 2 } else { 1 });
    push_bytes(&mut out, b"");
    out.push(0xa1);
    push_bytes(&mut out, b"");
    push_uint(&mut out, lovelace);
    if let Some(t) = token {
        assert_eq!(t.policy.len(), 28, "policy id must be 28 bytes");
        assert!(t.name.len() <= 32, "asset name must be at most 32 bytes");
        push_bytes(&mut out, t.policy);
        out.push(0xa1);
        push_bytes(&mut out, t.name);
        push_uint(&mut out, t.quantity);
    }
    out
}

/// CBOR head for `major` with argument `n`, in the shortest form.
fn push_head(out: &mut Vec<u8>, major: u8, n: u64) {
    let m = major << 5;
    match n {
        0..=23 => out.push(m | n as u8),
        24..=0xff => out.extend_from_slice(&[m | 24, n as u8]),
        0x100..=0xffff => {
            out.push(m | 25);
            out.extend_from_slice(&(n as u16).to_be_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            out.push(m | 26);
            out.extend_from_slice(&(n as u32).to_be_bytes());
        }
        _ => {
            out.push(m | 27);
            out.extend_from_slice(&n.to_be_bytes());
        }
    }
}

fn push_uint(out: &mut Vec<u8>, n: u64) {
    push_head(out, 0, n);
}

/// Byte strings up to 64 bytes are a single definite chunk in Plutus CBOR.
fn push_bytes(out: &mut Vec<u8>, b: &[u8]) {
    assert!(
        b.len() <= 64,
        "longer byte strings are chunked; not needed here"
    );
    push_head(out, 2, b.len() as u64);
    out.extend_from_slice(b);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ada_only_ten_ada() {
        assert_eq!(
            hex::encode(encode_box_value(10_000_000, None)),
            "a140a1401a00989680"
        );
    }
}
