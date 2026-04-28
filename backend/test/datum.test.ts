// Plutus-Data CBOR decoder: definite vs indefinite array forms,
// malformed inputs, equality rejection.

import { describe, expect, it } from "vitest";

import { tryDecodeMixDatum, bytesToHex } from "../src/indexer/datum.js";
import { encodeMixDatumDef, encodeMixDatumIndef } from "./helpers/datum.js";

function bytes48(seed: number): Uint8Array {
  const out = new Uint8Array(48);
  for (let i = 0; i < 48; i++) out[i] = (seed * 7 + i) & 0xff;
  return out;
}

describe("tryDecodeMixDatum", () => {
  it("decodes the SDK's definite-length form", () => {
    const a = bytes48(1);
    const b = bytes48(2);
    const decoded = tryDecodeMixDatum(encodeMixDatumDef(a, b));
    expect(decoded).not.toBeNull();
    expect(bytesToHex(decoded!.a)).toBe(bytesToHex(a));
    expect(bytesToHex(decoded!.b)).toBe(bytesToHex(b));
  });

  it("decodes Aiken's indef-length canonical form", () => {
    const a = bytes48(3);
    const b = bytes48(4);
    const decoded = tryDecodeMixDatum(encodeMixDatumIndef(a, b));
    expect(decoded).not.toBeNull();
    expect(bytesToHex(decoded!.a)).toBe(bytesToHex(a));
    expect(bytesToHex(decoded!.b)).toBe(bytesToHex(b));
  });

  it("rejects equal a == b", () => {
    const a = bytes48(5);
    expect(tryDecodeMixDatum(encodeMixDatumDef(a, a))).toBeNull();
  });

  it("rejects wrong-length bytes", () => {
    // Constr 0 [bytes(47), bytes(48)]
    const out: number[] = [0xd8, 0x79, 0x82, 0x58, 0x2f];
    for (let i = 0; i < 47; i++) out.push(i);
    out.push(0x58, 0x30);
    for (let i = 0; i < 48; i++) out.push(i);
    expect(tryDecodeMixDatum(Buffer.from(out).toString("hex"))).toBeNull();
  });

  it("rejects wrong number of fields", () => {
    // Constr 0 [bytes(48)]
    const out: number[] = [0xd8, 0x79, 0x81, 0x58, 0x30];
    for (let i = 0; i < 48; i++) out.push(i);
    expect(tryDecodeMixDatum(Buffer.from(out).toString("hex"))).toBeNull();
  });

  it("rejects non-Constr-0 tag", () => {
    // Constr 1 [bytes(48), bytes(48)] — tag 122
    const out: number[] = [0xd8, 0x7a, 0x82, 0x58, 0x30];
    for (let i = 0; i < 48; i++) out.push(i);
    out.push(0x58, 0x30);
    for (let i = 0; i < 48; i++) out.push(i + 1);
    expect(tryDecodeMixDatum(Buffer.from(out).toString("hex"))).toBeNull();
  });

  it("rejects empty / garbage input", () => {
    expect(tryDecodeMixDatum("")).toBeNull();
    expect(tryDecodeMixDatum("ff")).toBeNull();
    expect(tryDecodeMixDatum("not-hex")).toBeNull();
    expect(tryDecodeMixDatum("d87980")).toBeNull(); // unit datum
  });
});
