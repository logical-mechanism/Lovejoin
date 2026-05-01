// Generate `crypto/test-vectors/negative.json` — proofs that MUST be rejected
// by every conforming verifier (TS, Aiken, Rust ref).
//
// Each entry mutates a known-good positive vector at exactly one byte, with the
// `mutation` field documenting *what* was tampered. The TS test loads this file
// and asserts every entry rejects; the Aiken and Rust ref do the same.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const VEC = resolve(REPO_ROOT, "crypto/test-vectors");

function flipFirstByte(h: string): string {
  const arr = h.match(/../g) ?? [];
  if (arr.length === 0) return "";
  arr[0] = (parseInt(arr[0]!, 16) ^ 0x01).toString(16).padStart(2, "0");
  return arr.join("");
}

type SchnorrCase = {
  base: string;
  u: string;
  t: string;
  z: string;
  ctx: string;
};
type DHTupleCase = {
  g: string;
  h: string;
  u: string;
  v: string;
  t0: string;
  t1: string;
  z: string;
  ctx: string;
};
type SigmaOrCase = {
  N: number;
  a: string;
  b: string;
  ctx: string;
  statements: { ap: string; bp: string }[];
  branches: { t0: string; t1: string; c: string; z: string }[];
};

type Negative =
  | ({ kind: "schnorr"; mutation: string } & SchnorrCase)
  | ({ kind: "dhtuple"; mutation: string } & DHTupleCase)
  | ({ kind: "sigma_or"; mutation: string } & SigmaOrCase);

const negatives: Negative[] = [];

const schnorrPositives = JSON.parse(
  readFileSync(resolve(VEC, "provedlog.json"), "utf8"),
) as SchnorrCase[];
const dhtuplePositives = JSON.parse(
  readFileSync(resolve(VEC, "provedhtuple.json"), "utf8"),
) as DHTupleCase[];
const sigmaPositives = JSON.parse(
  readFileSync(resolve(VEC, "sigma-or.json"), "utf8"),
) as SigmaOrCase[];

// Schnorr: tamper t and z (one negative per).
for (const p of schnorrPositives.slice(0, 8)) {
  negatives.push({
    kind: "schnorr",
    mutation: "flip first byte of t",
    ...p,
    t: flipFirstByte(p.t),
  });
  negatives.push({
    kind: "schnorr",
    mutation: "flip first byte of z",
    ...p,
    z: flipFirstByte(p.z),
  });
  negatives.push({
    kind: "schnorr",
    mutation: "flip first byte of ctx",
    ...p,
    ctx: p.ctx.length === 0 ? "00" : flipFirstByte(p.ctx),
  });
}

// DHTuple: tamper t0, t1, z, v.
for (const p of dhtuplePositives.slice(0, 8)) {
  negatives.push({
    kind: "dhtuple",
    mutation: "flip first byte of t0",
    ...p,
    t0: flipFirstByte(p.t0),
  });
  negatives.push({
    kind: "dhtuple",
    mutation: "flip first byte of t1",
    ...p,
    t1: flipFirstByte(p.t1),
  });
  negatives.push({
    kind: "dhtuple",
    mutation: "flip first byte of z",
    ...p,
    z: flipFirstByte(p.z),
  });
  negatives.push({
    kind: "dhtuple",
    mutation: "flip first byte of v",
    ...p,
    v: flipFirstByte(p.v),
  });
}

// Sigma-OR: tamper c[0] (breaks XOR), z[0] (breaks per-branch eq), t0[0] of branch 0.
// (No-op selection pass intentionally left for future-N expansion; the
//  real per-mutation work happens in the loop below.)
for (const _p of sigmaPositives) {
  // Take 4 per N value.
  // (Selection: simply take some indices that hit each N.)
}
const seenN: Record<number, number> = {};
for (const p of sigmaPositives) {
  if ((seenN[p.N] ?? 0) >= 4) continue;
  seenN[p.N] = (seenN[p.N] ?? 0) + 1;
  // Mutation A: flip c[0] of branch 0.
  const aBranches = p.branches.map((br, i) =>
    i === 0 ? { ...br, c: flipFirstByte(br.c) } : br,
  );
  negatives.push({
    kind: "sigma_or",
    mutation: "branch[0].c first-byte flip (breaks XOR check)",
    ...p,
    branches: aBranches,
  });
  // Mutation B: flip z[0] of branch 0.
  const bBranches = p.branches.map((br, i) =>
    i === 0 ? { ...br, z: flipFirstByte(br.z) } : br,
  );
  negatives.push({
    kind: "sigma_or",
    mutation: "branch[0].z first-byte flip",
    ...p,
    branches: bBranches,
  });
  // Mutation C: flip t0[0] of branch 0.
  const cBranches = p.branches.map((br, i) =>
    i === 0 ? { ...br, t0: flipFirstByte(br.t0) } : br,
  );
  negatives.push({
    kind: "sigma_or",
    mutation: "branch[0].t0 first-byte flip",
    ...p,
    branches: cBranches,
  });
}

writeFileSync(resolve(VEC, "negative.json"), JSON.stringify(negatives, null, 2) + "\n");
console.log(`wrote ${negatives.length} negative vectors to crypto/test-vectors/negative.json`);
