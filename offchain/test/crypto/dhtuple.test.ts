import { describe, expect, it } from "vitest";
import {
  G1_COMPRESSED_BYTES,
  SCALAR_BYTES,
  SCALAR_ORDER,
  generator,
  scalarMul,
} from "../../src/crypto/bls.js";
import { dhPair, proveDHTuple, verifyDHTuple } from "../../src/crypto/dhtuple.js";

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (s: string): Uint8Array =>
  s.length === 0 ? new Uint8Array(0) : new Uint8Array(Buffer.from(s, "hex"));

describe("crypto/dhtuple", () => {
  it("proves and verifies for the canonical mix-branch shape (g=a, h=b)", () => {
    const a = scalarMul(0xa1n, generator());
    const b = scalarMul(0xb1n, generator());
    const y = 0x77n;
    const { u, v } = dhPair(a, b, y); // u = a' = [y]·a, v = b' = [y]·b
    const ctx = bytes("aabbcc");
    const proof = proveDHTuple(a, b, y, ctx);
    expect(proof.t0.length).toBe(G1_COMPRESSED_BYTES);
    expect(proof.t1.length).toBe(G1_COMPRESSED_BYTES);
    expect(proof.z.length).toBe(SCALAR_BYTES);
    expect(verifyDHTuple(a, b, u, v, proof, ctx)).toBe(true);
  });

  it("is RFC 6979-deterministic on (g, h, x, ctx)", () => {
    const g = generator();
    const h = scalarMul(2n, g);
    const x = 0x4242n;
    const ctx = bytes("ff");
    const p1 = proveDHTuple(g, h, x, ctx);
    const p2 = proveDHTuple(g, h, x, ctx);
    expect(hex(p1.t0)).toBe(hex(p2.t0));
    expect(hex(p1.t1)).toBe(hex(p2.t1));
    expect(hex(p1.z)).toBe(hex(p2.z));
  });

  it("rejects: tampered t0", () => {
    const g = generator();
    const h = scalarMul(2n, g);
    const x = 5n;
    const { u, v } = dhPair(g, h, x);
    const proof = proveDHTuple(g, h, x, bytes(""));
    const t0 = new Uint8Array(proof.t0);
    t0[10] ^= 1;
    expect(verifyDHTuple(g, h, u, v, { ...proof, t0 }, bytes(""))).toBe(false);
  });

  it("rejects: tampered t1", () => {
    const g = generator();
    const h = scalarMul(2n, g);
    const x = 5n;
    const { u, v } = dhPair(g, h, x);
    const proof = proveDHTuple(g, h, x, bytes(""));
    const t1 = new Uint8Array(proof.t1);
    t1[5] ^= 1;
    expect(verifyDHTuple(g, h, u, v, { ...proof, t1 }, bytes(""))).toBe(false);
  });

  it("rejects: tampered z", () => {
    const g = generator();
    const h = scalarMul(2n, g);
    const x = 5n;
    const { u, v } = dhPair(g, h, x);
    const proof = proveDHTuple(g, h, x, bytes(""));
    const z = new Uint8Array(proof.z);
    z[20] ^= 1;
    expect(verifyDHTuple(g, h, u, v, { ...proof, z }, bytes(""))).toBe(false);
  });

  it("rejects: proof valid for one (u, v) does not verify against an unrelated pair", () => {
    const g = generator();
    const h = scalarMul(2n, g);
    const x = 5n;
    const { u } = dhPair(g, h, x);
    const proof = proveDHTuple(g, h, x, bytes(""));

    // Crafted "bad" pair: (u, v) where u and v are unrelated by the same x.
    const fakeV = scalarMul(99n, h);
    expect(verifyDHTuple(g, h, u, fakeV, proof, bytes(""))).toBe(false);
  });

  it("rejects: ctx mismatch", () => {
    const g = generator();
    const h = scalarMul(2n, g);
    const x = 5n;
    const { u, v } = dhPair(g, h, x);
    const proof = proveDHTuple(g, h, x, bytes("aa"));
    expect(verifyDHTuple(g, h, u, v, proof, bytes("ab"))).toBe(false);
  });

  it("rejects: structurally malformed proof (wrong byte lengths)", () => {
    const g = generator();
    const h = scalarMul(2n, g);
    const x = 5n;
    const { u, v } = dhPair(g, h, x);
    expect(
      verifyDHTuple(
        g,
        h,
        u,
        v,
        { t0: new Uint8Array(47), t1: new Uint8Array(48), z: new Uint8Array(32) },
        bytes(""),
      ),
    ).toBe(false);
    expect(
      verifyDHTuple(
        g,
        h,
        u,
        v,
        { t0: new Uint8Array(48), t1: new Uint8Array(48), z: new Uint8Array(31) },
        bytes(""),
      ),
    ).toBe(false);
  });

  it("rejects: non-canonical z (>= r)", () => {
    const g = generator();
    const h = scalarMul(2n, g);
    const x = 5n;
    const { u, v } = dhPair(g, h, x);
    const proof = proveDHTuple(g, h, x, bytes(""));
    const z = new Uint8Array(SCALAR_BYTES);
    let r = SCALAR_ORDER;
    for (let i = SCALAR_BYTES - 1; i >= 0; i--) {
      z[i] = Number(r & 0xffn);
      r >>= 8n;
    }
    expect(verifyDHTuple(g, h, u, v, { ...proof, z }, bytes(""))).toBe(false);
  });
});
