// N-way sigma-OR proof (Cramer-Damgård OR composition; Sigmajoin paper Appendix C).
//
// Spec: docs/spec/02-cryptography.md §"N-way Sigma-OR (paper Appendix C, generalized)".
//
// Statement: prover knows a witness for at least one of N statements
//   τ_i = proveDHTuple(a, b, a'_i, b'_i),  i ∈ {0..N-1}.
// Witness: y such that (a'_b, b'_b) = ([y]·a, [y]·b) for the real branch b.
//
// Per-branch wire format (160 bytes each):
//   t_{i,0}: 48 bytes (compressed G1)
//   t_{i,1}: 48 bytes
//   c_i:     32 bytes (raw — XOR-composed, then reduced mod r for arithmetic)
//   z_i:     32 bytes (canonical scalar; verifier rejects if >= r)
//
// Prover (per spec §"N-way Sigma-OR"):
//   1. Real branch b: r_p = deriveNonce(...);  t_{b,*} = ([r_p]·a, [r_p]·b).
//   2. Simulated i ≠ b: derive c_i (32 raw bytes) and z_i ∈ [1, r) deterministically.
//      t_{i,0} = [z_i]·a − [c_i mod r]·a'_i;  t_{i,1} = [z_i]·b − [c_i mod r]·b'_i.
//   3. c = H(a, b, all (a'_i, b'_i), all t_{i,*}, ctx)  (32-byte digest).
//   4. c_b = c ⊕ (⊕_{i ≠ b} c_i)   (bytewise XOR, RAW bytes — NOT mod r).
//   5. z_b = (r_p + (c_b mod r) · y) mod r.
//
// Verifier:
//   * c == ⊕_{i=0..N-1} c_i  (bytewise).
//   * ∀ i: [z_i]·a == t_{i,0} + [c_i mod r]·a'_i  AND  [z_i]·b == t_{i,1} + [c_i mod r]·b'_i.

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  type G1Point,
  G1_COMPRESSED_BYTES,
  SCALAR_BYTES,
  SCALAR_ORDER,
  type Scalar,
  bytesToBigIntBE,
  pointAdd,
  pointEqual,
  pointFromBytes,
  pointSub,
  pointToBytes,
  reduceScalar,
  scalarMul,
  scalarToBytes,
} from "./bls.js";
import { type SigmaOrCommitment, type SigmaOrStatementBranch, fsHashSigmaOr } from "./hash.js";
import { deriveNonce } from "./nonce.js";

export type SigmaOrBranchProof = {
  t0: Uint8Array; // 48 bytes
  t1: Uint8Array; // 48 bytes
  c: Uint8Array; // 32 bytes (raw)
  z: Uint8Array; // 32 bytes (canonical scalar)
};

export type SigmaOrProof = {
  branches: SigmaOrBranchProof[]; // length = N
};

export type DHTupleStatement = {
  ap: G1Point; // a'_i
  bp: G1Point; // b'_i
};

const TAG_REAL = new TextEncoder().encode("lovejoin/sigma-or/real-r/v1");
const TAG_SIM_C = new TextEncoder().encode("lovejoin/sigma-or/sim-c/v1");
const TAG_SIM_Z = new TextEncoder().encode("lovejoin/sigma-or/sim-z/v1");

