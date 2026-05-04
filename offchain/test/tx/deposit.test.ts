// Unit tests for tx/deposit.ts.
//
// We focus on the pure planning surface (`planDepositTx` + `encodeMixDatum`
// + `deriveOwner`). The mesh-driven `buildDepositTx` is exercised by the
// Preprod integration test — replicating mesh's tx-building behaviour
// inside a unit test would either bring back the libsodium load problem
// or test mesh's mock instead of our SDK.

import { describe, expect, it } from "vitest";
import { decode as cborDecode } from "cbor-x";

import {
  G1_COMPRESSED_BYTES,
  generator,
  pointFromBytes,
  pointEqual,
  pointToBytes,
  publicPointG,
  scalarMul,
  SCALAR_ORDER,
} from "../../src/crypto/index.js";
import {
  PAY_MIX_FEE_REDEEMER_CBOR_HEX,
  REPLENISH_REDEEMER_CBOR_HEX,
  UNIT_DATUM_CBOR_HEX,
  assertOwnerSecret,
  deriveOwner,
  encodeMixDatum,
  generateOwnerSecret,
  planBulkDepositTx,
  planDepositTx,
} from "../../src/tx/deposit.js";
import type { LovejoinAddresses, ProtocolParams } from "../../src/tx/params.js";
import type { Utxo } from "../../src/chain/provider.js";
import { buildEnterpriseScriptAddress } from "../../src/tx/address.js";

const ADDRESSES: LovejoinAddresses = {
  network: "preprod",
  protocol: { denom_lovelace: 10_000_000, max_fee_per_mix_lovelace: 800_000 },
  referenceNftPolicy: "310d0d4ff25e73a4a0442eac873e68810e11c824aa0e858acc56f1df",
  referenceNftAssetName: "6c6f76656a6f696e",
  referenceUtxoRef: "b809b4e363067886174b57fd04101eb2e59f654220b6c11530c77b75f25ec945#0",
  referenceHolderScriptHash: "b58b5869a956266f5a55265829963064cabfeac4dab3c28f46dbc1cc",
  mixLogicScriptHash: "ca2d95fe9fe368e8ad1c89e2009a5ad292ff016e353144ea0ef829ff",
  mixBoxScriptHash: "ba176a7604f3e062a7ed315780801495ed0ffb0191c6f8e7d88362e2",
  feeScriptHash: "5efd8fdd7e4d35b04de427337220dcb30352136d739055b305dd2d66",
  feeShardUtxos: ["34a117d9699e8537529aa093943cdeda6f525fd167a74e6f1bd9229ef805a080#0"],
  referenceScriptUtxos: {
    mix_box: "b51692abb805409936944691abd324f2dcdd025749b9094dbd49939588c7e27f#0",
    mix_logic: "d65e2a074a45c6f24b42fe60924d8e35cb26412985d98480a4e96b5b89a2a727#0",
    fee_contract: "5d9a9e2c26aeffcddb0d0f6e4cc07b62df546a8615bd5bd2aca673561e3600b6#0",
  },
};

const PARAMS: ProtocolParams = {
  denomLovelace: 10_000_000n,
  maxFeePerMixLovelace: 800_000n,
  mixScriptHash: ADDRESSES.mixBoxScriptHash,
  mixLogicScriptHash: ADDRESSES.mixLogicScriptHash,
  feeScriptHash: ADDRESSES.feeScriptHash,
};

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function feeShard(lovelace: bigint = 5_000_000n): Utxo {
  return {
    ref: {
      txId: "34a117d9699e8537529aa093943cdeda6f525fd167a74e6f1bd9229ef805a080",
      outputIndex: 0,
    },
    address: buildEnterpriseScriptAddress(ADDRESSES.feeScriptHash, 0),
    lovelace,
    assets: {},
    inlineDatum: UNIT_DATUM_CBOR_HEX,
    referenceScript: null,
  };
}

