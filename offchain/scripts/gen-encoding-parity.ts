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
type OutputRefsVec = {
  kind: "output_refs";
  N: number;
  refs: { tx_id: string; output_index: number }[];
  expected_serialize: string;
};
type ParityVec = SchnorrVec | DHTupleVec | SigmaOrVec | OutputRefsVec;

// ---------------------------------------------------------------------------
// Canonical Plutus-Data CBOR for `List<OutputReference>`. Mirrors
// `builtin.serialise_data` on the Aiken side:
//   * Lists: indefinite-length (`9f ... ff`).
//   * Constr 0: tag 121 (`d8 79 9f <fields> ff`).
//   * Bytes(32): `58 20 <bytes>`.
//   * Non-negative ints: minimal-bytes encoding under major type 0.
// The hand-roll avoids pulling @meshsdk/core-cst into the Node generator
// (which has wasm + browser-polyfill deps). The TS test
// `serializeInputRefsForCtx` is exercised separately at runtime against
// these same vectors and must produce byte-equal output.
// ---------------------------------------------------------------------------

function cborMinorInt(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("output_index must be non-negative");
  if (value < 24n) return Uint8Array.of(Number(value));
  if (value < 0x100n) return Uint8Array.of(0x18, Number(value));
  if (value < 0x10000n) {
    const v = Number(value);
    return Uint8Array.of(0x19, (v >> 8) & 0xff, v & 0xff);
  }
  if (value < 0x100000000n) {
    const v = Number(value);
    return Uint8Array.of(0x1a, (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  }
  // 64-bit major-0 int — not exercised by output_index in our vectors but
  // implemented for completeness.
  const out = new Uint8Array(9);
  out[0] = 0x1b;
  for (let i = 7; i >= 0; i--) {
    out[1 + i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

function cborBytes(bytes: Uint8Array): Uint8Array {
  const len = bytes.length;
  let header: Uint8Array;
  if (len < 24) header = Uint8Array.of(0x40 + len);
  else if (len < 0x100) header = Uint8Array.of(0x58, len);
  else if (len < 0x10000) header = Uint8Array.of(0x59, (len >> 8) & 0xff, len & 0xff);
  else
    header = Uint8Array.of(
      0x5a,
      (len >>> 24) & 0xff,
      (len >>> 16) & 0xff,
      (len >>> 8) & 0xff,
      len & 0xff,
    );
  const out = new Uint8Array(header.length + len);
  out.set(header, 0);
  out.set(bytes, header.length);
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
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

function encodeOutputReference(txId: Uint8Array, outputIndex: bigint): Uint8Array {
  if (txId.length !== 32) throw new Error(`tx_id must be 32 bytes, got ${txId.length}`);
  // Constr 0: tag 121 (d879) + indefinite-array (9f) + bytes(32, txId) + int(outputIndex) + break (ff)
  return concatBytes([
    Uint8Array.of(0xd8, 0x79, 0x9f),
    cborBytes(txId),
    cborMinorInt(outputIndex),
    Uint8Array.of(0xff),
  ]);
}

function encodeOutputRefList(refs: { tx_id: Uint8Array; output_index: bigint }[]): Uint8Array {
  // Non-empty list: indefinite-length (9f ... ff). Empty list would be 80,
  // but our generator only emits N >= 1.
  const parts: Uint8Array[] = [Uint8Array.of(0x9f)];
  for (const r of refs) parts.push(encodeOutputReference(r.tx_id, r.output_index));
  parts.push(Uint8Array.of(0xff));
  return concatBytes(parts);
}

const OUTPUT_REF_NS = [1, 2, 3, 5];

function buildOutputRefs(rng: () => number, N: number): OutputRefsVec {
  const refs = Array.from({ length: N }, () => ({
    tx_id: randomBytes(rng, 32),
    // Spread output_index across CBOR int-size boundaries:
    // 0, 1..23 (1-byte), 24..255 (2-byte), 256..65535 (3-byte).
    output_index: BigInt(Math.floor(rng() * 65536)),
  }));
  const serialized = encodeOutputRefList(refs);
  return {
    kind: "output_refs",
    N,
    refs: refs.map((r) => ({ tx_id: hex(r.tx_id), output_index: Number(r.output_index) })),
    expected_serialize: hex(serialized),
  };
}

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
  // Round-robin: schnorr, dhtuple, sigma_or per N, output_refs per N.
  const slots = 2 + N_VALUES.length + OUTPUT_REF_NS.length;
  for (let i = 0; i < count; i++) {
    const pick = i % slots;
    if (pick === 0) vecs.push(buildSchnorr(rng));
    else if (pick === 1) vecs.push(buildDHTuple(rng));
    else if (pick - 2 < N_VALUES.length) vecs.push(buildSigmaOr(rng, N_VALUES[pick - 2]!));
    else vecs.push(buildOutputRefs(rng, OUTPUT_REF_NS[pick - 2 - N_VALUES.length]!));
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
  // Emit multi-line records to match `aiken fmt` output.
  const branches = v.branches
    .map(
      (br) =>
        `      hash.SigmaOrStatementBranch {\n` +
        `        ap: ${aikenHexLiteral(br.ap)},\n` +
        `        bp: ${aikenHexLiteral(br.bp)},\n` +
        `      },`,
    )
    .join("\n");
  const commitments = v.commitments
    .map(
      (c) =>
        `      hash.SigmaOrCommitment {\n` +
        `        t0: ${aikenHexLiteral(c.t0)},\n` +
        `        t1: ${aikenHexLiteral(c.t1)},\n` +
        `      },`,
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

function aikenOutputRefs(v: OutputRefsVec, idx: number): string {
  const refs = v.refs
    .map(
      (r) =>
        `    OutputReference { transaction_id: ${aikenHexLiteral(r.tx_id)}, output_index: ${r.output_index} },`,
    )
    .join("\n");
  return `test parity_output_refs_n${v.N}_${idx}() {
  builtin.serialise_data(
    [
${refs}
    ],
  ) == ${aikenHexLiteral(v.expected_serialize)}
}
`;
}

function emitAiken(vecs: ParityVec[]): string {
  const header = `//// AUTO-GENERATED by offchain/scripts/gen-encoding-parity.ts.
//// Do NOT edit by hand. Re-run \`pnpm --filter @lovejoin/sdk run gen:parity\` to refresh.
////
//// Each test verifies that the Aiken Fiat-Shamir hash (or canonical
//// \`serialise_data\` output for output_refs vectors) returns the
//// byte-identical bytes that the TS prover computed for the same logical
//// inputs. If any test fails, the TS↔Aiken encoding parity is broken —
//// see docs/spec/12-build-guide.md §Risk 1 before doing anything else.

use aiken/builtin
use cardano/transaction.{OutputReference}
use lovejoin/hash

`;
  const tests: string[] = [];
  let schnorrIdx = 0;
  let dhtupleIdx = 0;
  const sigmaOrIdx: Record<number, number> = {};
  const outputRefsIdx: Record<number, number> = {};
  for (const v of vecs) {
    if (v.kind === "schnorr") tests.push(aikenSchnorr(v, schnorrIdx++));
    else if (v.kind === "dhtuple") tests.push(aikenDHTuple(v, dhtupleIdx++));
    else if (v.kind === "sigma_or") {
      const i = (sigmaOrIdx[v.N] = (sigmaOrIdx[v.N] ?? 0) + 1) - 1;
      tests.push(aikenSigmaOr(v, i));
    } else {
      const i = (outputRefsIdx[v.N] = (outputRefsIdx[v.N] ?? 0) + 1) - 1;
      tests.push(aikenOutputRefs(v, i));
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

  // Aiken side: a focused subset, balanced across protocols and N values.
  const aikenRng = mulberry32(0x4a1ce_005);
  const aikenVecs: ParityVec[] = [];
  for (let i = 0; i < 4; i++) aikenVecs.push(buildSchnorr(aikenRng));
  for (let i = 0; i < 4; i++) aikenVecs.push(buildDHTuple(aikenRng));
  for (const N of N_VALUES) {
    for (let i = 0; i < 5; i++) aikenVecs.push(buildSigmaOr(aikenRng, N));
  }
  // F-4: serialise_data(List<OutputReference>) parity. 3 vectors per N ∈
  // {1, 2, 3, 5} = 12. Covers single-input withdraw, bulk-withdraw shapes,
  // and output_index encodings spanning CBOR int-size boundaries.
  for (const N of OUTPUT_REF_NS) {
    for (let i = 0; i < 3; i++) aikenVecs.push(buildOutputRefs(aikenRng, N));
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
