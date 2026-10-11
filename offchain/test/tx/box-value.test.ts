// Unit tests for tx/box-value.ts: the box value every mix-box in a launch
// holds (docs/generalize-lovejoin.md). The CBOR encoder's cross-language
// parity lives in test/crypto/encoding-parity.test.ts; this file covers
// the hand-picked thresholds plus the matching, scaling, and mesh helpers.

import { describe, expect, it } from "vitest";

import type { Utxo } from "../../src/chain/provider.js";
import {
  assertBoxValue,
  type BoxValue,
  boxValueAssetMap,
  boxValueAssets,
  boxValuesEqual,
  encodeBoxValueCbor,
  MAX_TOKEN_QUANTITY,
  poolTokenUnit,
  scaleBoxValue,
  utxoAssets,
  utxoHoldsBoxValue,
} from "../../src/tx/box-value.js";

const POLICY = "34".repeat(28);
const NAME = "544f4b454e"; // "TOKEN"
const UNIT = POLICY + NAME;
const TOKEN_BOX: BoxValue = {
  lovelace: 2_000_000n,
  token: { policy: POLICY, name: NAME, quantity: 1_000_000n },
};

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function utxo(lovelace: bigint, assets: Record<string, bigint> = {}): Utxo {
  return {
    ref: { txId: "aa".repeat(32), outputIndex: 0 },
    address: "addr_test1",
    lovelace,
    assets,
    inlineDatum: null,
    referenceScript: null,
  };
}

describe("tx/box-value — encodeBoxValueCbor", () => {
  it("encodes an ADA pool as a one-entry map", () => {
    expect(hex(encodeBoxValueCbor({ lovelace: 10_000_000n }))).toBe("a140a1401a00989680");
  });

  it("rolls lovelace into 1/2/3/5/9-byte integer forms at the CBOR thresholds", () => {
    const cases: [bigint, string][] = [
      [5n, "05"],
      [23n, "17"],
      [24n, "1818"],
      [255n, "18ff"],
      [256n, "190100"],
      [65_535n, "19ffff"],
      [65_536n, "1a00010000"],
      [4_294_967_295n, "1affffffff"],
      [4_294_967_296n, "1b0000000100000000"],
    ];
    for (const [n, tail] of cases) {
      expect(hex(encodeBoxValueCbor({ lovelace: n }))).toBe(`a140a140${tail}`);
    }
  });

  it("encodes a token pool as a two-entry map with ADA first", () => {
    expect(hex(encodeBoxValueCbor(TOKEN_BOX))).toBe(
      `a240a1401a001e8480581c${POLICY}a145${NAME}1a000f4240`,
    );
  });

  it("switches the asset-name header from 0x40+len to 0x58 len at 24 bytes", () => {
    const name23 = "ab".repeat(23);
    const name24 = "ab".repeat(24);
    const enc = (name: string) =>
      hex(encodeBoxValueCbor({ lovelace: 1n, token: { policy: POLICY, name, quantity: 1n } }));
    expect(enc(name23)).toContain(`a157${name23}01`);
    expect(enc(name24)).toContain(`a15818${name24}01`);
    expect(enc("")).toBe(`a240a14001581c${POLICY}a14001`);
  });

  it("encodes the 2^64 - 1 quantity ceiling and rejects anything above it", () => {
    const max = { ...TOKEN_BOX, token: { ...TOKEN_BOX.token!, quantity: MAX_TOKEN_QUANTITY } };
    expect(hex(encodeBoxValueCbor(max)).endsWith("1bffffffffffffffff")).toBe(true);
    const over = { ...max, token: { ...max.token, quantity: MAX_TOKEN_QUANTITY + 1n } };
    expect(() => encodeBoxValueCbor(over)).toThrow(/quantity/);
  });
});

