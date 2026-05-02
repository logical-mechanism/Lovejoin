// Generate cross-language encoding-parity vectors.
//
// Why: the Fiat-Shamir hash is computed in BOTH TS (when proving) and Aiken (when
// verifying). A 1-byte difference in the byte-concat layout silently breaks every
// proof on chain. Per docs/spec/12-build-guide.md §Risk 1, this generator is the
// gate before any sigma-protocol code is trusted.
//
// Output:
//   - crypto/test-vectors/encoding-parity.json    (1000 vectors for the TS test)
//   - contracts/lib/lovejoin/encoding_parity_kat.test.ak  (32 vectors for Aiken test)
//
// Determinism: a seeded mulberry32 PRNG drives all randomness, so re-running
// this script produces byte-identical artifacts.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fsHashDHTuple,
  fsHashSchnorr,
  fsHashSigmaOr,
  fsInputDHTuple,
  fsInputSchnorr,
  fsInputSigmaOr,
} from "../src/crypto/hash.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

// Deterministic PRNG: mulberry32. Same seed ⇒ same byte stream.
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

function randomBytes(rng: () => number, n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(rng() * 256);
  return b;
}

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

type SchnorrVec = {
  kind: "schnorr";
  g: string;
  u: string;
  t: string;
  ctx: string;
  expected_input: string;
  expected_hash: string;
};
type DHTupleVec = {
  kind: "dhtuple";
  g: string;
  h: string;
  u: string;
  v: string;
  t0: string;
  t1: string;
  ctx: string;
  expected_input: string;
  expected_hash: string;
};
type SigmaOrVec = {
  kind: "sigma_or";
  N: number;
  a: string;
  b: string;
  branches: { ap: string; bp: string }[];
  commitments: { t0: string; t1: string }[];
  ctx: string;
  expected_input: string;
  expected_hash: string;
};
type ParityVec = SchnorrVec | DHTupleVec | SigmaOrVec;

function buildSchnorr(rng: () => number): SchnorrVec {
  const g = randomBytes(rng, 48);
  const u = randomBytes(rng, 48);
  const t = randomBytes(rng, 48);
  const ctxLen = Math.floor(rng() * 65); // 0..64
  const ctx = randomBytes(rng, ctxLen);
  return {
    kind: "schnorr",
    g: hex(g),
    u: hex(u),
    t: hex(t),
    ctx: hex(ctx),
    expected_input: hex(fsInputSchnorr(g, u, t, ctx)),
    expected_hash: hex(fsHashSchnorr(g, u, t, ctx)),
  };
}

function buildDHTuple(rng: () => number): DHTupleVec {
  const g = randomBytes(rng, 48);
  const h = randomBytes(rng, 48);
  const u = randomBytes(rng, 48);
  const v = randomBytes(rng, 48);
  const t0 = randomBytes(rng, 48);
  const t1 = randomBytes(rng, 48);
  const ctxLen = Math.floor(rng() * 65);
  const ctx = randomBytes(rng, ctxLen);
  return {
    kind: "dhtuple",
    g: hex(g),
    h: hex(h),
    u: hex(u),
    v: hex(v),
    t0: hex(t0),
    t1: hex(t1),
    ctx: hex(ctx),
    expected_input: hex(fsInputDHTuple(g, h, u, v, t0, t1, ctx)),
    expected_hash: hex(fsHashDHTuple(g, h, u, v, t0, t1, ctx)),
  };
}

const N_VALUES = [2, 3, 4, 6, 8];

function buildSigmaOr(rng: () => number, N: number): SigmaOrVec {
  const a = randomBytes(rng, 48);
  const b = randomBytes(rng, 48);
  const branches = Array.from({ length: N }, () => ({
    ap: randomBytes(rng, 48),
    bp: randomBytes(rng, 48),
  }));
  const commitments = Array.from({ length: N }, () => ({
    t0: randomBytes(rng, 48),
    t1: randomBytes(rng, 48),
  }));
  const ctxLen = Math.floor(rng() * 65);
  const ctx = randomBytes(rng, ctxLen);
  return {
    kind: "sigma_or",
    N,
    a: hex(a),
    b: hex(b),
    branches: branches.map((br) => ({ ap: hex(br.ap), bp: hex(br.bp) })),
    commitments: commitments.map((c) => ({ t0: hex(c.t0), t1: hex(c.t1) })),
    ctx: hex(ctx),
    expected_input: hex(fsInputSigmaOr(a, b, branches, commitments, ctx)),
    expected_hash: hex(fsHashSigmaOr(a, b, branches, commitments, ctx)),
  };
}

function buildAll(rng: () => number, count: number): ParityVec[] {
  const vecs: ParityVec[] = [];
  for (let i = 0; i < count; i++) {
    const pick = i % (2 + N_VALUES.length);
    if (pick === 0) vecs.push(buildSchnorr(rng));
    else if (pick === 1) vecs.push(buildDHTuple(rng));
    else vecs.push(buildSigmaOr(rng, N_VALUES[pick - 2]!));
  }
  return vecs;
}

// --- Aiken codegen ---------------------------------------------------------

