// Unit tests for pool/identify.ts.
//
// These tests cover the pure data-shape layer of the pool scanner:
//   * decodeMixDatumInline — accepts well-formed Plutus-Data CBOR; rejects
//     missing/wrong-tag/wrong-length/a==b inputs.
//   * filterPoolEntries — filters UTxOs by address + denom + datum.
//   * ownsBox / findOwnedBoxes — Schnorr-statement check `b == [x]·a`.
//
// We do NOT cover the chain-fetching wrapper `fetchPool` here — the
// ChainProvider is mocked in chain-provider.test.ts already.

import { describe, expect, it } from "vitest";

import {
  type Scalar,
  generator,
  pointToBytes,
  scalarMul,
} from "../../src/crypto/index.js";
import {
  decodeMixDatumInline,
  filterPoolEntries,
  findOwnedBoxes,
  ownsBox,
  type PoolEntry,
} from "../../src/pool/identify.js";
import { encodeMixDatum } from "../../src/tx/deposit.js";
import type { Utxo } from "../../src/chain/provider.js";

const MIX_BOX_ADDR = "addr_test1zr6st458sf8czp2nayx9wqgqg9hd58lmqyguda3e7csdju8repagljh249nrlmgvxhfah6mvyq6sg2xkmgnzcjpsqzckqz3ahz5";
const DENOM = 10_000_000n;

function makeAB(secret: bigint, dScalar: bigint = 1n): { a: Uint8Array; b: Uint8Array } {
  // Re-randomized: a = [d]·g, b = [x·d]·g = [x]·a.
  const aPoint = scalarMul(dScalar, generator());
  const bPoint = scalarMul(secret, aPoint);
  return { a: pointToBytes(aPoint), b: pointToBytes(bPoint) };
}

function makeUtxo(
  txId: string,
  outputIndex: number,
  inlineDatum: string | null,
  overrides: Partial<Utxo> = {},
): Utxo {
  return {
    ref: { txId, outputIndex },
    address: MIX_BOX_ADDR,
    lovelace: DENOM,
    assets: {},
    inlineDatum,
    referenceScript: null,
    ...overrides,
  };
}

describe("pool/identify — decodeMixDatumInline", () => {
  it("decodes a well-formed MixDatum from cbor-x's encoder", () => {
    const { a, b } = makeAB(7n, 11n);
    const cborHex = encodeMixDatum({ a, b });
    const decoded = decodeMixDatumInline(cborHex);
    expect(decoded).not.toBeNull();
    expect(decoded!.a).toEqual(a);
    expect(decoded!.b).toEqual(b);
  });

  it("returns null for missing datum", () => {
    expect(decodeMixDatumInline(null)).toBeNull();
  });

  it("returns null for non-CBOR junk", () => {
    expect(decodeMixDatumInline("ff")).toBeNull();
  });

  it("returns null for wrong tag (Constr 1 instead of 0)", () => {
    // d87a80 = Constr 1 [] (the Replenish redeemer shape) — not a MixDatum.
    expect(decodeMixDatumInline("d87a80")).toBeNull();
  });

  it("returns null when a or b is the wrong length", () => {
    // Constr 0 [bytes(48 zeros), bytes(31 zeros)] — b is 1 byte short.
    // Hand-craft minimal CBOR: tag 121 (d879), array(2) = 82,
    // bytes(48): 5830 + 48 zeros, bytes(31): 581f + 31 zeros.
    const cbor = "d8798258300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000581f00000000000000000000000000000000000000000000000000000000000000";
    expect(decodeMixDatumInline(cbor)).toBeNull();
  });

  it("returns null when a == b (would fail on-chain)", () => {
    const { a } = makeAB(5n);
    // Use the same point for both.
    const cborHex = encodeMixDatumWithoutAssertion(a, a);
    expect(decodeMixDatumInline(cborHex)).toBeNull();
  });
});