describe("tx/box-value — assertBoxValue", () => {
  it.each<[string, BoxValue]>([
    ["zero lovelace", { lovelace: 0n }],
    ["short policy", { ...TOKEN_BOX, token: { ...TOKEN_BOX.token!, policy: "34".repeat(27) } }],
    ["uppercase policy", { ...TOKEN_BOX, token: { ...TOKEN_BOX.token!, policy: "AB".repeat(28) } }],
    ["33-byte name", { ...TOKEN_BOX, token: { ...TOKEN_BOX.token!, name: "ab".repeat(33) } }],
    ["odd-length name", { ...TOKEN_BOX, token: { ...TOKEN_BOX.token!, name: "abc" } }],
    ["zero quantity", { ...TOKEN_BOX, token: { ...TOKEN_BOX.token!, quantity: 0n } }],
  ])("rejects %s", (_label, value) => {
    expect(() => assertBoxValue(value)).toThrow();
  });

  it("accepts a well-formed token pool and an ADA pool", () => {
    expect(() => assertBoxValue(TOKEN_BOX)).not.toThrow();
    expect(() => assertBoxValue({ lovelace: 10_000_000n })).not.toThrow();
  });
});

describe("tx/box-value — utxoHoldsBoxValue", () => {
  it("matches only the exact token-pool value", () => {
    expect(utxoHoldsBoxValue(utxo(2_000_000n, { [UNIT]: 1_000_000n }), TOKEN_BOX)).toBe(true);
    expect(utxoHoldsBoxValue(utxo(2_000_000n, { [UNIT]: 999_999n }), TOKEN_BOX)).toBe(false);
    expect(utxoHoldsBoxValue(utxo(2_000_001n, { [UNIT]: 1_000_000n }), TOKEN_BOX)).toBe(false);
    expect(utxoHoldsBoxValue(utxo(2_000_000n), TOKEN_BOX)).toBe(false);
    expect(
      utxoHoldsBoxValue(
        utxo(2_000_000n, { [UNIT]: 1_000_000n, [POLICY + "6a756e6b"]: 1n }),
        TOKEN_BOX,
      ),
    ).toBe(false);
  });

  it("matches only ADA-only UTxOs for an ADA pool", () => {
    expect(utxoHoldsBoxValue(utxo(10_000_000n), { lovelace: 10_000_000n })).toBe(true);
    expect(utxoHoldsBoxValue(utxo(10_000_000n, { [UNIT]: 1n }), { lovelace: 10_000_000n })).toBe(
      false,
    );
  });
});

describe("tx/box-value — mesh and scaling helpers", () => {
  it("lists lovelace first, then the token", () => {
    expect(boxValueAssets(TOKEN_BOX)).toEqual([
      { unit: "lovelace", quantity: "2000000" },
      { unit: UNIT, quantity: "1000000" },
    ]);
    expect(boxValueAssets({ lovelace: 10n })).toEqual([{ unit: "lovelace", quantity: "10" }]);
  });

  it("spends every asset a UTxO holds", () => {
    expect(utxoAssets(utxo(2_000_000n, { [UNIT]: 5n }))).toEqual([
      { unit: "lovelace", quantity: "2000000" },
      { unit: UNIT, quantity: "5" },
    ]);
  });

  it("scales lovelace and token together", () => {
    expect(scaleBoxValue(TOKEN_BOX, 3)).toEqual({
      lovelace: 6_000_000n,
      token: { ...TOKEN_BOX.token!, quantity: 3_000_000n },
    });
  });

  it("builds the in-flight asset map and compares box values", () => {
    expect(boxValueAssetMap(TOKEN_BOX)).toEqual({ [UNIT]: 1_000_000n });
    expect(boxValueAssetMap({ lovelace: 1n })).toEqual({});
    expect(poolTokenUnit(TOKEN_BOX.token!)).toBe(UNIT);
    expect(boxValuesEqual(TOKEN_BOX, { ...TOKEN_BOX })).toBe(true);
    expect(boxValuesEqual(TOKEN_BOX, { lovelace: 2_000_000n })).toBe(false);
  });
});
