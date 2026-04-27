//! Reference cryptography for Lovejoin. Verifier-side, third-of-three
//! independent implementations (TS prover/verifier in `offchain/src/crypto/`,
//! Aiken verifier in `contracts/lib/lovejoin/`, Rust ref here).
//!
//! Spec: `docs/spec/02-cryptography.md`. Curve: BLS12-381 G1.
//!
//! This crate's job is narrow but load-bearing: read the canonical KAT vectors
//! emitted by the TS prover and assert the Sigmajoin math accepts every
//! positive and rejects every negative, using blst (independent of @noble/curves).
//! If the three verifiers ever disagree on a vector, that's a build-blocker.

pub mod bls;
pub mod hash;
pub mod schnorr;
pub mod dhtuple;
pub mod sigma_or;
