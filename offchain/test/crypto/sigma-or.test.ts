import { describe, expect, it } from "vitest";
import {
  G1_COMPRESSED_BYTES,
  SCALAR_BYTES,
  generator,
  scalarMul,
} from "../../src/crypto/bls.js";
import {
  type DHTupleStatement,
  proveSigmaOr,
  verifySigmaOr,
} from "../../src/crypto/sigma_or.js";

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (s: string): Uint8Array =>
  s.length === 0 ? new Uint8Array(0) : new Uint8Array(Buffer.from(s, "hex"));

/**
 * Build an N-statement test vector where branch `realIndex` has `(a'_b, b'_b) =
 * ([y]·a, [y]·b)` (so the prover's witness is valid) and the other N-1 branches
 * are picked from independent random discrete logs (no DH-tuple relation to y).
 */
function makeStatements(
  N: number,
  a: ReturnType<typeof generator>,
  b: ReturnType<typeof generator>,
  realIndex: number,
  witness: bigint,
): DHTupleStatement[] {
  const out: DHTupleStatement[] = [];
  for (let i = 0; i < N; i++) {
    if (i === realIndex) {
      out.push({ ap: scalarMul(witness, a), bp: scalarMul(witness, b) });
    } else {
      // Independent: ap = [r1]·a, bp = [r2]·b with r1 != r2 → not a DH-tuple
      // under (a, b). The prover doesn't know any witness for these branches.
      const r1 = BigInt(0x1000 + i);
      const r2 = BigInt(0x2000 + i);
      out.push({ ap: scalarMul(r1, a), bp: scalarMul(r2, b) });
    }
  }
  return out;
}

describe("crypto/sigma_or — variable-N proofs verify across N ∈ {2..8}", () => {
  for (const N of [2, 3, 4, 6, 8]) {
    it(`accepts a fresh proof at N=${N} for every realIndex`, () => {
      const a = scalarMul(0xa1n, generator());
      const b = scalarMul(0xb1n, generator());
      const witness = 0x77n;
      const ctx = bytes("aa55");
      for (let realIndex = 0; realIndex < N; realIndex++) {
        const statements = makeStatements(N, a, b, realIndex, witness);
        const proof = proveSigmaOr(a, b, statements, realIndex, witness, ctx);
        expect(proof.branches.length).toBe(N);
        for (const br of proof.branches) {
          expect(br.t0.length).toBe(G1_COMPRESSED_BYTES);
          expect(br.t1.length).toBe(G1_COMPRESSED_BYTES);
          expect(br.c.length).toBe(32);
          expect(br.z.length).toBe(SCALAR_BYTES);
        }
        expect(verifySigmaOr(a, b, statements, proof, ctx)).toBe(true);
      }
    });
  }
});

describe("crypto/sigma_or — RFC-6979 / HKDF determinism", () => {
  it("same (witness, statements, realIndex, ctx) ⇒ byte-identical proof", () => {
    const a = scalarMul(2n, generator());
    const b = scalarMul(3n, generator());
    const witness = 0x42n;
    const ctx = bytes("ff");
    const stmts = makeStatements(4, a, b, 1, witness);
    const p1 = proveSigmaOr(a, b, stmts, 1, witness, ctx);
    const p2 = proveSigmaOr(a, b, stmts, 1, witness, ctx);
    expect(p1.branches.length).toBe(p2.branches.length);
    for (let i = 0; i < p1.branches.length; i++) {
      expect(hex(p1.branches[i]!.t0)).toBe(hex(p2.branches[i]!.t0));
      expect(hex(p1.branches[i]!.t1)).toBe(hex(p2.branches[i]!.t1));
      expect(hex(p1.branches[i]!.c)).toBe(hex(p2.branches[i]!.c));
      expect(hex(p1.branches[i]!.z)).toBe(hex(p2.branches[i]!.z));
    }
  });
});

