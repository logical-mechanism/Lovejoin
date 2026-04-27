// Encoding-parity test for the Fiat-Shamir construction.
//
// docs/spec/12-build-guide.md §Risk 1: the FS hash is computed in BOTH TS and
// Aiken; a single-byte mismatch silently breaks every proof on chain. This file
// covers the TS side of that contract:
//
//   1. The fixtures at crypto/test-vectors/encoding-parity.json are consumed by
//      this test AND by contracts/lib/lovejoin/encoding_parity_kat.test.ak.
//   2. We re-derive `expected_input` and `expected_hash` from the logical inputs
//      using the production code (`fsInput*` / `fsHash*`) and assert byte-equal.
//      If this test passes locally and the Aiken test fails in CI, the layout
//      logic in the Aiken module is the culprit, not the JSON.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  fsHashDHTuple,
  fsHashSchnorr,
  fsHashSigmaOr,
  fsInputDHTuple,
  fsInputSchnorr,
  fsInputSigmaOr,
} from "../../src/crypto/hash.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const VECTORS_PATH = resolve(
  HERE,
  "../../../crypto/test-vectors/encoding-parity.json",
);

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (s: string): Uint8Array =>
  s.length === 0 ? new Uint8Array(0) : new Uint8Array(Buffer.from(s, "hex"));

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

const vectors: ParityVec[] = JSON.parse(
  readFileSync(VECTORS_PATH, "utf8"),
) as ParityVec[];

describe("crypto/hash — encoding parity (1000 vectors, TS side)", () => {
  it("loads exactly 1000 vectors from the canonical JSON file", () => {
    expect(vectors.length).toBe(1000);
  });

  it("schnorr vectors match expected_input and expected_hash", () => {
    const schnorr = vectors.filter((v): v is SchnorrVec => v.kind === "schnorr");
    expect(schnorr.length).toBeGreaterThan(0);
    for (const v of schnorr) {
      const inp = fsInputSchnorr(bytes(v.g), bytes(v.u), bytes(v.t), bytes(v.ctx));
      expect(hex(inp)).toBe(v.expected_input);
      const h = fsHashSchnorr(bytes(v.g), bytes(v.u), bytes(v.t), bytes(v.ctx));
      expect(hex(h)).toBe(v.expected_hash);
    }
  });

  it("dhtuple vectors match expected_input and expected_hash", () => {
    const dhtuple = vectors.filter((v): v is DHTupleVec => v.kind === "dhtuple");
    expect(dhtuple.length).toBeGreaterThan(0);
    for (const v of dhtuple) {
      const inp = fsInputDHTuple(
        bytes(v.g),
        bytes(v.h),
        bytes(v.u),
        bytes(v.v),
        bytes(v.t0),
        bytes(v.t1),
        bytes(v.ctx),
      );
      expect(hex(inp)).toBe(v.expected_input);
      const h = fsHashDHTuple(
        bytes(v.g),
        bytes(v.h),
        bytes(v.u),
        bytes(v.v),
        bytes(v.t0),
        bytes(v.t1),
        bytes(v.ctx),
      );
      expect(hex(h)).toBe(v.expected_hash);
    }
  });

  it("sigma-or vectors match expected_input and expected_hash for every N", () => {
    const sigmaOr = vectors.filter((v): v is SigmaOrVec => v.kind === "sigma_or");
    expect(sigmaOr.length).toBeGreaterThan(0);
    const seenN = new Set<number>();
    for (const v of sigmaOr) {
      seenN.add(v.N);
      const branches = v.branches.map((br) => ({ ap: bytes(br.ap), bp: bytes(br.bp) }));
      const commitments = v.commitments.map((c) => ({ t0: bytes(c.t0), t1: bytes(c.t1) }));
      const inp = fsInputSigmaOr(bytes(v.a), bytes(v.b), branches, commitments, bytes(v.ctx));
      expect(hex(inp)).toBe(v.expected_input);
      const h = fsHashSigmaOr(bytes(v.a), bytes(v.b), branches, commitments, bytes(v.ctx));
      expect(hex(h)).toBe(v.expected_hash);
    }
    // Spec calls for variable-N coverage at exactly these widths.
    for (const expectedN of [2, 3, 4, 6, 8]) {
      expect(seenN.has(expectedN)).toBe(true);
    }
  });
});
