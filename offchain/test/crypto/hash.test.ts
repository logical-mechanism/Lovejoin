import { describe, expect, it } from "vitest";
import {
  DOMAIN_TAG_V1,
  DOMAIN_TAG_V1_BYTES,
  STATEMENT_ID_PROVE_DH_TUPLE,
  STATEMENT_ID_PROVE_DLOG,
  STATEMENT_ID_SIGMA_OR_N,
  blake2b256,
  fsHashSchnorr,
  fsInputDHTuple,
  fsInputSchnorr,
  fsInputSigmaOr,
} from "../../src/crypto/hash.js";

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"));
const ABYTE = (n: number, fill = 0): Uint8Array => new Uint8Array(n).fill(fill);

describe("crypto/hash — domain tag and statement ids", () => {
  it("DOMAIN_TAG_V1 is the spec-canonical ASCII string", () => {
    expect(DOMAIN_TAG_V1).toBe("lovejoin/sigmajoin/v1/");
    expect(DOMAIN_TAG_V1_BYTES.length).toBe(22);
    // Sanity: first byte is 'l' (0x6c)
    expect(DOMAIN_TAG_V1_BYTES[0]).toBe(0x6c);
  });

  it("statement ids are 0x01 / 0x02 / 0x03", () => {
    expect(STATEMENT_ID_PROVE_DLOG).toBe(0x01);
    expect(STATEMENT_ID_PROVE_DH_TUPLE).toBe(0x02);
    expect(STATEMENT_ID_SIGMA_OR_N).toBe(0x03);
  });
});

describe("crypto/hash — blake2b-256 parity", () => {
  it("matches the test vector also used by the Aiken builtin parity check", () => {
    // Independently recomputed in contracts/lib/lovejoin/hash.test.ak.
    expect(hex(blake2b256(bytes("010203")))).toBe(
      "11c0e79b71c3976ccd0c02d1310e2516c08edc9d8b6f57ccd680d63a4d8e72da",
    );
  });

  it("empty input matches the canonical blake2b-256 of empty", () => {
    // RFC 7693 Appendix A.4 doesn't have an empty-input vector, but cross-check
    // against a known value (verified out-of-band via two independent libraries).
    expect(hex(blake2b256(new Uint8Array(0)))).toBe(
      "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8",
    );
  });
});

describe("crypto/hash — fsInput* layout", () => {
  it("Schnorr layout: DOMAIN || 0x01 || g || u || t || ctx", () => {
    const g = ABYTE(48, 0xa1);
    const u = ABYTE(48, 0xa2);
    const t = ABYTE(48, 0xa3);
    const ctx = bytes("deadbeef");
    const got = fsInputSchnorr(g, u, t, ctx);
    expect(got.length).toBe(22 + 1 + 48 * 3 + 4);
    expect(got.slice(0, 22)).toEqual(DOMAIN_TAG_V1_BYTES);
    expect(got[22]).toBe(0x01);
    expect(got.slice(23, 71)).toEqual(g);
    expect(got.slice(71, 119)).toEqual(u);
    expect(got.slice(119, 167)).toEqual(t);
    expect(got.slice(167)).toEqual(ctx);
  });

  it("DHTuple layout: DOMAIN || 0x02 || g||h||u||v || t0||t1 || ctx", () => {
    const arr = (n: number) => ABYTE(48, n);
    const ctx = bytes("ff");
    const got = fsInputDHTuple(arr(1), arr(2), arr(3), arr(4), arr(5), arr(6), ctx);
    expect(got.length).toBe(22 + 1 + 48 * 6 + 1);
    expect(got[22]).toBe(0x02);
    // Field-order spot-check.
    expect(got[23]).toBe(1);
    expect(got[23 + 48]).toBe(2);
    expect(got[23 + 48 * 2]).toBe(3);
    expect(got[23 + 48 * 3]).toBe(4);
    expect(got[23 + 48 * 4]).toBe(5);
    expect(got[23 + 48 * 5]).toBe(6);
  });

  it("Sigma-OR layout: DOMAIN || 0x03 || N || a||b || (a'_i,b'_i)... || (t_{i,0},t_{i,1})... || ctx", () => {
    const N = 3;
    const a = ABYTE(48, 0xaa);
    const b = ABYTE(48, 0xbb);
    const branches = [
      { ap: ABYTE(48, 0x11), bp: ABYTE(48, 0x12) },
      { ap: ABYTE(48, 0x21), bp: ABYTE(48, 0x22) },
      { ap: ABYTE(48, 0x31), bp: ABYTE(48, 0x32) },
    ];
    const commitments = [
      { t0: ABYTE(48, 0x41), t1: ABYTE(48, 0x42) },
      { t0: ABYTE(48, 0x51), t1: ABYTE(48, 0x52) },
      { t0: ABYTE(48, 0x61), t1: ABYTE(48, 0x62) },
    ];
    const ctx = bytes("");
    const got = fsInputSigmaOr(a, b, branches, commitments, ctx);
    expect(got.length).toBe(22 + 2 + 48 * 2 + 48 * 2 * N + 48 * 2 * N + 0);
    expect(got[22]).toBe(0x03);
    expect(got[23]).toBe(N);
  });

  it("Sigma-OR rejects mismatched branches/commitments lengths", () => {
    const a = ABYTE(48);
    const b = ABYTE(48);
    expect(() =>
      fsInputSigmaOr(
        a,
        b,
        [{ ap: ABYTE(48), bp: ABYTE(48) }, { ap: ABYTE(48), bp: ABYTE(48) }],
        [{ t0: ABYTE(48), t1: ABYTE(48) }],
        new Uint8Array(0),
      ),
    ).toThrow();
  });

  it("Sigma-OR rejects N < 2", () => {
    expect(() =>
      fsInputSigmaOr(
        ABYTE(48),
        ABYTE(48),
        [{ ap: ABYTE(48), bp: ABYTE(48) }],
        [{ t0: ABYTE(48), t1: ABYTE(48) }],
        new Uint8Array(0),
      ),
    ).toThrow();
  });
});

describe("crypto/hash — fsHash* are deterministic", () => {
  it("same inputs ⇒ same output", () => {
    const args: [Uint8Array, Uint8Array, Uint8Array, Uint8Array] = [
      ABYTE(48, 1),
      ABYTE(48, 2),
      ABYTE(48, 3),
      bytes("aa"),
    ];
    expect(hex(fsHashSchnorr(...args))).toBe(hex(fsHashSchnorr(...args)));
  });
});
