// KAT cross-verification: every vector in crypto/test-vectors/{provedlog,
// provedhtuple,sigma-or}.json must verify with the TS verifier. The Aiken
// verifier consumes the same vectors via the auto-generated *_kat.test.ak files;
// the Rust reference (crypto/ref/) re-derives the prover side independently and
// asserts byte-equality.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type G1Point, pointFromBytes } from "../../src/crypto/bls.js";
import { type DHTupleProof, verifyDHTuple } from "../../src/crypto/dhtuple.js";
import { type SchnorrProof, verifySchnorr } from "../../src/crypto/schnorr.js";
import {
  type DHTupleStatement,
  type SigmaOrProof,
  verifySigmaOr,
} from "../../src/crypto/sigma_or.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const VEC_DIR = resolve(HERE, "../../../crypto/test-vectors");

const bytes = (s: string): Uint8Array =>
  s.length === 0 ? new Uint8Array(0) : new Uint8Array(Buffer.from(s, "hex"));

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(VEC_DIR, name), "utf8")) as T;
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

describe("crypto/kat — Schnorr (provedlog.json)", () => {
  const cases = loadJson<SchnorrCase[]>("provedlog.json");

  it("loads at least 8 cases covering vanilla and custom-base shapes", () => {
    expect(cases.length).toBeGreaterThanOrEqual(8);
  });

  it("all positive vectors verify", () => {
    for (const c of cases) {
      const base = pointFromBytes(bytes(c.base));
      const u = pointFromBytes(bytes(c.u));
      const proof: SchnorrProof = { t: bytes(c.t), z: bytes(c.z) };
      expect(verifySchnorr(base, u, proof, bytes(c.ctx))).toBe(true);
    }
  });

  it("byte-flipped negatives are rejected", () => {
    // Tamper z[0] in each vector and re-check.
    for (const c of cases) {
      const base = pointFromBytes(bytes(c.base));
      const u = pointFromBytes(bytes(c.u));
      const z = bytes(c.z);
      z[0] ^= 0x01;
      expect(verifySchnorr(base, u, { t: bytes(c.t), z }, bytes(c.ctx))).toBe(false);
    }
  });
});

describe("crypto/kat — DHTuple (provedhtuple.json)", () => {
  const cases = loadJson<DHTupleCase[]>("provedhtuple.json");

  it("loads at least 8 cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(8);
  });

  it("all positive vectors verify", () => {
    for (const c of cases) {
      const proof: DHTupleProof = {
        t0: bytes(c.t0),
        t1: bytes(c.t1),
        z: bytes(c.z),
      };
      const ok = verifyDHTuple(
        pointFromBytes(bytes(c.g)),
        pointFromBytes(bytes(c.h)),
        pointFromBytes(bytes(c.u)),
        pointFromBytes(bytes(c.v)),
        proof,
        bytes(c.ctx),
      );
      expect(ok).toBe(true);
    }
  });

  it("byte-flipped negatives are rejected", () => {
    for (const c of cases) {
      const t0 = bytes(c.t0);
      t0[0] ^= 0x01;
      const ok = verifyDHTuple(
        pointFromBytes(bytes(c.g)),
        pointFromBytes(bytes(c.h)),
        pointFromBytes(bytes(c.u)),
        pointFromBytes(bytes(c.v)),
        { t0, t1: bytes(c.t1), z: bytes(c.z) },
        bytes(c.ctx),
      );
      expect(ok).toBe(false);
    }
  });
});

