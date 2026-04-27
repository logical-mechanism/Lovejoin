//! Cross-impl KAT verification: every entry in `crypto/test-vectors/*.json` MUST
//! verify (positives) or be rejected (negatives) by the Rust reference. This is
//! the third independent verifier (TS, Aiken, Rust) and the cross-check that
//! catches any single-implementation mistake before it reaches the chain.

use lovejoin_ref::dhtuple::{verify as verify_dhtuple, DHTupleProof};
use lovejoin_ref::schnorr::{verify as verify_schnorr, SchnorrProof};
use lovejoin_ref::sigma_or::{verify as verify_sigma_or, DHTupleStatement, SigmaOrBranchProof};

use serde::Deserialize;
use std::fs;
use std::path::PathBuf;

fn vec_dir() -> PathBuf {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir");
    PathBuf::from(manifest).join("../test-vectors")
}

fn read_json<T: for<'de> Deserialize<'de>>(name: &str) -> T {
    let path = vec_dir().join(name);
    let s = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {}", path.display(), e));
    serde_json::from_str(&s).unwrap_or_else(|e| panic!("{}: {}", path.display(), e))
}

fn dehex(s: &str) -> Vec<u8> {
    if s.is_empty() {
        Vec::new()
    } else {
        hex::decode(s).expect("hex")
    }
}

// --- Schnorr ---------------------------------------------------------------

#[derive(Deserialize)]
struct SchnorrCase {
    base: String,
    u: String,
    t: String,
    z: String,
    ctx: String,
}

#[test]
fn schnorr_kat_all_verify() {
    let cases: Vec<SchnorrCase> = read_json("provedlog.json");
    assert!(cases.len() >= 8, "expected non-trivial Schnorr KAT count");
    for c in &cases {
        let base = dehex(&c.base);
        let u = dehex(&c.u);
        let t = dehex(&c.t);
        let z = dehex(&c.z);
        let ctx = dehex(&c.ctx);
        let ok = verify_schnorr(&base, &u, SchnorrProof { t: &t, z: &z }, &ctx)
            .unwrap_or_else(|e| panic!("malformed Schnorr KAT: {:?}", e));
        assert!(ok, "Schnorr KAT failed to verify");
    }
}

// --- DHTuple ---------------------------------------------------------------

#[derive(Deserialize)]
struct DHTupleCase {
    g: String,
    h: String,
    u: String,
    v: String,
    t0: String,
    t1: String,
    z: String,
    ctx: String,
}

#[test]
fn dhtuple_kat_all_verify() {
    let cases: Vec<DHTupleCase> = read_json("provedhtuple.json");
    assert!(cases.len() >= 8, "expected non-trivial DHTuple KAT count");
    for c in &cases {
        let g = dehex(&c.g);
        let h = dehex(&c.h);
        let u = dehex(&c.u);
        let v = dehex(&c.v);
        let t0 = dehex(&c.t0);
        let t1 = dehex(&c.t1);
        let z = dehex(&c.z);
        let ctx = dehex(&c.ctx);
        let ok = verify_dhtuple(&g, &h, &u, &v, DHTupleProof { t0: &t0, t1: &t1, z: &z }, &ctx)
            .unwrap_or_else(|e| panic!("malformed DHTuple KAT: {:?}", e));
        assert!(ok, "DHTuple KAT failed to verify");
    }
}

// --- Sigma-OR --------------------------------------------------------------

#[derive(Deserialize)]
struct SigmaStmt {
    ap: String,
    bp: String,
}
#[derive(Deserialize)]
struct SigmaBranch {
    t0: String,
    t1: String,
    c: String,
    z: String,
}
#[derive(Deserialize)]
struct SigmaOrCase {
    #[serde(rename = "N")]
    n: usize,
    a: String,
    b: String,
    ctx: String,
    statements: Vec<SigmaStmt>,
    branches: Vec<SigmaBranch>,
}

#[test]
fn sigma_or_kat_coverage_per_n() {
    let cases: Vec<SigmaOrCase> = read_json("sigma-or.json");
    let mut counts = std::collections::HashMap::<usize, usize>::new();
    for c in &cases {
        *counts.entry(c.n).or_default() += 1;
    }
    for &n in &[2usize, 3, 4, 6, 8] {
        assert_eq!(counts.get(&n), Some(&200), "expected 200 vectors at N={}", n);
    }
    assert_eq!(cases.len(), 1000);
}

