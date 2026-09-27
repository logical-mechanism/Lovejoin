import { describe, expect, it } from "vitest";
import { SCALAR_ORDER, generator, pointToBytes } from "../../src/crypto/bls.js";
import {
  createRegister,
  decodeRegisterDatum,
  encodeRegisterDatum,
  ownsSeedelfRegister,
  rerandomizeRegister,
} from "../../src/seedelf/register.js";

describe("seedelf/register — create / rerandomize / owns / encode", () => {
  it("createRegister produces (g, g^x) with both fields 48 bytes", () => {
    const x = 12345n;
    const reg = createRegister(x);
    expect(reg.generator.length).toBe(48);
    expect(reg.publicValue.length).toBe(48);
    // Generator field equals the canonical G1 compression.
    expect(Buffer.from(reg.generator).toString("hex")).toBe(
      Buffer.from(pointToBytes(generator())).toString("hex"),
    );
  });

  it("createRegister(0) is rejected (would produce identity)", () => {
    expect(() => createRegister(0n)).toThrow();
  });

  it("rerandomize preserves spendability", () => {
    const x = 0xc0ffeeen;
    const d = 0xbeefn;
    const reg = createRegister(x);
    const reg2 = rerandomizeRegister(reg, d);
    expect(reg2.generator).not.toEqual(reg.generator);
    expect(reg2.publicValue).not.toEqual(reg.publicValue);
    expect(ownsSeedelfRegister(reg2, x)).toBe(true);
  });

  it("rerandomize is associative across two scalars", () => {
    const x = 0x42n;
    const d1 = 7n;
    const d2 = 11n;
    const reg = createRegister(x);
    const stepwise = rerandomizeRegister(rerandomizeRegister(reg, d1), d2);
    const combined = rerandomizeRegister(reg, (d1 * d2) % SCALAR_ORDER);
    expect(Buffer.from(stepwise.generator).toString("hex")).toBe(
      Buffer.from(combined.generator).toString("hex"),
    );
    expect(Buffer.from(stepwise.publicValue).toString("hex")).toBe(
      Buffer.from(combined.publicValue).toString("hex"),
    );
  });

  it("ownsSeedelfRegister returns false for the wrong secret", () => {
    const reg = createRegister(7n);
    expect(ownsSeedelfRegister(reg, 7n)).toBe(true);
    expect(ownsSeedelfRegister(reg, 8n)).toBe(false);
  });

  it("rerandomize with d=0 is rejected", () => {
    const reg = createRegister(3n);
    expect(() => rerandomizeRegister(reg, 0n)).toThrow();
  });

  it("encodeRegisterDatum round-trips through decodeRegisterDatum", () => {
    const reg = rerandomizeRegister(createRegister(99n), 17n);
    const hex = encodeRegisterDatum(reg);
    const decoded = decodeRegisterDatum(hex);
    expect(decoded).not.toBeNull();
    expect(Buffer.from(decoded!.generator).toString("hex")).toBe(
      Buffer.from(reg.generator).toString("hex"),
    );
    expect(Buffer.from(decoded!.publicValue).toString("hex")).toBe(
      Buffer.from(reg.publicValue).toString("hex"),
    );
  });

  it("decodeRegisterDatum returns null on garbage", () => {
    expect(decodeRegisterDatum("")).toBeNull();
    expect(decodeRegisterDatum("d87a80")).toBeNull(); // Constr 1 [] — wrong tag
    expect(decodeRegisterDatum("d87980")).toBeNull(); // Constr 0 [] — wrong arity
    expect(decodeRegisterDatum("not hex")).toBeNull();
  });
});
