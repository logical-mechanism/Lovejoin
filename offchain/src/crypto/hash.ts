// Fiat-Shamir challenge construction for the sigma protocols.
//
// Spec: §"Hash function and Fiat-Shamir context binding".
//
// Hash input layout (byte concatenation, no CBOR — see
// §Risk 1: encoding parity is what makes TS prover and Aiken verifier agree):
//
//   H( DOMAIN_TAG_v1
//   || statement_id           // 1 byte: 0x01 / 0x02 / 0x03
//   || N                      // 1 byte: only for sigma-or-N
//   || all public group elements (compressed, 48 bytes each, fixed order)
//   || all commitment values t_* (compressed, 48 bytes each, fixed order)
//   || ctx                    // context-binding string (caller-supplied)
//   )
//
// `H` is blake2b-256 (Plutus builtin; matches @noble/hashes blake2b at dkLen=32).

import { blake2b } from "@noble/hashes/blake2.js";

/// Domain-separation tag for v1 of the protocol. ASCII; never CBOR-encoded.
export const DOMAIN_TAG_V1 = "lovejoin/sigmajoin/v1/";

/// Pre-encoded as bytes for direct concatenation — no encoding ambiguity.
export const DOMAIN_TAG_V1_BYTES: Uint8Array = new TextEncoder().encode(DOMAIN_TAG_V1);

/// 1-byte statement identifiers.
export const STATEMENT_ID_PROVE_DLOG = 0x01;
export const STATEMENT_ID_PROVE_DH_TUPLE = 0x02;
export const STATEMENT_ID_SIGMA_OR_N = 0x03;

/// blake2b-256: 32-byte digest. Matches Aiken's `builtin.blake2b_256`.
export function blake2b256(bytes: Uint8Array): Uint8Array {
  return blake2b(bytes, { dkLen: 32 });
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/// Build the byte string fed to blake2b for a Schnorr proof. Exposed (not just the
/// hash) so the encoding-parity test can compare bytes, not just hashes.
export function fsInputSchnorr(
  g: Uint8Array, // 48-byte compressed
  u: Uint8Array,
  t: Uint8Array,
  ctx: Uint8Array,
): Uint8Array {
  return concat([DOMAIN_TAG_V1_BYTES, new Uint8Array([STATEMENT_ID_PROVE_DLOG]), g, u, t, ctx]);
}

/// Schnorr Fiat-Shamir hash. Caller is responsible for `mod r` reduction — this
/// returns the raw 32-byte digest.
export function fsHashSchnorr(
  g: Uint8Array,
  u: Uint8Array,
  t: Uint8Array,
  ctx: Uint8Array,
): Uint8Array {
  return blake2b256(fsInputSchnorr(g, u, t, ctx));
}

export function fsInputDHTuple(
  g: Uint8Array,
  h: Uint8Array,
  u: Uint8Array,
  v: Uint8Array,
  t0: Uint8Array,
  t1: Uint8Array,
  ctx: Uint8Array,
): Uint8Array {
  return concat([
    DOMAIN_TAG_V1_BYTES,
    new Uint8Array([STATEMENT_ID_PROVE_DH_TUPLE]),
    g,
    h,
    u,
    v,
    t0,
    t1,
    ctx,
  ]);
}

export function fsHashDHTuple(
  g: Uint8Array,
  h: Uint8Array,
  u: Uint8Array,
  v: Uint8Array,
  t0: Uint8Array,
  t1: Uint8Array,
  ctx: Uint8Array,
): Uint8Array {
  return blake2b256(fsInputDHTuple(g, h, u, v, t0, t1, ctx));
}

/// Per-branch public statement: (a'_i, b'_i).
export type SigmaOrStatementBranch = { ap: Uint8Array; bp: Uint8Array };

/// Per-branch commitment values: (t_{i,0}, t_{i,1}).
export type SigmaOrCommitment = { t0: Uint8Array; t1: Uint8Array };

/// Build the byte string fed to blake2b for an N-way sigma-OR proof.
///
/// Layout: DOMAIN_TAG || 0x03 || N(1) || a || b
///                   || a'_0 || b'_0 || ... || a'_{N-1} || b'_{N-1}
///                   || t_{0,0} || t_{0,1} || ... || t_{N-1,0} || t_{N-1,1} || ctx
export function fsInputSigmaOr(
  a: Uint8Array,
  b: Uint8Array,
  branches: ReadonlyArray<SigmaOrStatementBranch>,
  commitments: ReadonlyArray<SigmaOrCommitment>,
  ctx: Uint8Array,
): Uint8Array {
  if (branches.length !== commitments.length) {
    throw new Error("branches and commitments must have matching length (= N)");
  }
  const N = branches.length;
  if (N < 2 || N > 0xff) {
    throw new Error(`sigma-OR width N=${N} out of range [2, 255]`);
  }
  const parts: Uint8Array[] = [
    DOMAIN_TAG_V1_BYTES,
    new Uint8Array([STATEMENT_ID_SIGMA_OR_N, N]),
    a,
    b,
  ];
  for (let i = 0; i < N; i++) {
    const br = branches[i]!;
    parts.push(br.ap, br.bp);
  }
  for (let i = 0; i < N; i++) {
    const c = commitments[i]!;
    parts.push(c.t0, c.t1);
  }
  parts.push(ctx);
  return concat(parts);
}

export function fsHashSigmaOr(
  a: Uint8Array,
  b: Uint8Array,
  branches: ReadonlyArray<SigmaOrStatementBranch>,
  commitments: ReadonlyArray<SigmaOrCommitment>,
  ctx: Uint8Array,
): Uint8Array {
  return blake2b256(fsInputSigmaOr(a, b, branches, commitments, ctx));
}