describe("tx/deposit — encodeMixDatum", () => {
  it("encodes Constr 0 [a, b] with the canonical Plutus tag", () => {
    const a = pointToBytes(generator());
    const b = pointToBytes(publicPointG(2n));
    const hex = encodeMixDatum({ a, b });
    expect(hex.startsWith("d87982")).toBe(true); // tag 121 + array(2)
    const decoded = cborDecode(Buffer.from(hex, "hex")) as { tag: number; value: unknown[] };
    expect(decoded.tag).toBe(121);
    expect(decoded.value.length).toBe(2);
    expect((decoded.value[0] as Uint8Array).length).toBe(G1_COMPRESSED_BYTES);
    expect((decoded.value[1] as Uint8Array).length).toBe(G1_COMPRESSED_BYTES);
  });

  it("rejects datums with a == b", () => {
    const a = pointToBytes(generator());
    expect(() => encodeMixDatum({ a, b: a })).toThrow(/equal/);
  });

  it("rejects misshaped point bytes", () => {
    const tooShort = new Uint8Array(47);
    const a = pointToBytes(generator());
    expect(() => encodeMixDatum({ a, b: tooShort })).toThrow(/48 bytes/);
    expect(() => encodeMixDatum({ a: tooShort, b: a })).toThrow(/48 bytes/);
  });
});

describe("tx/deposit — owner secret material", () => {
  it("rejects out-of-range scalars", () => {
    expect(() => assertOwnerSecret(0n)).toThrow();
    expect(() => assertOwnerSecret(SCALAR_ORDER)).toThrow();
    expect(() => assertOwnerSecret(SCALAR_ORDER + 1n)).toThrow();
  });

  it("derives a deterministic public point from the secret (legacy a == g)", () => {
    const owner = deriveOwner(0x1337n);
    expect(owner.publicPointHex).toHaveLength(96);
    expect(owner.aHex).toBe(bytesToHex(pointToBytes(generator())));
    expect(owner.secretHex).toHaveLength(64);
    expect(owner.label).toBe(owner.publicPointHex.slice(0, 16));
  });

  it("derives b = [x]·a when the box's a is supplied (re-randomized)", () => {
    // Simulate a deposit-time a = [7]·g. The owner secret is 0x1337.
    const a = pointToBytes(scalarMul(7n, generator()));
    const owner = deriveOwner(0x1337n, a);
    expect(owner.aHex).toBe(bytesToHex(a));
    // b = [x]·a = [0x1337 · 7]·g
    const expectedB = pointToBytes(scalarMul(0x1337n, scalarMul(7n, generator())));
    expect(owner.publicPointHex).toBe(bytesToHex(expectedB));
  });

  it("generates fresh secrets in [1, r)", () => {
    for (let i = 0; i < 200; i++) {
      const s = generateOwnerSecret();
      expect(s).toBeGreaterThan(0n);
      expect(s).toBeLessThan(SCALAR_ORDER);
    }
  });

  it("supports an injected RNG for determinism in tests", () => {
    const stub = (() => {
      const buf = new Uint8Array(32);
      buf[31] = 0x42; // a tiny known scalar
      return () => buf;
    })();
    const s = generateOwnerSecret(stub);
    expect(s).toBe(0x42n);
  });

  it("rejects a deposit's a == identity (audit F-3 SDK guard)", () => {
    // If `a == identity` ever made it into a mix-box datum, the Schnorr
    // equation `[z]·a == t + [c]·b` would degenerate to `t == [c]·b`,
    // which (combined with `b == identity` next door) gives the box
    // away to anyone. The on-chain validator can't catch this because
    // there's no entry-time logic; the SDK is the only line of defense.
    const infBytes = new Uint8Array(48);
    infBytes[0] = 0xc0;
    expect(() => deriveOwner(0x1337n, infBytes)).toThrow(/identity/);
  });
});