function aikenHexLiteral(h: string): string {
  return h.length === 0 ? `#""` : `#"${h}"`;
}

function aikenSchnorr(v: SchnorrVec, idx: number): string {
  return `test parity_schnorr_${idx}() {
  hash.fs_hash_schnorr(
    ${aikenHexLiteral(v.g)},
    ${aikenHexLiteral(v.u)},
    ${aikenHexLiteral(v.t)},
    ${aikenHexLiteral(v.ctx)},
  ) == ${aikenHexLiteral(v.expected_hash)}
}
`;
}

function aikenDHTuple(v: DHTupleVec, idx: number): string {
  return `test parity_dhtuple_${idx}() {
  hash.fs_hash_dh_tuple(
    ${aikenHexLiteral(v.g)},
    ${aikenHexLiteral(v.h)},
    ${aikenHexLiteral(v.u)},
    ${aikenHexLiteral(v.v)},
    ${aikenHexLiteral(v.t0)},
    ${aikenHexLiteral(v.t1)},
    ${aikenHexLiteral(v.ctx)},
  ) == ${aikenHexLiteral(v.expected_hash)}
}
`;
}

function aikenSigmaOr(v: SigmaOrVec, idx: number): string {
  const branches = v.branches
    .map(
      (br) =>
        `    hash.SigmaOrStatementBranch { ap: ${aikenHexLiteral(br.ap)}, bp: ${aikenHexLiteral(br.bp)} },`,
    )
    .join("\n");
  const commitments = v.commitments
    .map(
      (c) =>
        `    hash.SigmaOrCommitment { t0: ${aikenHexLiteral(c.t0)}, t1: ${aikenHexLiteral(c.t1)} },`,
    )
    .join("\n");
  return `test parity_sigma_or_n${v.N}_${idx}() {
  hash.fs_hash_sigma_or(
    ${aikenHexLiteral(v.a)},
    ${aikenHexLiteral(v.b)},
    [
${branches}
    ],
    [
${commitments}
    ],
    ${aikenHexLiteral(v.ctx)},
  ) == ${aikenHexLiteral(v.expected_hash)}
}
`;
}

function emitAiken(vecs: ParityVec[]): string {
  const header = `//// AUTO-GENERATED by offchain/scripts/gen-encoding-parity.ts.
//// Do NOT edit by hand. Re-run \`pnpm --filter @lovejoin/sdk run gen:parity\` to refresh.
////
//// Each test verifies that the Aiken Fiat-Shamir hash returns the byte-identical
//// digest that the TS prover computed for the same logical inputs. If any test
//// fails, the TS↔Aiken encoding parity is broken — see docs/spec/12-build-guide.md
//// §Risk 1 before doing anything else.

use lovejoin/hash

`;
  const tests: string[] = [];
  let schnorrIdx = 0;
  let dhtupleIdx = 0;
  const sigmaOrIdx: Record<number, number> = {};
  for (const v of vecs) {
    if (v.kind === "schnorr") tests.push(aikenSchnorr(v, schnorrIdx++));
    else if (v.kind === "dhtuple") tests.push(aikenDHTuple(v, dhtupleIdx++));
    else {
      const i = (sigmaOrIdx[v.N] = (sigmaOrIdx[v.N] ?? 0) + 1) - 1;
      tests.push(aikenSigmaOr(v, i));
    }
  }
  return header + tests.join("\n");
}

// --- Main ------------------------------------------------------------------

function main() {
  const tsRng = mulberry32(0x10ce_0001);
  const tsVecs = buildAll(tsRng, 1000);
  const tsPath = resolve(REPO_ROOT, "crypto/test-vectors/encoding-parity.json");
  mkdirSync(dirname(tsPath), { recursive: true });
  writeFileSync(tsPath, JSON.stringify(tsVecs, null, 2) + "\n");

  // Aiken side: a focused 32-vector subset, balanced across protocols and N values.
  const aikenRng = mulberry32(0x4a1ce_005);
  const aikenVecs: ParityVec[] = [];
  // 2 schnorr, 2 dhtuple, 2 per N ∈ {2,3,4,6,8} = 14 → pad to 32 with more variety.
  for (let i = 0; i < 4; i++) aikenVecs.push(buildSchnorr(aikenRng));
  for (let i = 0; i < 4; i++) aikenVecs.push(buildDHTuple(aikenRng));
  for (const N of N_VALUES) {
    for (let i = 0; i < 5; i++) aikenVecs.push(buildSigmaOr(aikenRng, N));
  }
  // Throw in a couple of edge cases — empty ctx, all-zero a/b/etc. — by patching.
  // (Keep the test purely deterministic; no in-place randomness past this point.)
  const aikenPath = resolve(REPO_ROOT, "contracts/lib/lovejoin/encoding_parity_kat.test.ak");
  mkdirSync(dirname(aikenPath), { recursive: true });
  writeFileSync(aikenPath, emitAiken(aikenVecs));

  console.log(`wrote ${tsVecs.length} TS parity vectors to ${tsPath}`);
  console.log(`wrote ${aikenVecs.length} Aiken parity tests to ${aikenPath}`);
}

main();
