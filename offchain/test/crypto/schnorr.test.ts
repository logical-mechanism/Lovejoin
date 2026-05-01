import { describe, expect, it } from "vitest";
import {
  G1_COMPRESSED_BYTES,
  SCALAR_BYTES,
  SCALAR_ORDER,
  generator,
  scalarMul,
} from "../../src/crypto/bls.js";
import {
  proveSchnorr,
  publicPoint,
  publicPointG,
  verifySchnorr,
} from "../../src/crypto/schnorr.js";

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (s: string): Uint8Array =>
  s.length === 0 ? new Uint8Array(0) : new Uint8Array(Buffer.from(s, "hex"));

describe("crypto/schnorr — prove / verify with the canonical generator", () => {
  it("a freshly generated proof verifies", () => {
    const x = 0xdeadbeefn;
    const u = publicPointG(x);
    const ctx = bytes("ff00aa55");
    const proof = proveSchnorr(generator(), x, ctx);
    expect(proof.t.length).toBe(G1_COMPRESSED_BYTES);
    expect(proof.z.length).toBe(SCALAR_BYTES);
    expect(verifySchnorr(generator(), u, proof, ctx)).toBe(true);
  });

  it("the same (secret, ctx) produces byte-identical proofs (RFC 6979)", () => {
    const x = 0x1234_5678n;
    const ctx = bytes("aabbcc");
    const a = proveSchnorr(generator(), x, ctx);
    const b = proveSchnorr(generator(), x, ctx);
    expect(hex(a.t)).toBe(hex(b.t));
    expect(hex(a.z)).toBe(hex(b.z));
  });

  it("changing ctx changes the proof and breaks the old one", () => {
    const x = 0x1234n;
    const u = publicPointG(x);
    const proof = proveSchnorr(generator(), x, bytes("aa"));
    expect(verifySchnorr(generator(), u, proof, bytes("ab"))).toBe(false);
  });

  it("flipping a byte in t breaks verification", () => {
    const x = 5n;
    const u = publicPointG(x);
    const ctx = bytes("");
    const proof = proveSchnorr(generator(), x, ctx);
    const tampered = { ...proof, t: new Uint8Array(proof.t) };
    tampered.t[10] = (tampered.t[10]! ^ 0x01) & 0xff;
    expect(verifySchnorr(generator(), u, tampered, ctx)).toBe(false);
  });

  it("flipping a byte in z breaks verification", () => {
    const x = 5n;
    const u = publicPointG(x);
    const ctx = bytes("");
    const proof = proveSchnorr(generator(), x, ctx);
    const tampered = { ...proof, z: new Uint8Array(proof.z) };
    tampered.z[10] = (tampered.z[10]! ^ 0x01) & 0xff;
    expect(verifySchnorr(generator(), u, tampered, ctx)).toBe(false);
  });

  it("a proof for u doesn't verify against a different point", () => {
    const x = 5n;
    const ctx = bytes("");
    const proof = proveSchnorr(generator(), x, ctx);
    const wrongU = publicPointG(6n);
    expect(verifySchnorr(generator(), wrongU, proof, ctx)).toBe(false);
  });

  it("rejects malformed proof structure (wrong byte lengths)", () => {
    const x = 5n;
    const u = publicPointG(x);
    const ctx = bytes("");
    expect(
      verifySchnorr(generator(), u, { t: new Uint8Array(47), z: new Uint8Array(32) }, ctx),
    ).toBe(false);
    expect(
      verifySchnorr(generator(), u, { t: new Uint8Array(48), z: new Uint8Array(31) }, ctx),
    ).toBe(false);
  });

  it("rejects non-canonical z (>= r)", () => {
    const x = 5n;
    const u = publicPointG(x);
    const proof = proveSchnorr(generator(), x, bytes(""));
    const z = new Uint8Array(SCALAR_BYTES);
    // Encode r itself — strictly invalid.
    let r = SCALAR_ORDER;
    for (let i = SCALAR_BYTES - 1; i >= 0; i--) {
      z[i] = Number(r & 0xffn);
      r >>= 8n;
    }
    expect(verifySchnorr(generator(), u, { t: proof.t, z }, bytes(""))).toBe(false);
  });
});

describe("crypto/schnorr — generalized proveDlog (custom base)", () => {
  it("proves and verifies against a base = [k]·g for arbitrary k", () => {
    // Mirror the Owner-branch case: use base = a, u = [x]·a.
    const k = 7n;
    const base = scalarMul(k, generator());
    const x = 0xc0ffeen;
    const u = publicPoint(base, x);
    const ctx = bytes("aa");
    const proof = proveSchnorr(base, x, ctx);
    expect(verifySchnorr(base, u, proof, ctx)).toBe(true);
    // Sanity: this proof MUST NOT verify against the canonical generator.
    expect(verifySchnorr(generator(), u, proof, ctx)).toBe(false);
  });

  it("base bytes are part of the FS challenge — swapping bases breaks the proof", () => {
    const baseA = scalarMul(7n, generator());
    const baseB = scalarMul(8n, generator());
    const x = 11n;
    const u = publicPoint(baseA, x);
    const proof = proveSchnorr(baseA, x, bytes(""));
    // u was generated against baseA; verification requires baseA.
    expect(verifySchnorr(baseA, u, proof, bytes(""))).toBe(true);
    expect(verifySchnorr(baseB, u, proof, bytes(""))).toBe(false);
  });
});