function u32be(x: number): Uint8Array {
  return new Uint8Array([(x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff]);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
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

function xorInPlace(a: Uint8Array, b: Uint8Array): void {
  if (a.length !== b.length) throw new Error("XOR operand length mismatch");
  for (let i = 0; i < a.length; i++) a[i] = a[i]! ^ b[i]!;
}

function xorAll(parts: Uint8Array[], len = 32): Uint8Array {
  const acc = new Uint8Array(len);
  for (const p of parts) xorInPlace(acc, p);
  return acc;
}

/**
 * Build the message that pins per-branch derivation. Distinct (statement, ctx,
 * branch index, role) ⇒ distinct nonce/scalar, so simulated and real values
 * cannot collide across branches or across distinct mix proofs.
 */
function nonceBindingMessage(
  a: Uint8Array,
  b: Uint8Array,
  statements: ReadonlyArray<DHTupleStatement>,
  ctx: Uint8Array,
): Uint8Array {
  const parts: Uint8Array[] = [a, b];
  for (const s of statements) {
    parts.push(pointToBytes(s.ap), pointToBytes(s.bp));
  }
  parts.push(ctx);
  return concatBytes(...parts);
}

/** Generate an N-way sigma-OR proof. The caller MUST hold the witness for branch
 *  `realIndex`; behavior on a wrong witness is "proof fails verification" (we
 *  don't sanity-check here to avoid timing leaks of the witness location). */
export function proveSigmaOr(
  a: G1Point,
  b: G1Point,
  statements: ReadonlyArray<DHTupleStatement>,
  realIndex: number,
  witness: Scalar,
  ctx: Uint8Array,
): SigmaOrProof {
  const N = statements.length;
  if (N < 2) throw new Error(`sigma-OR needs N >= 2, got ${N}`);
  if (realIndex < 0 || realIndex >= N) {
    throw new Error(`realIndex ${realIndex} out of range [0, ${N})`);
  }
  if (witness <= 0n || witness >= SCALAR_ORDER) {
    throw new Error("witness must be in [1, r)");
  }

  const aBytes = pointToBytes(a);
  const bBytes = pointToBytes(b);
  const stmtBytes = statements.map((s) => ({
    ap: pointToBytes(s.ap),
    bp: pointToBytes(s.bp),
  }));
  const baseMsg = nonceBindingMessage(aBytes, bBytes, statements, ctx);
  const witnessBytes = scalarToBytes(witness);

  // Prepare per-branch slots; we'll populate t0/t1 below.
  const t0Pts: G1Point[] = new Array(N);
  const t1Pts: G1Point[] = new Array(N);
  const cPerBranch: Uint8Array[] = new Array(N);
  const zPerBranch: Scalar[] = new Array(N);

  // Real branch: pick r_p, t_{b,*} = ([r_p]·a, [r_p]·b).
  const realMsg = concatBytes(baseMsg, u32be(realIndex), TAG_REAL);
  const r_p = deriveNonce(witness, realMsg);
  t0Pts[realIndex] = scalarMul(r_p, a);
  t1Pts[realIndex] = scalarMul(r_p, b);
  // c_b and z_b filled in after the global challenge is computed.

  // Simulated branches.
  for (let i = 0; i < N; i++) {
    if (i === realIndex) continue;
    const cMsg = concatBytes(baseMsg, u32be(i), TAG_SIM_C);
    const zMsg = concatBytes(baseMsg, u32be(i), TAG_SIM_Z);
    const c_i = hmac(sha256, witnessBytes, cMsg); // 32 bytes raw
    const z_i = deriveNonce(witness, zMsg);
    cPerBranch[i] = c_i;
    zPerBranch[i] = z_i;

    const cMod = reduceScalar(bytesToBigIntBE(c_i));
    // t_{i,0} = [z_i]·a − [c_i mod r]·a'_i
    t0Pts[i] = pointSub(scalarMul(z_i, a), scalarMul(cMod, statements[i]!.ap));
    // t_{i,1} = [z_i]·b − [c_i mod r]·b'_i
    t1Pts[i] = pointSub(scalarMul(z_i, b), scalarMul(cMod, statements[i]!.bp));
  }

  // Compute global challenge c.
  const t0Bytes = t0Pts.map((p) => pointToBytes(p));
  const t1Bytes = t1Pts.map((p) => pointToBytes(p));
  const cGlobal = fsHashSigmaOr(
    aBytes,
    bBytes,
    stmtBytes as ReadonlyArray<SigmaOrStatementBranch>,
    t0Bytes.map((t0, i) => ({ t0, t1: t1Bytes[i]! })) as ReadonlyArray<SigmaOrCommitment>,
    ctx,
  );

  // c_b = c XOR (XOR of all simulated c_i).
  const xorOfSims = xorAll(cPerBranch.flatMap((v, i) => (i === realIndex ? [] : [v])));
  const c_b = new Uint8Array(cGlobal);
  xorInPlace(c_b, xorOfSims);
  cPerBranch[realIndex] = c_b;

  // z_b = (r_p + (c_b mod r) * y) mod r.
  const cBMod = reduceScalar(bytesToBigIntBE(c_b));
  zPerBranch[realIndex] = (r_p + ((cBMod * witness) % SCALAR_ORDER)) % SCALAR_ORDER;

  const branches: SigmaOrBranchProof[] = [];
  for (let i = 0; i < N; i++) {
    branches.push({
      t0: t0Bytes[i]!,
      t1: t1Bytes[i]!,
      c: cPerBranch[i]!,
      z: scalarToBytes(zPerBranch[i]!),
    });
  }
  return { branches };
}

/** Verify an N-way sigma-OR proof. Returns false on any structural defect. */
export function verifySigmaOr(
  a: G1Point,
  b: G1Point,
  statements: ReadonlyArray<DHTupleStatement>,
  proof: SigmaOrProof,
  ctx: Uint8Array,
): boolean {
  const N = statements.length;
  if (N < 2) return false;
  if (proof.branches.length !== N) return false;
  for (const br of proof.branches) {
    if (br.t0.length !== G1_COMPRESSED_BYTES) return false;
    if (br.t1.length !== G1_COMPRESSED_BYTES) return false;
    if (br.c.length !== 32) return false;
    if (br.z.length !== SCALAR_BYTES) return false;
  }

  const aBytes = pointToBytes(a);
  const bBytes = pointToBytes(b);
  const stmtBytes = statements.map((s) => ({
    ap: pointToBytes(s.ap),
    bp: pointToBytes(s.bp),
  }));
  const commitments = proof.branches.map((br) => ({ t0: br.t0, t1: br.t1 }));

  // Recompute global challenge.
  const cGlobal = fsHashSigmaOr(aBytes, bBytes, stmtBytes, commitments, ctx);

  // c == XOR_i c_i (bytewise).
  const xorOfBranchC = xorAll(proof.branches.map((br) => br.c));
  for (let i = 0; i < 32; i++) {
    if (cGlobal[i] !== xorOfBranchC[i]) return false;
  }

  // Per-branch equations.
  for (let i = 0; i < N; i++) {
    const br = proof.branches[i]!;
    const stmt = statements[i]!;
    const z = bytesToBigIntBE(br.z);
    if (z >= SCALAR_ORDER) return false;
    let t0: G1Point;
    let t1: G1Point;
    try {
      t0 = pointFromBytes(br.t0);
      t1 = pointFromBytes(br.t1);
    } catch {
      return false;
    }
    const cMod = reduceScalar(bytesToBigIntBE(br.c));
    // [z]·a == t0 + [c]·a'_i
    if (!pointEqual(scalarMul(z, a), pointAdd(t0, scalarMul(cMod, stmt.ap)))) return false;
    // [z]·b == t1 + [c]·b'_i
    if (!pointEqual(scalarMul(z, b), pointAdd(t1, scalarMul(cMod, stmt.bp)))) return false;
  }
  return true;
}