describe("crypto/sigma_or — negative cases (verifier rejects malformed/tampered)", () => {
  function setup(N: number, realIndex: number) {
    const a = scalarMul(2n, generator());
    const b = scalarMul(3n, generator());
    const witness = 0x99n;
    const ctx = bytes("");
    const stmts = makeStatements(N, a, b, realIndex, witness);
    const proof = proveSigmaOr(a, b, stmts, realIndex, witness, ctx);
    return { a, b, witness, ctx, stmts, proof };
  }

  it("rejects when N < 2", () => {
    const { a, b, witness, ctx } = setup(3, 0);
    const onlyOne = makeStatements(1, a, b, 0, witness);
    const proof = { branches: [setup(3, 0).proof.branches[0]!] };
    expect(verifySigmaOr(a, b, onlyOne, proof, ctx)).toBe(false);
  });

  it("rejects mismatched branch count vs statement count", () => {
    const { a, b, ctx, stmts, proof } = setup(4, 1);
    const truncated = { branches: proof.branches.slice(0, 3) };
    expect(verifySigmaOr(a, b, stmts, truncated, ctx)).toBe(false);
  });

  it("rejects when a per-branch c_i has wrong length", () => {
    const { a, b, ctx, stmts, proof } = setup(3, 1);
    const malformed = {
      branches: proof.branches.map((br, i) =>
        i === 0 ? { ...br, c: new Uint8Array(31) } : br,
      ),
    };
    expect(verifySigmaOr(a, b, stmts, malformed, ctx)).toBe(false);
  });

  it("rejects when a single c_i is XOR-tampered (breaks the global XOR check)", () => {
    const { a, b, ctx, stmts, proof } = setup(4, 0);
    const branches = proof.branches.map((br, i) => {
      if (i !== 2) return br;
      const c = new Uint8Array(br.c);
      c[0] ^= 1;
      return { ...br, c };
    });
    expect(verifySigmaOr(a, b, stmts, { branches }, ctx)).toBe(false);
  });

  it("rejects when z_i is tampered", () => {
    const { a, b, ctx, stmts, proof } = setup(3, 1);
    const branches = proof.branches.map((br, i) => {
      if (i !== 1) return br;
      const z = new Uint8Array(br.z);
      z[5] ^= 1;
      return { ...br, z };
    });
    expect(verifySigmaOr(a, b, stmts, { branches }, ctx)).toBe(false);
  });

  it("rejects when t_{i,0} is tampered", () => {
    const { a, b, ctx, stmts, proof } = setup(3, 0);
    const branches = proof.branches.map((br, i) => {
      if (i !== 1) return br;
      const t0 = new Uint8Array(br.t0);
      t0[7] ^= 1;
      return { ...br, t0 };
    });
    expect(verifySigmaOr(a, b, stmts, { branches }, ctx)).toBe(false);
  });

  it("rejects when ctx changes after proving", () => {
    const { a, b, stmts, proof } = setup(4, 2);
    expect(verifySigmaOr(a, b, stmts, proof, bytes("01"))).toBe(false);
  });

  it("rejects when statements are reordered", () => {
    const { a, b, ctx, stmts, proof } = setup(4, 1);
    const swapped = [stmts[1]!, stmts[0]!, stmts[2]!, stmts[3]!];
    expect(verifySigmaOr(a, b, swapped, proof, ctx)).toBe(false);
  });

  it("rejects when a statement (a'_i, b'_i) is replaced", () => {
    const { a, b, ctx, stmts, proof } = setup(4, 1);
    const tampered = [...stmts];
    tampered[2] = { ap: scalarMul(0xbadn, a), bp: scalarMul(0xbabn, b) };
    expect(verifySigmaOr(a, b, tampered, proof, ctx)).toBe(false);
  });

  it("a proof made with the wrong witness fails (zero-knowledge soundness)", () => {
    const a = scalarMul(2n, generator());
    const b = scalarMul(3n, generator());
    const realWitness = 0x99n;
    const wrongWitness = 0x9an;
    const ctx = bytes("");
    const stmts = makeStatements(4, a, b, 1, realWitness);
    // Prover claims branch 1 but supplies the wrong y — proof should not verify.
    const bad = proveSigmaOr(a, b, stmts, 1, wrongWitness, ctx);
    expect(verifySigmaOr(a, b, stmts, bad, ctx)).toBe(false);
  });
});
