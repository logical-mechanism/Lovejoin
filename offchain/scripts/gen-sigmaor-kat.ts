// Generate cross-language sigma-OR KAT vectors at N ∈ {2, 3, 4, 6, 8}.
//
// Per the M1 exit criteria (milestones.json) — and
// §"Test vectors" — the KAT file holds 200 vectors per N. Re-runnable; the same
// inputs always produce the same proof bytes (RFC 6979 + HKDF determinism).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCALAR_ORDER, generator, pointToBytes, scalarMul } from "../src/crypto/bls.js";
import { type DHTupleStatement, proveSigmaOr } from "../src/crypto/sigma_or.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const N_VALUES = [2, 3, 4, 6, 8];
const PER_N = 200;
// A focused subset is also embedded in Aiken — the full 200-per-N set runs in
// JS (cheap) but Aiken has a per-test cost budget so we keep its KATs small.
const AIKEN_PER_N = 8;

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngScalar(rng: () => number): bigint {
  // Build a 256-bit value, reduce mod (r-1), shift to [1, r) so it's a valid scalar.
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 32n) | BigInt(Math.floor(rng() * 0x1_0000_0000));
  return (v % (SCALAR_ORDER - 1n)) + 1n;
}

function rngBytes(rng: () => number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

type Vector = {
  N: number;
  a_scalar: string; // [a_scalar]·g produces `a`
  b_scalar: string;
  realIndex: number;
  witness: string;
  ctx: string;
  a: string;
  b: string;
  statements: { ap: string; bp: string }[];
  branches: { t0: string; t1: string; c: string; z: string }[];
};

function makeVector(N: number, rng: () => number): Vector {
  const aScalar = rngScalar(rng);
  const bScalar = rngScalar(rng);
  const a = scalarMul(aScalar, generator());
  const b = scalarMul(bScalar, generator());
  const witness = rngScalar(rng);
  const realIndex = Math.floor(rng() * N);
  const ctxLen = Math.floor(rng() * 33); // 0..32
  const ctx = rngBytes(rng, ctxLen);

  const statements: DHTupleStatement[] = [];
  for (let i = 0; i < N; i++) {
    if (i === realIndex) {
      statements.push({ ap: scalarMul(witness, a), bp: scalarMul(witness, b) });
    } else {
      const r1 = rngScalar(rng);
      const r2 = rngScalar(rng);
      statements.push({ ap: scalarMul(r1, a), bp: scalarMul(r2, b) });
    }
  }
  const proof = proveSigmaOr(a, b, statements, realIndex, witness, ctx);
  return {
    N,
    a_scalar: aScalar.toString(16),
    b_scalar: bScalar.toString(16),
    realIndex,
    witness: witness.toString(16),
    ctx: hex(ctx),
    a: hex(pointToBytes(a)),
    b: hex(pointToBytes(b)),
    statements: statements.map((s) => ({
      ap: hex(pointToBytes(s.ap)),
      bp: hex(pointToBytes(s.bp)),
    })),
    branches: proof.branches.map((br) => ({
      t0: hex(br.t0),
      t1: hex(br.t1),
      c: hex(br.c),
      z: hex(br.z),
    })),
  };
}

function aikenLit(h: string): string {
  return h.length === 0 ? `#""` : `#"${h}"`;
}

function emitAikenTest(v: Vector, idx: number): string {
  const stmts = v.statements
    .map((s) => `      sigma_or.DHTupleStatement { ap: ${aikenLit(s.ap)}, bp: ${aikenLit(s.bp)} },`)
    .join("\n");
  const branches = v.branches
    .map(
      (br) =>
        `      sigma_or.SigmaOrBranch { t0: ${aikenLit(br.t0)}, t1: ${aikenLit(br.t1)}, c: ${aikenLit(br.c)}, z: ${aikenLit(br.z)} },`,
    )
    .join("\n");
  return `test sigma_or_kat_n${v.N}_${idx}() {
  sigma_or.verify(
    ${aikenLit(v.a)},
    ${aikenLit(v.b)},
    [
${stmts}
    ],
    sigma_or.SigmaOrProof {
      branches: [
${branches}
      ],
    },
    ${aikenLit(v.ctx)},
  )
}`;
}

function emitAikenNegativeC(v: Vector, idx: number): string {
  // Flip a single bit in branches[0].c — the global XOR check must reject.
  const cArr = v.branches[0]!.c.match(/../g)!;
  cArr[0] = (parseInt(cArr[0]!, 16) ^ 0x80).toString(16).padStart(2, "0");
  const cBad = cArr.join("");
  const stmts = v.statements
    .map((s) => `      sigma_or.DHTupleStatement { ap: ${aikenLit(s.ap)}, bp: ${aikenLit(s.bp)} },`)
    .join("\n");
  const branches = v.branches
    .map(
      (br, i) =>
        `      sigma_or.SigmaOrBranch { t0: ${aikenLit(br.t0)}, t1: ${aikenLit(br.t1)}, c: ${aikenLit(i === 0 ? cBad : br.c)}, z: ${aikenLit(br.z)} },`,
    )
    .join("\n");
  return `test sigma_or_kat_neg_c_flip_n${v.N}_${idx}() fail {
  sigma_or.verify(
    ${aikenLit(v.a)},
    ${aikenLit(v.b)},
    [
${stmts}
    ],
    sigma_or.SigmaOrProof {
      branches: [
${branches}
      ],
    },
    ${aikenLit(v.ctx)},
  )
}`;
}

function main() {
  const allVecs: Vector[] = [];
  const rng = mulberry32(0xc0ffee01);
  for (const N of N_VALUES) {
    for (let i = 0; i < PER_N; i++) {
      allVecs.push(makeVector(N, rng));
    }
  }

  const jsonPath = resolve(REPO_ROOT, "crypto/test-vectors/sigma-or.json");
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(allVecs, null, 2) + "\n");

  // Aiken-side: take first AIKEN_PER_N from each N, plus negative companions.
  const aikenVecs = allVecs.filter((_, i) => {
    const idxInN = i % PER_N;
    return idxInN < AIKEN_PER_N;
  });
  const positives = aikenVecs.map((v, i) => emitAikenTest(v, i % AIKEN_PER_N)).join("\n\n");
  const negatives = aikenVecs.map((v, i) => emitAikenNegativeC(v, i % AIKEN_PER_N)).join("\n\n");
  const aikenPath = resolve(REPO_ROOT, "contracts/lib/lovejoin/sigma_or_kat.test.ak");
  const aikenSrc = `//// AUTO-GENERATED by offchain/scripts/gen-sigmaor-kat.ts. Do NOT edit by hand.
//// Re-run \`pnpm --filter @lovejoin/sdk run gen:sigmaor-kat\` to refresh.
////
//// Sigma-OR KATs at N ∈ {2, 3, 4, 6, 8}. The full ${PER_N}-vector-per-N set lives in
//// crypto/test-vectors/sigma-or.json (consumed by the TS verifier and Rust ref);
//// this file embeds ${AIKEN_PER_N}-per-N for the Aiken verifier — picked first to
//// keep aiken check time bounded, but each one is a faithful KAT.

use lovejoin/sigma_or

${positives}

${negatives}
`;
  writeFileSync(aikenPath, aikenSrc);

  console.log(`wrote ${allVecs.length} sigma-OR KATs to ${jsonPath}`);
  console.log(`wrote ${aikenVecs.length * 2} Aiken sigma-OR tests to ${aikenPath}`);
}

main();