#[test]
fn sigma_or_kat_all_verify() {
    let cases: Vec<SigmaOrCase> = read_json("sigma-or.json");
    for c in &cases {
        let a = dehex(&c.a);
        let b = dehex(&c.b);
        let ctx = dehex(&c.ctx);
        let stmts: Vec<(Vec<u8>, Vec<u8>)> = c
            .statements
            .iter()
            .map(|s| (dehex(&s.ap), dehex(&s.bp)))
            .collect();
        let branches: Vec<(Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>)> = c
            .branches
            .iter()
            .map(|br| (dehex(&br.t0), dehex(&br.t1), dehex(&br.c), dehex(&br.z)))
            .collect();
        let stmt_refs: Vec<DHTupleStatement> = stmts
            .iter()
            .map(|(ap, bp)| DHTupleStatement { ap, bp })
            .collect();
        let branch_refs: Vec<SigmaOrBranchProof> = branches
            .iter()
            .map(|(t0, t1, ci, zi)| SigmaOrBranchProof {
                t0,
                t1,
                c: ci,
                z: zi,
            })
            .collect();
        let ok = verify_sigma_or(&a, &b, &stmt_refs, &branch_refs, &ctx)
            .unwrap_or_else(|e| panic!("malformed sigma-OR KAT: {:?}", e));
        assert!(ok, "sigma-OR KAT failed to verify (N={})", c.n);
    }
}

// --- Negatives -------------------------------------------------------------

#[derive(Deserialize)]
#[serde(tag = "kind")]
enum NegativeCase {
    #[serde(rename = "schnorr")]
    Schnorr {
        mutation: String,
        base: String,
        u: String,
        t: String,
        z: String,
        ctx: String,
    },
    #[serde(rename = "dhtuple")]
    DHTuple {
        mutation: String,
        g: String,
        h: String,
        u: String,
        v: String,
        t0: String,
        t1: String,
        z: String,
        ctx: String,
    },
    #[serde(rename = "sigma_or")]
    SigmaOr {
        mutation: String,
        #[serde(rename = "N")]
        _n: usize,
        a: String,
        b: String,
        ctx: String,
        statements: Vec<SigmaStmt>,
        branches: Vec<SigmaBranch>,
    },
}

/// A negative is "rejected" if either:
///   - structural decode fails (Err), OR
///   - verifier returns Ok(false).
fn is_rejected<T>(r: Result<bool, T>) -> bool {
    matches!(r, Err(_) | Ok(false))
}

#[test]
fn every_negative_is_rejected() {
    let cases: Vec<NegativeCase> = read_json("negative.json");
    assert!(cases.len() >= 100, "expected substantial negative coverage");
    for c in &cases {
        match c {
            NegativeCase::Schnorr { mutation, base, u, t, z, ctx } => {
                let base_b = dehex(base);
                let u_b = dehex(u);
                let t_b = dehex(t);
                let z_b = dehex(z);
                let ctx_b = dehex(ctx);
                let r = verify_schnorr(&base_b, &u_b, SchnorrProof { t: &t_b, z: &z_b }, &ctx_b);
                assert!(is_rejected(r), "Schnorr negative '{}' wrongly verified", mutation);
            }
            NegativeCase::DHTuple { mutation, g, h, u, v, t0, t1, z, ctx } => {
                let g_b = dehex(g);
                let h_b = dehex(h);
                let u_b = dehex(u);
                let v_b = dehex(v);
                let t0_b = dehex(t0);
                let t1_b = dehex(t1);
                let z_b = dehex(z);
                let ctx_b = dehex(ctx);
                let r = verify_dhtuple(
                    &g_b,
                    &h_b,
                    &u_b,
                    &v_b,
                    DHTupleProof { t0: &t0_b, t1: &t1_b, z: &z_b },
                    &ctx_b,
                );
                assert!(is_rejected(r), "DHTuple negative '{}' wrongly verified", mutation);
            }
            NegativeCase::SigmaOr { mutation, a, b, ctx, statements, branches, .. } => {
                let a_b = dehex(a);
                let b_b = dehex(b);
                let ctx_b = dehex(ctx);
                let stmts: Vec<(Vec<u8>, Vec<u8>)> = statements
                    .iter()
                    .map(|s| (dehex(&s.ap), dehex(&s.bp)))
                    .collect();
                let brs: Vec<(Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>)> = branches
                    .iter()
                    .map(|br| (dehex(&br.t0), dehex(&br.t1), dehex(&br.c), dehex(&br.z)))
                    .collect();
                let stmt_refs: Vec<DHTupleStatement> = stmts
                    .iter()
                    .map(|(ap, bp)| DHTupleStatement { ap, bp })
                    .collect();
                let branch_refs: Vec<SigmaOrBranchProof> = brs
                    .iter()
                    .map(|(t0, t1, ci, zi)| SigmaOrBranchProof {
                        t0,
                        t1,
                        c: ci,
                        z: zi,
                    })
                    .collect();
                let r = verify_sigma_or(&a_b, &b_b, &stmt_refs, &branch_refs, &ctx_b);
                assert!(is_rejected(r), "sigma-OR negative '{}' wrongly verified", mutation);
            }
        }
    }
}
