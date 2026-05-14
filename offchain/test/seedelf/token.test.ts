import { describe, expect, it } from "vitest";
import {
  SEEDELF_TOKEN_BYTES,
  SEEDELF_TOKEN_PREFIX_HEX,
  buildSeedelfTokenName,
  buildSeedelfTokenNameHex,
  isSeedelfAssetName,
  pickSmallestInputRef,
} from "../../src/seedelf/token.js";

// Reproduces the on-chain test vectors from
// contracts/lib/token_name.ak in the Seedelf-Wallet repo.
const TXID = "4172bf875e341da9ecc0f1f84bfb7b6e6bb8b022b17205b5ce23617fc1641880";

describe("seedelf/token — canonical name generation", () => {
  it("matches the Aiken `real_token_name1` vector (no personal tag)", () => {
    const name = buildSeedelfTokenNameHex({
      input: { txId: TXID, outputIndex: 0 },
      personal: "",
    });
    expect(name).toBe("5eed0e1f004172bf875e341da9ecc0f1f84bfb7b6e6bb8b022b17205b5ce2361");
  });

  it("matches the Aiken `real_token_name2` vector (personal=acab)", () => {
    const name = buildSeedelfTokenNameHex({
      input: { txId: TXID, outputIndex: 0 },
      personal: new Uint8Array([0xac, 0xab]),
    });
    expect(name).toBe("5eed0e1facab004172bf875e341da9ecc0f1f84bfb7b6e6bb8b022b17205b5ce");
  });

  it("is always 32 bytes regardless of personal-tag length", () => {
    const a = buildSeedelfTokenName({ input: { txId: TXID, outputIndex: 0 } });
    const b = buildSeedelfTokenName({
      input: { txId: TXID, outputIndex: 7 },
      personal: "x".repeat(40),
    });
    expect(a.length).toBe(SEEDELF_TOKEN_BYTES);
    expect(b.length).toBe(SEEDELF_TOKEN_BYTES);
  });

  it("refuses outputIndex >= 256 (rollover attack)", () => {
    expect(() => buildSeedelfTokenName({ input: { txId: TXID, outputIndex: 256 } })).toThrow();
  });

  it("pickSmallestInputRef picks lex-smallest (txid, idx)", () => {
    const a = { txId: "ff" + "0".repeat(62), outputIndex: 0 };
    const b = { txId: "00" + "0".repeat(62), outputIndex: 5 };
    const c = { txId: "00" + "0".repeat(62), outputIndex: 0 };
    expect(pickSmallestInputRef([a, b, c])).toEqual(c);
  });

  it("isSeedelfAssetName accepts the prefix and rejects others", () => {
    const valid = `${SEEDELF_TOKEN_PREFIX_HEX}` + "0".repeat(56);
    const invalid1 = "12345678" + "0".repeat(56);
    const invalidShort = SEEDELF_TOKEN_PREFIX_HEX + "00";
    expect(isSeedelfAssetName(valid)).toBe(true);
    expect(isSeedelfAssetName(invalid1)).toBe(false);
    expect(isSeedelfAssetName(invalidShort)).toBe(false);
  });
});
