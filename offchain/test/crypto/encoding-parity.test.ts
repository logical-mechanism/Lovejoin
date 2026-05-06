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
const VECTORS_PATH = resolve(HERE, "../../../crypto/test-vectors/encoding-parity.json");

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
type OutputRefsVec = {
  kind: "output_refs";
  N: number;
  refs: { tx_id: string; output_index: number }[];
  expected_serialize: string;
};
type ParityVec = SchnorrVec | DHTupleVec | SigmaOrVec | OutputRefsVec;

const vectors: ParityVec[] = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as ParityVec[];

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

  it("output_refs vectors match expected_serialize for every N (audit F-4)", () => {
    // Mirrors the canonical Plutus-Data CBOR layout used in
    // gen-encoding-parity.ts's hand-roll. Aiken's `serialise_data` on a
    // `List<OutputReference>` must produce byte-identical output (verified
    // by encoding_parity_kat.test.ak); the runtime SDK helper
    // `serializeInputRefsList` (CST-based) is exercised by the Preprod
    // integration test, not here, because mesh's CST can't load under
    // the unit-test harness.
    const outputRefs = vectors.filter((v): v is OutputRefsVec => v.kind === "output_refs");
    expect(outputRefs.length).toBeGreaterThan(0);
    const seenN = new Set<number>();
    for (const v of outputRefs) {
      seenN.add(v.N);
      const re = encodeOutputRefList(
        v.refs.map((r) => ({ tx_id: bytes(r.tx_id), output_index: BigInt(r.output_index) })),
      );
      expect(hex(re)).toBe(v.expected_serialize);
    }
    // Cover single-input, common bulk-withdraw shape (2 + 3), and a wider 5.
    for (const expectedN of [1, 2, 3, 5]) {
      expect(seenN.has(expectedN)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Hand-rolled canonical Plutus-Data CBOR for `List<OutputReference>`. Mirrors
// `builtin.serialise_data` on the Aiken side and the encoder in
// offchain/scripts/gen-encoding-parity.ts. Used here to assert the JSON's
// `expected_serialize` is what we documented; the Aiken-side test asserts
// `builtin.serialise_data(...)` matches the same bytes, locking parity.
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
  const out = new Uint8Array(9);
  out[0] = 0x1b;
  for (let i = 7; i >= 0; i--) {
    out[1 + i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

function cborBytes(b: Uint8Array): Uint8Array {
  const len = b.length;
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
  out.set(b, header.length);
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
  return concatBytes([
    Uint8Array.of(0xd8, 0x79, 0x9f),
    cborBytes(txId),
    cborMinorInt(outputIndex),
    Uint8Array.of(0xff),
  ]);
}

function encodeOutputRefList(refs: { tx_id: Uint8Array; output_index: bigint }[]): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.of(0x9f)];
  for (const r of refs) parts.push(encodeOutputReference(r.tx_id, r.output_index));
  parts.push(Uint8Array.of(0xff));
  return concatBytes(parts);
}