describe("pool/identify — filterPoolEntries", () => {
  it("keeps only well-formed mix-script UTxOs at denom", () => {
    const aGood = makeAB(3n, 9n);
    const aGood2 = makeAB(7n, 13n);
    const goodA: Utxo = makeUtxo("aa".repeat(32), 0, encodeMixDatum(aGood));
    const goodB: Utxo = makeUtxo("bb".repeat(32), 1, encodeMixDatum(aGood2));
    const wrongAddr: Utxo = makeUtxo("cc".repeat(32), 0, encodeMixDatum(aGood), {
      address: "addr_test1qqotherother",
    });
    const wrongValue: Utxo = makeUtxo("dd".repeat(32), 0, encodeMixDatum(aGood), {
      lovelace: DENOM - 1n,
    });
    const withAssets: Utxo = makeUtxo("ee".repeat(32), 0, encodeMixDatum(aGood), {
      assets: { "policy1.tok": 1n },
    });
    const noDatum: Utxo = makeUtxo("ff".repeat(32), 0, null);
    const badDatum: Utxo = makeUtxo("11".repeat(32), 0, "ff");

    const out = filterPoolEntries({
      utxos: [goodA, wrongAddr, wrongValue, withAssets, noDatum, badDatum, goodB],
      mixBoxAddressBech32: MIX_BOX_ADDR,
      denomLovelace: DENOM,
    });
    expect(out.map((e) => e.ref.txId)).toEqual([goodA.ref.txId, goodB.ref.txId]);
    expect(out[0]!.a).toEqual(aGood.a);
    expect(out[0]!.b).toEqual(aGood.b);
  });

  it("returns an empty array when no UTxOs match", () => {
    expect(
      filterPoolEntries({
        utxos: [],
        mixBoxAddressBech32: MIX_BOX_ADDR,
        denomLovelace: DENOM,
      }),
    ).toEqual([]);
  });
});

describe("pool/identify — ownsBox / findOwnedBoxes", () => {
  it("recognizes a box the secret unlocks", () => {
    const secret: Scalar = 42n;
    const ab = makeAB(secret, 17n);
    expect(ownsBox(secret, ab)).toBe(true);
  });

  it("rejects a box whose b ≠ [x]·a", () => {
    const ab = makeAB(42n, 17n);
    // Same a, different secret.
    expect(ownsBox(99n, ab)).toBe(false);
  });

  it("rejects malformed (a, b) without throwing", () => {
    const garbage = { a: new Uint8Array(48), b: new Uint8Array(48) };
    // The all-zero compressed encoding fails the subgroup check; ownsBox
    // catches the throw and returns false rather than propagating.
    expect(ownsBox(1n, garbage)).toBe(false);
  });

  it("filters a list of pool entries to the ones the secret owns", () => {
    const mySecret = 5n;
    const myAB = makeAB(mySecret, 19n);
    const otherAB = makeAB(99n, 23n);
    const my: PoolEntry = {
      ref: { txId: "11".repeat(32), outputIndex: 0 },
      a: myAB.a,
      b: myAB.b,
      utxo: makeUtxo("11".repeat(32), 0, encodeMixDatum(myAB)),
    };
    const other: PoolEntry = {
      ref: { txId: "22".repeat(32), outputIndex: 0 },
      a: otherAB.a,
      b: otherAB.b,
      utxo: makeUtxo("22".repeat(32), 0, encodeMixDatum(otherAB)),
    };
    const owned = findOwnedBoxes(mySecret, [my, other]);
    expect(owned).toHaveLength(1);
    expect(owned[0]!.ref.txId).toBe(my.ref.txId);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Bypass `encodeMixDatum`'s `a !== b` assertion to produce the malformed
 * CBOR a real bad-faith actor might emit. Used only in tests.
 */
function encodeMixDatumWithoutAssertion(a: Uint8Array, b: Uint8Array): string {
  // Hand-roll the same Plutus-Data CBOR shape the encoder produces, but skip
  // the safety check.
  // Constr 0 = tag 121 (CBOR major 6 with value 121 = 0xd879), array of 2
  // elements (CBOR major 4: 0x82), each bytes(48) (CBOR major 2 with len 48
  // = 0x5830 prefix).
  let s = "d87982";
  s += "5830" + bytesToHex(a);
  s += "5830" + bytesToHex(b);
  return s;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