describe("tx/deposit — planDepositTx", () => {
  it("places mix-box at output 0 with denom + a re-randomized MixDatum", () => {
    const plan = planDepositTx({
      ownerSecret: 0x1337n,
      rounds: 30,
      params: PARAMS,
      addresses: ADDRESSES,
      feeShard: feeShard(),
      networkId: 0,
    });
    expect(plan.mixBoxOutput.addressBech32).toBe(
      buildEnterpriseScriptAddress(ADDRESSES.mixBoxScriptHash, 0),
    );
    expect(plan.mixBoxOutput.lovelace).toBe(10_000_000n);
    // Default re-randomization: a ≠ g (would let observers fingerprint
    // fresh deposits as `a == g` otherwise).
    expect(plan.a).not.toEqual(pointToBytes(generator()));
    // Validator's invariant: b == [x]·a still holds for any a, x.
    const aPt = pointFromBytes(plan.a);
    const bPt = pointFromBytes(plan.b);
    expect(pointEqual(scalarMul(0x1337n, aPt), bPt)).toBe(true);
  });

  it("supports an explicit re-randomization scalar (a == [d]·g, b == [x·d]·g)", () => {
    const plan = planDepositTx({
      ownerSecret: 0x1337n,
      rerandomization: 7n,
      rounds: 30,
      params: PARAMS,
      addresses: ADDRESSES,
      feeShard: feeShard(),
      networkId: 0,
    });
    expect(plan.a).toEqual(pointToBytes(scalarMul(7n, generator())));
    expect(plan.b).toEqual(pointToBytes(scalarMul(0x1337n, scalarMul(7n, generator()))));
  });

  it("falls back to the legacy a == g shape when rerandomization is null", () => {
    const plan = planDepositTx({
      ownerSecret: 0x1337n,
      rerandomization: null,
      rounds: 30,
      params: PARAMS,
      addresses: ADDRESSES,
      feeShard: feeShard(),
      networkId: 0,
    });
    expect(plan.a).toEqual(pointToBytes(generator()));
    expect(plan.b).toEqual(pointToBytes(publicPointG(0x1337n)));
  });

  it("computes the replenishment correctly", () => {
    const plan = planDepositTx({
      ownerSecret: 0x42n,
      rounds: 30,
      params: PARAMS,
      addresses: ADDRESSES,
      feeShard: feeShard(5_000_000n),
      networkId: 0,
    });
    expect(plan.feeShardOutput.lovelace).toBe(5_000_000n + 30n * 800_000n);
    expect(plan.feeShardOutput.inlineDatumHex).toBe(UNIT_DATUM_CBOR_HEX);
  });

  it("sets the Replenish redeemer (CBOR Constr 1 [])", () => {
    const plan = planDepositTx({
      ownerSecret: 2n,
      rounds: 5,
      params: PARAMS,
      addresses: ADDRESSES,
      feeShard: feeShard(),
      networkId: 0,
    });
    expect(plan.replenishRedeemerHex).toBe(REPLENISH_REDEEMER_CBOR_HEX);
    // Sanity: REPLENISH != PAY_MIX_FEE.
    expect(REPLENISH_REDEEMER_CBOR_HEX).not.toBe(PAY_MIX_FEE_REDEEMER_CBOR_HEX);
  });

  it("populates reference UTxO + fee_contract reference script refs", () => {
    const plan = planDepositTx({
      ownerSecret: 2n,
      rounds: 5,
      params: PARAMS,
      addresses: ADDRESSES,
      feeShard: feeShard(),
      networkId: 0,
    });
    expect(plan.referenceUtxoRef).toEqual({
      txId: "b809b4e363067886174b57fd04101eb2e59f654220b6c11530c77b75f25ec945",
      outputIndex: 0,
    });
    expect(plan.feeContractRefScriptUtxoRef).toEqual({
      txId: "5d9a9e2c26aeffcddb0d0f6e4cc07b62df546a8615bd5bd2aca673561e3600b6",
      outputIndex: 0,
    });
  });

  it("generates a fresh secret when ownerSecret is omitted", () => {
    const plan1 = planDepositTx({
      rounds: 5,
      params: PARAMS,
      addresses: ADDRESSES,
      feeShard: feeShard(),
      networkId: 0,
    });
    const plan2 = planDepositTx({
      rounds: 5,
      params: PARAMS,
      addresses: ADDRESSES,
      feeShard: feeShard(),
      networkId: 0,
    });
    expect(plan1.ownerSecret).not.toBe(plan2.ownerSecret);
  });

  it("propagates minRounds enforcement", () => {
    expect(() =>
      planDepositTx({
        ownerSecret: 2n,
        rounds: 3,
        minRounds: 5,
        params: PARAMS,
        addresses: ADDRESSES,
        feeShard: feeShard(),
        networkId: 0,
      }),
    ).toThrow(/below minRounds/);
  });
});

