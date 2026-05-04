import { describe, expect, it } from "vitest";
import {
  G1Point,
  GENERATOR_COMPRESSED,
  G1_COMPRESSED_BYTES,
  SCALAR_BYTES,
  SCALAR_ORDER,
  bytesToBigIntBE,
  generator,
  isIdentity,
  pointAdd,
  pointEqual,
  pointFromBytes,
  pointSub,
  pointToBytes,
  reduceScalar,
  scalarFromBytes,
  scalarMul,
  scalarToBytes,
} from "../../src/crypto/bls.js";

const SPEC_GENERATOR_HEX =
  "97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb";

const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("crypto/bls", () => {
  it("generator compresses to the spec-defined bytes", () => {
    expect(toHex(GENERATOR_COMPRESSED)).toBe(SPEC_GENERATOR_HEX);
    expect(GENERATOR_COMPRESSED.length).toBe(G1_COMPRESSED_BYTES);
  });

  it("scalar order matches spec r", () => {
    expect(SCALAR_ORDER).toBe(0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n);
  });

  it("scalarToBytes / scalarFromBytes is round-trip and 32 bytes", () => {
    const samples = [0n, 1n, 7n, SCALAR_ORDER - 1n, 0xffffffffffffffffn];
    for (const s of samples) {
      const enc = scalarToBytes(s);
      expect(enc.length).toBe(SCALAR_BYTES);
      expect(scalarFromBytes(enc)).toBe(s);
    }
  });

  it("scalarFromBytes rejects non-canonical (>= r) encodings", () => {
    const bad = scalarToBytes(SCALAR_ORDER - 1n);
    bad[SCALAR_BYTES - 1] = (bad[SCALAR_BYTES - 1]! + 1) & 0xff; // flips into >= r
    expect(() => scalarFromBytes(bad)).toThrow();
  });

  it("scalarToBytes rejects values >= r and negatives", () => {
    expect(() => scalarToBytes(SCALAR_ORDER)).toThrow();
    expect(() => scalarToBytes(-1n)).toThrow();
  });

  it("[1]g == g, and [2]g + [3]g == [5]g", () => {
    const g = generator();
    expect(pointEqual(scalarMul(1n, g), g)).toBe(true);
    const left = pointAdd(scalarMul(2n, g), scalarMul(3n, g));
    const right = scalarMul(5n, g);
    expect(pointEqual(left, right)).toBe(true);
  });

  it("compress/uncompress round-trip preserves the point", () => {
    const g = generator();
    const k = 0x1234_5678_9abc_def0n;
    const p = scalarMul(k, g);
    const back = pointFromBytes(pointToBytes(p));
    expect(pointEqual(p, back)).toBe(true);
  });

  it("pointSub is the inverse of pointAdd", () => {
    const g = generator();
    const a = scalarMul(11n, g);
    const b = scalarMul(7n, g);
    expect(pointEqual(pointSub(pointAdd(a, b), b), a)).toBe(true);
  });

  it("reduceScalar wraps mod r exactly once", () => {
    expect(reduceScalar(SCALAR_ORDER)).toBe(0n);
    expect(reduceScalar(SCALAR_ORDER + 5n)).toBe(5n);
    expect(reduceScalar(0n)).toBe(0n);
  });

  it("bytesToBigIntBE matches naive reduction for 32-byte FS challenges", () => {
    const allOnes = new Uint8Array(32).fill(0xff);
    const expected = (1n << 256n) - 1n; // 2^256 - 1
    expect(bytesToBigIntBE(allOnes)).toBe(expected);
  });

  it("pointFromBytes rejects wrong-length input", () => {
    expect(() => pointFromBytes(new Uint8Array(47))).toThrow();
    expect(() => pointFromBytes(new Uint8Array(49))).toThrow();
  });

  it("G1Point.fromBytes rejects bytes not in the prime subgroup", () => {
    const bogus = new Uint8Array(48); // all-zero is not a valid encoding
    expect(() => pointFromBytes(bogus)).toThrow();
  });

  it("G1Point.ZERO encodes as the canonical infinity bytes", () => {
    const inf = G1Point.ZERO.toBytes();
    expect(inf[0]).toBe(0xc0);
    for (let i = 1; i < 48; i++) expect(inf[i]).toBe(0);
  });

  it("isIdentity is true for the zero point and the canonical infinity bytes", () => {
    expect(isIdentity(G1Point.ZERO)).toBe(true);
    expect(isIdentity(scalarMul(0n, generator()))).toBe(true);
    const infBytes = new Uint8Array(48);
    infBytes[0] = 0xc0;
    expect(isIdentity(pointFromBytes(infBytes))).toBe(true);
  });

  it("isIdentity is false for the generator and non-zero scalar multiples", () => {
    expect(isIdentity(generator())).toBe(false);
    expect(isIdentity(scalarMul(7n, generator()))).toBe(false);
    expect(isIdentity(scalarMul(SCALAR_ORDER - 1n, generator()))).toBe(false);
  });
});
