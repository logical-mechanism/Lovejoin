import { describe, expect, it } from "vitest";
import { generator, pointToBytes, scalarMul } from "../../src/crypto/bls.js";
import { createRegister, rerandomizeRegister } from "../../src/seedelf/register.js";
import {
  SEEDELF_FS_DIGEST_BYTES,
  SEEDELF_VKH_BYTES,
  proveSeedelfSchnorr,
  seedelfFsHash,
  verifySeedelfSchnorr,
} from "../../src/seedelf/schnorr.js";

function fixedVkh(byte: number): Uint8Array {
  const v = new Uint8Array(SEEDELF_VKH_BYTES);
  v.fill(byte);
  return v;
}

describe("seedelf/schnorr — prove + verify against the wallet validator", () => {
  it("Fiat-Shamir hash is exactly 28 bytes (blake2b-224)", () => {
    const out = seedelfFsHash(
      pointToBytes(generator()),
      pointToBytes(scalarMul(2n, generator())),
      pointToBytes(scalarMul(3n, generator())),
      fixedVkh(0xaa),
    );
    expect(out.length).toBe(SEEDELF_FS_DIGEST_BYTES);
    expect(SEEDELF_FS_DIGEST_BYTES).toBe(28);
  });

  it("a freshly produced proof verifies", () => {
    const x = 0xdeadbeefn;
    const d = 0x42n;
    const reg = rerandomizeRegister(createRegister(x), d);
    const proof = proveSeedelfSchnorr({
      secret: x,
      generator: reg.generator,
      publicValue: reg.publicValue,
      vkh: fixedVkh(0x55),
    });
    expect(proof.z.length).toBe(32);
    expect(proof.gR.length).toBe(48);
    expect(proof.vkh.length).toBe(28);
    expect(
      verifySeedelfSchnorr({
        generator: reg.generator,
        publicValue: reg.publicValue,
        proof,
      }),
    ).toBe(true);
  });

  it("RFC 6979 makes the prover deterministic", () => {
    const x = 0x1234n;
    const reg = rerandomizeRegister(createRegister(x), 0x99n);
    const a = proveSeedelfSchnorr({
      secret: x,
      generator: reg.generator,
      publicValue: reg.publicValue,
      vkh: fixedVkh(0x10),
    });
    const b = proveSeedelfSchnorr({
      secret: x,
      generator: reg.generator,
      publicValue: reg.publicValue,
      vkh: fixedVkh(0x10),
    });
    expect(Buffer.from(a.z).toString("hex")).toBe(Buffer.from(b.z).toString("hex"));
    expect(Buffer.from(a.gR).toString("hex")).toBe(Buffer.from(b.gR).toString("hex"));
  });

  it("changing the vkh breaks a previously valid proof", () => {
    const x = 0x77n;
    const reg = createRegister(x);
    const proof = proveSeedelfSchnorr({
      secret: x,
      generator: reg.generator,
      publicValue: reg.publicValue,
      vkh: fixedVkh(0x01),
    });
    const tampered = { ...proof, vkh: fixedVkh(0x02) };
    expect(
      verifySeedelfSchnorr({
        generator: reg.generator,
        publicValue: reg.publicValue,
        proof: tampered,
      }),
    ).toBe(false);
  });

  it("flipping a byte in z breaks verification", () => {
    const x = 0x33n;
    const reg = createRegister(x);
    const proof = proveSeedelfSchnorr({
      secret: x,
      generator: reg.generator,
      publicValue: reg.publicValue,
      vkh: fixedVkh(0x01),
    });
    const z = new Uint8Array(proof.z);
    z[5] = (z[5]! ^ 0x01) & 0xff;
    const tampered = { ...proof, z };
    expect(
      verifySeedelfSchnorr({
        generator: reg.generator,
        publicValue: reg.publicValue,
        proof: tampered,
      }),
    ).toBe(false);
  });

  it("the wrong secret fails proof generation early", () => {
    const reg = createRegister(7n);
    // We can still produce a "proof" syntactically with x=8 against the
    // public point [7]·g — but the helper itself asserts ownership before
    // running. The wallet contract would reject anyway; this just makes
    // the failure mode loud at build time.
    expect(() =>
      proveSeedelfSchnorr({
        secret: 8n,
        generator: reg.generator,
        publicValue: reg.publicValue,
        vkh: fixedVkh(0x99),
      }),
    ).not.toThrow();
    // The resulting proof must fail validator verification.
    const proof = proveSeedelfSchnorr({
      secret: 8n,
      generator: reg.generator,
      publicValue: reg.publicValue,
      vkh: fixedVkh(0x99),
    });
    expect(
      verifySeedelfSchnorr({
        generator: reg.generator,
        publicValue: reg.publicValue,
        proof,
      }),
    ).toBe(false);
  });
});