describe("tx/deposit — planBulkDepositTx", () => {
  it("plans N=3 boxes with distinct datums and a single replenished shard", () => {
    const secrets = [3n, 5n, 7n];
    const plan = planBulkDepositTx({
      ownerSecrets: secrets,
      // null-rerandomization opts into the legacy a=g path so the test
      // stays deterministic; production callers pass undefined to draw
      // fresh d_i per box.
      rerandomizations: [null, null, null],
      rounds: 4,
      params: PARAMS,
      addresses: ADDRESSES,
      feeShard: feeShard(2_000_000n),
      networkId: 0,
    });
    expect(plan.boxes).toHaveLength(3);
    // Each box has its own (a, b); a = g, b_i = [x_i]·g.
    for (let i = 0; i < 3; i++) {
      const x = secrets[i]!;
      const expectedA = pointToBytes(generator());
      const expectedB = pointToBytes(publicPointG(x));
      expect(bytesToHex(plan.boxes[i]!.a)).toBe(bytesToHex(expectedA));
      expect(bytesToHex(plan.boxes[i]!.b)).toBe(bytesToHex(expectedB));
      expect(plan.boxes[i]!.output.lovelace).toBe(PARAMS.denomLovelace);
    }
    // Datums must all be distinct.
    const datumHexes = plan.boxes.map((b) => b.output.inlineDatumHex);
    expect(new Set(datumHexes).size).toBe(3);
    // Replenishment = shard + N × rounds × maxFee.
    expect(plan.feeShardOutput.lovelace).toBe(
      2_000_000n + BigInt(3) * BigInt(4) * PARAMS.maxFeePerMixLovelace,
    );
    expect(plan.feeShardOutput.inlineDatumHex).toBe(UNIT_DATUM_CBOR_HEX);
    expect(plan.replenishRedeemerHex).toBe(REPLENISH_REDEEMER_CBOR_HEX);
  });

  it("rejects an empty ownerSecrets list", () => {
    expect(() =>
      planBulkDepositTx({
        ownerSecrets: [],
        rounds: 1,
        params: PARAMS,
        addresses: ADDRESSES,
        feeShard: feeShard(),
        networkId: 0,
      }),
    ).toThrow(/at least one secret/);
  });

  it("rejects rerandomizations of mismatched length", () => {
    expect(() =>
      planBulkDepositTx({
        ownerSecrets: [3n, 5n],
        rerandomizations: [null],
        rounds: 1,
        params: PARAMS,
        addresses: ADDRESSES,
        feeShard: feeShard(),
        networkId: 0,
      }),
    ).toThrow(/length/);
  });

  it("rejects duplicate datums", () => {
    // Same secret + same legacy `a=g` re-randomization → same datum.
    expect(() =>
      planBulkDepositTx({
        ownerSecrets: [3n, 3n],
        rerandomizations: [null, null],
        rounds: 1,
        params: PARAMS,
        addresses: ADDRESSES,
        feeShard: feeShard(),
        networkId: 0,
      }),
    ).toThrow(/duplicate/);
  });

  it("scales replenishment linearly with N", () => {
    const planN1 = planBulkDepositTx({
      ownerSecrets: [11n],
      rerandomizations: [null],
      rounds: 5,
      params: PARAMS,
      addresses: ADDRESSES,
      feeShard: feeShard(0n),
      networkId: 0,
    });
    const planN4 = planBulkDepositTx({
      ownerSecrets: [11n, 12n, 13n, 14n],
      rerandomizations: [null, null, null, null],
      rounds: 5,
      params: PARAMS,
      addresses: ADDRESSES,
      feeShard: feeShard(0n),
      networkId: 0,
    });
    expect(planN4.feeShardOutput.lovelace).toBe(planN1.feeShardOutput.lovelace * 4n);
  });
});