describe("crypto/kat — sigma-OR (sigma-or.json)", () => {
  const cases = loadJson<SigmaOrCase[]>("sigma-or.json");

  it("covers exactly 200 vectors per N ∈ {2, 3, 4, 6, 8}", () => {
    const counts: Record<number, number> = {};
    for (const c of cases) counts[c.N] = (counts[c.N] ?? 0) + 1;
    for (const N of [2, 3, 4, 6, 8]) expect(counts[N]).toBe(200);
    expect(cases.length).toBe(1000);
  });

  // Verifying 1000 sigma-OR proofs through @noble/curves BLS takes ~80s on
  // dev hardware (most of it noble scalar multiplications). For routine `pnpm
  // test` we sample evenly across N to stay under a minute; the full 1000 are
  // exercised end-to-end nightly via the integration suite.
  it("a representative sample (40 per N) verifies", () => {
    const SAMPLE_PER_N = 40;
    const seen: Record<number, number> = {};
    for (const c of cases) {
      seen[c.N] = (seen[c.N] ?? 0) + 1;
      if (seen[c.N]! > SAMPLE_PER_N) continue;
      const a = pointFromBytes(bytes(c.a));
      const b = pointFromBytes(bytes(c.b));
      const stmts: DHTupleStatement[] = c.statements.map((s) => ({
        ap: pointFromBytes(bytes(s.ap)) as G1Point,
        bp: pointFromBytes(bytes(s.bp)) as G1Point,
      }));
      const proof: SigmaOrProof = {
        branches: c.branches.map((br) => ({
          t0: bytes(br.t0),
          t1: bytes(br.t1),
          c: bytes(br.c),
          z: bytes(br.z),
        })),
      };
      expect(verifySigmaOr(a, b, stmts, proof, bytes(c.ctx))).toBe(true);
    }
  }, 60_000);

  it("XOR-tampered c_0 is rejected (smoke negative across all N values)", () => {
    const seenN = new Set<number>();
    for (const c of cases) {
      if (seenN.has(c.N)) continue;
      seenN.add(c.N);
      const a = pointFromBytes(bytes(c.a));
      const b = pointFromBytes(bytes(c.b));
      const stmts: DHTupleStatement[] = c.statements.map((s) => ({
        ap: pointFromBytes(bytes(s.ap)) as G1Point,
        bp: pointFromBytes(bytes(s.bp)) as G1Point,
      }));
      const branches = c.branches.map((br) => ({
        t0: bytes(br.t0),
        t1: bytes(br.t1),
        c: bytes(br.c),
        z: bytes(br.z),
      }));
      branches[0]!.c[0] ^= 0x80;
      expect(verifySigmaOr(a, b, stmts, { branches }, bytes(c.ctx))).toBe(false);
    }
    expect(seenN.size).toBe(5);
  });
});

describe("crypto/kat — negative.json (every entry MUST be rejected)", () => {
  type SchnorrNeg = SchnorrCase & { kind: "schnorr"; mutation: string };
  type DHTupleNeg = DHTupleCase & { kind: "dhtuple"; mutation: string };
  type SigmaOrNeg = SigmaOrCase & { kind: "sigma_or"; mutation: string };
  type Negative = SchnorrNeg | DHTupleNeg | SigmaOrNeg;
  const cases = loadJson<Negative[]>("negative.json");

  it("loads at least 100 negatives across protocols", () => {
    expect(cases.length).toBeGreaterThanOrEqual(100);
    const kinds = new Set(cases.map((c) => c.kind));
    expect(kinds.has("schnorr")).toBe(true);
    expect(kinds.has("dhtuple")).toBe(true);
    expect(kinds.has("sigma_or")).toBe(true);
  });

  // Tampering a point byte can produce a non-canonical compressed encoding;
  // pointFromBytes throws for those (the on-chain `bls12_381_g1_uncompress`
  // builtin behaves the same, surfacing as script failure). Treat a throw at
  // any stage as a "rejection" — the only way a negative passes is when both
  // parsing AND `verify*` return true.
  function rejected(fn: () => boolean): boolean {
    try {
      return !fn();
    } catch {
      return true;
    }
  }

  it("every Schnorr negative is rejected", () => {
    for (const c of cases) {
      if (c.kind !== "schnorr") continue;
      const ok = rejected(() =>
        verifySchnorr(
          pointFromBytes(bytes(c.base)),
          pointFromBytes(bytes(c.u)),
          { t: bytes(c.t), z: bytes(c.z) },
          bytes(c.ctx),
        ),
      );
      expect(ok, `Schnorr negative '${c.mutation}' should be rejected`).toBe(true);
    }
  });

  it("every DHTuple negative is rejected", () => {
    for (const c of cases) {
      if (c.kind !== "dhtuple") continue;
      const ok = rejected(() =>
        verifyDHTuple(
          pointFromBytes(bytes(c.g)),
          pointFromBytes(bytes(c.h)),
          pointFromBytes(bytes(c.u)),
          pointFromBytes(bytes(c.v)),
          { t0: bytes(c.t0), t1: bytes(c.t1), z: bytes(c.z) },
          bytes(c.ctx),
        ),
      );
      expect(ok, `DHTuple negative '${c.mutation}' should be rejected`).toBe(true);
    }
  });

  it("every sigma-OR negative is rejected", () => {
    for (const c of cases) {
      if (c.kind !== "sigma_or") continue;
      const ok = rejected(() => {
        const a = pointFromBytes(bytes(c.a));
        const b = pointFromBytes(bytes(c.b));
        const stmts: DHTupleStatement[] = c.statements.map((s) => ({
          ap: pointFromBytes(bytes(s.ap)) as G1Point,
          bp: pointFromBytes(bytes(s.bp)) as G1Point,
        }));
        const branches = c.branches.map((br) => ({
          t0: bytes(br.t0),
          t1: bytes(br.t1),
          c: bytes(br.c),
          z: bytes(br.z),
        }));
        return verifySigmaOr(a, b, stmts, { branches }, bytes(c.ctx));
      });
      expect(ok, `sigma-OR negative '${c.mutation}' should be rejected`).toBe(true);
    }
  }, 60_000);
});
