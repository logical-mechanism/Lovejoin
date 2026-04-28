// Unit tests for tx/mix.ts.
//
// We focus on the pure planning surface (`planMixTx`, `encodeMixRedeemer`,
// `encodeAdaOnlyValueCbor`, `computeMixCtx`, `verifyMixPlanWithHash`).
// `buildMixTx` is exercised by the Preprod integration test — we don't try
// to mock mesh's tx-builder internals here.

import { describe, expect, it } from "vitest";

import {
  G1_COMPRESSED_BYTES,
  type Scalar,
  generator,
  pointEqual,
  pointFromBytes,
  pointToBytes,
  scalarMul,
  verifySigmaOr,
  type DHTupleStatement,
} from "../../src/crypto/index.js";
import {
  PAY_MIX_FEE_REDEEMER_CBOR_HEX,
  FEE_UNIT_DATUM_CBOR_HEX,
  computeMixCtx,
  encodeAdaOnlyValueCbor,
  encodeMixRedeemer,
  type MixInput,
  type MixPlan,
  type MixProofPlan,
  planMixTx,
  verifyMixPlanWithHash,
} from "../../src/tx/mix.js";
import { encodeMixDatum, UNIT_DATUM_CBOR_HEX } from "../../src/tx/deposit.js";
import { buildEnterpriseScriptAddress } from "../../src/tx/address.js";
import type { LovejoinAddresses, ProtocolParams } from "../../src/tx/params.js";
import type { Utxo } from "../../src/chain/provider.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ADDRESSES: LovejoinAddresses = {
  network: "preprod",
  protocol: { denom_lovelace: 10_000_000, max_fee_per_mix_lovelace: 800_000, fee_shard_target: 10 },
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
  feeShardTarget: 10,
};

const MIX_BOX_ADDRESS = buildEnterpriseScriptAddress(ADDRESSES.mixBoxScriptHash, 0);
const FEE_ADDRESS = buildEnterpriseScriptAddress(ADDRESSES.feeScriptHash, 0);

function makeMixInput(
  txId: string,
  outputIndex: number,
  ownerSecret: Scalar,
  dScalar: Scalar = 1n,
): MixInput {
  // Same shape as a deposit-time-re-randomized box: a = [d]·g, b = [x]·a.
  const aPoint = scalarMul(dScalar, generator());
  const bPoint = scalarMul(ownerSecret, aPoint);
  const a = pointToBytes(aPoint);
  const b = pointToBytes(bPoint);
  const utxo: Utxo = {
    ref: { txId, outputIndex },
    address: MIX_BOX_ADDRESS,
    lovelace: PARAMS.denomLovelace,
    assets: {},
    inlineDatum: encodeMixDatum({ a, b }),
    referenceScript: null,
  };
  return { ref: utxo.ref, a, b, utxo };
}

function makeFeeShard(lovelace: bigint = 50_000_000n): Utxo {
  return {
    ref: {
      txId: "34a117d9699e8537529aa093943cdeda6f525fd167a74e6f1bd9229ef805a080",
      outputIndex: 0,
    },
    address: FEE_ADDRESS,
    lovelace,
    assets: {},
    inlineDatum: UNIT_DATUM_CBOR_HEX,
    referenceScript: null,
  };
}

// ---------------------------------------------------------------------------
// encodeAdaOnlyValueCbor
// ---------------------------------------------------------------------------

describe("tx/mix — encodeAdaOnlyValueCbor", () => {
  it("emits canonical Plutus-Data CBOR for the protocol denom", () => {
    // 10_000_000 = 0x989680 → fits in u32 → `1A 00 98 96 80`.
    // Outer map: A1 40 A1 40 1A 00 98 96 80
    const out = encodeAdaOnlyValueCbor(10_000_000n);
    expect(bytesToHex(out)).toBe("a140a1401a00989680");
  });

  it("emits the smallest CBOR int form for tiny values", () => {
    // 0 → A1 40 A1 40 00; 5 → ... 05; 23 → ... 17.
    expect(bytesToHex(encodeAdaOnlyValueCbor(0n))).toBe("a140a14000");
    expect(bytesToHex(encodeAdaOnlyValueCbor(5n))).toBe("a140a14005");
    expect(bytesToHex(encodeAdaOnlyValueCbor(23n))).toBe("a140a14017");
  });

  it("rolls into 1/2/4/8-byte forms at the right thresholds", () => {
    expect(bytesToHex(encodeAdaOnlyValueCbor(24n))).toBe("a140a1401818");
    expect(bytesToHex(encodeAdaOnlyValueCbor(255n))).toBe("a140a14018ff");
    expect(bytesToHex(encodeAdaOnlyValueCbor(256n))).toBe("a140a140190100");
    expect(bytesToHex(encodeAdaOnlyValueCbor(65_535n))).toBe("a140a14019ffff");
    expect(bytesToHex(encodeAdaOnlyValueCbor(65_536n))).toBe("a140a1401a00010000");
    expect(bytesToHex(encodeAdaOnlyValueCbor(4_294_967_295n))).toBe("a140a1401affffffff");
    expect(bytesToHex(encodeAdaOnlyValueCbor(4_294_967_296n))).toBe(
      "a140a1401b0000000100000000",
    );
  });

  it("rejects negative input", () => {
    expect(() => encodeAdaOnlyValueCbor(-1n)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// encodeMixRedeemer
// ---------------------------------------------------------------------------

describe("tx/mix — encodeMixRedeemer", () => {
  function makeBranch(): MixProofPlan["branches"][number] {
    return {
      t0: new Uint8Array(48),
      t1: new Uint8Array(48),
      c: new Uint8Array(32),
      z: new Uint8Array(32),
    };
  }

  it("wraps proofs in Constr 1 (CBOR tag 122)", () => {
    const proof: MixProofPlan = { branches: [makeBranch(), makeBranch()] };
    const hex = encodeMixRedeemer([proof, proof]);
    expect(hex.startsWith("d87a")).toBe(true);
  });

  it("rejects N < 2", () => {
    const proof: MixProofPlan = { branches: [makeBranch(), makeBranch()] };
    expect(() => encodeMixRedeemer([proof])).toThrow();
  });

  it("rejects branches with wrong byte lengths", () => {
    const bad: MixProofPlan = {
      branches: [
        { ...makeBranch(), t0: new Uint8Array(47) }, // 47 instead of 48
        makeBranch(),
      ],
    };
    expect(() => encodeMixRedeemer([bad, bad])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// computeMixCtx
// ---------------------------------------------------------------------------

describe("tx/mix — computeMixCtx", () => {
  it("produces a 32-byte digest", () => {
    const datums = [new Uint8Array(20), new Uint8Array(20)];
    const values = [encodeAdaOnlyValueCbor(10n), encodeAdaOnlyValueCbor(10n)];
    const ctx = computeMixCtx({
      outputDatums: datums,
      outputValues: values,
      mixScriptHashHex: ADDRESSES.mixBoxScriptHash,
    });
    expect(ctx).toHaveLength(32);
  });

  it("changes when ANY input bit flips", () => {
    const datums = [new Uint8Array(20), new Uint8Array(20)];
    const values = [encodeAdaOnlyValueCbor(10n), encodeAdaOnlyValueCbor(10n)];
    const ctx0 = computeMixCtx({
      outputDatums: datums,
      outputValues: values,
      mixScriptHashHex: ADDRESSES.mixBoxScriptHash,
    });
    const flippedDatum = new Uint8Array(20);
    flippedDatum[0] = 1;
    const ctx1 = computeMixCtx({
      outputDatums: [flippedDatum, datums[1]!],
      outputValues: values,
      mixScriptHashHex: ADDRESSES.mixBoxScriptHash,
    });
    expect(ctx0).not.toEqual(ctx1);
  });

  it("rejects a non-28-byte mix script hash", () => {
    expect(() =>
      computeMixCtx({
        outputDatums: [],
        outputValues: [],
        mixScriptHashHex: "abcd",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// planMixTx — full plan + proof verification
// ---------------------------------------------------------------------------

describe("tx/mix — planMixTx", () => {
  it("plans a 2-input mix and locally verifies every proof", () => {
    const inputs = [
      makeMixInput("aa".repeat(32), 0, 7n, 11n),
      makeMixInput("bb".repeat(32), 1, 13n, 17n),
    ];
    const ySecrets: Scalar[] = [3n, 5n];
    const permutation = [1, 0]; // swap

    const plan = planMixTx({
      inputs,
      ySecrets,
      permutation,
      params: PARAMS,
      addresses: ADDRESSES,
      feeShard: makeFeeShard(),
      networkId: 0,
    });

    expect(plan.n).toBe(2);
    expect(plan.inputs).toHaveLength(2);
    expect(plan.outputs).toHaveLength(2);
    expect(plan.proofs).toHaveLength(2);
    expect(plan.txFeeLovelace).toBe(PARAMS.maxFeePerMixLovelace);

    // Every proof must verify locally.
    expect(verifyMixPlanWithHash(plan, PARAMS.mixScriptHash)).toBe(-1);

    // Fee shard balance: in - out = tx.fee.
    expect(plan.feeShardOutput.lovelace).toBe(
      makeFeeShard().lovelace - plan.txFeeLovelace,
    );
  });

  it("produces output (a', b') = ([y_i]·a_i, [y_i]·b_i) at permutation[i]", () => {
    const inputs = [
      makeMixInput("00".repeat(31) + "01", 0, 7n, 11n),
      makeMixInput("00".repeat(31) + "02", 0, 13n, 17n),
    ];
    const ySecrets: Scalar[] = [3n, 5n];
    const permutation = [0, 1]; // identity

    const plan = planMixTx({
      inputs,
      ySecrets,
      permutation,
      params: PARAMS,
      addresses: ADDRESSES,
      feeShard: makeFeeShard(),
      networkId: 0,
    });

    // Sorted inputs: byte-lex on txId. 0...01 < 0...02, so order is
    // [inputs[0], inputs[1]].
    for (let i = 0; i < 2; i++) {
      const inp = plan.inputs[i]!;
      const expectedA = scalarMul(ySecrets[i]!, pointFromBytes(inp.a));
      const expectedB = scalarMul(ySecrets[i]!, pointFromBytes(inp.b));
      const out = plan.outputs[permutation[i]!]!;
      expect(pointEqual(pointFromBytes(out.a), expectedA)).toBe(true);
      expect(pointEqual(pointFromBytes(out.b), expectedB)).toBe(true);
    }
  });

  it("sorts inputs lexicographically by (txId, outputIndex)", () => {
    // Same txId, indices flipped — the validator sees them sorted by index.
    const txId = "ab".repeat(32);
    const inputs = [
      makeMixInput(txId, 5, 11n, 13n),
      makeMixInput(txId, 2, 7n, 9n),
    ];
    const plan = planMixTx({
      inputs,
      ySecrets: [3n, 5n],
      permutation: [0, 1],
      params: PARAMS,
      addresses: ADDRESSES,
      feeShard: makeFeeShard(),
      networkId: 0,
    });
    expect(plan.inputs[0]!.ref.outputIndex).toBe(2);
    expect(plan.inputs[1]!.ref.outputIndex).toBe(5);
  });

  it("plans variable N at 2, 3, 4, 6, 8 with random data", () => {
    for (const n of [2, 3, 4, 6, 8]) {
      const inputs: MixInput[] = [];
      const ys: Scalar[] = [];
      for (let i = 0; i < n; i++) {
        const txId = (i + 1).toString(16).padStart(64, "0");
        inputs.push(makeMixInput(txId, 0, BigInt(7 + i), BigInt(11 + i)));
        ys.push(BigInt(3 + i));
      }
      const perm: number[] = [];
      for (let i = 0; i < n; i++) perm.push((i + 1) % n);
      const plan = planMixTx({
        inputs,
        ySecrets: ys,
        permutation: perm,
        params: PARAMS,
        addresses: ADDRESSES,
        feeShard: makeFeeShard(),
        networkId: 0,
      });
      expect(plan.n).toBe(n);
      expect(verifyMixPlanWithHash(plan, PARAMS.mixScriptHash)).toBe(-1);
    }
  });

  it("rejects N < 2", () => {
    const inputs = [makeMixInput("aa".repeat(32), 0, 7n, 11n)];
    expect(() =>
      planMixTx({
        inputs,
        params: PARAMS,
        addresses: ADDRESSES,
        feeShard: makeFeeShard(),
        networkId: 0,
      }),
    ).toThrow();
  });

  it("rejects duplicate input refs", () => {
    const inputs = [
      makeMixInput("aa".repeat(32), 0, 7n, 11n),
      makeMixInput("aa".repeat(32), 0, 5n, 13n),
    ];
    expect(() =>
      planMixTx({
        inputs,
        ySecrets: [3n, 5n],
        permutation: [0, 1],
        params: PARAMS,
        addresses: ADDRESSES,
        feeShard: makeFeeShard(),
        networkId: 0,
      }),
    ).toThrow();
  });

  it("rejects ySecrets with wrong length", () => {
    const inputs = [
      makeMixInput("aa".repeat(32), 0, 7n, 11n),
      makeMixInput("bb".repeat(32), 0, 5n, 13n),
    ];
    expect(() =>
      planMixTx({
        inputs,
        ySecrets: [3n], // length mismatch
        params: PARAMS,
        addresses: ADDRESSES,
        feeShard: makeFeeShard(),
        networkId: 0,
      }),
    ).toThrow();
  });

  it("rejects permutation that isn't a bijection", () => {
    const inputs = [
      makeMixInput("aa".repeat(32), 0, 7n, 11n),
      makeMixInput("bb".repeat(32), 0, 5n, 13n),
    ];
    expect(() =>
      planMixTx({
        inputs,
        ySecrets: [3n, 5n],
        permutation: [0, 0], // duplicate
        params: PARAMS,
        addresses: ADDRESSES,
        feeShard: makeFeeShard(),
        networkId: 0,
      }),
    ).toThrow();
  });

  it("rejects ySecrets outside [1, r)", () => {
    const inputs = [
      makeMixInput("aa".repeat(32), 0, 7n, 11n),
      makeMixInput("bb".repeat(32), 0, 5n, 13n),
    ];
    expect(() =>
      planMixTx({
        inputs,
        ySecrets: [0n, 5n], // 0 invalid
        params: PARAMS,
        addresses: ADDRESSES,
        feeShard: makeFeeShard(),
        networkId: 0,
      }),
    ).toThrow();
  });

  it("rejects txFeeLovelace > max_fee_per_mix", () => {
    const inputs = [
      makeMixInput("aa".repeat(32), 0, 7n, 11n),
      makeMixInput("bb".repeat(32), 0, 5n, 13n),
    ];
    expect(() =>
      planMixTx({
        inputs,
        ySecrets: [3n, 5n],
        permutation: [0, 1],
        params: PARAMS,
        addresses: ADDRESSES,
        feeShard: makeFeeShard(),
        networkId: 0,
        txFeeLovelace: PARAMS.maxFeePerMixLovelace + 1n,
      }),
    ).toThrow();
  });

  it("rejects fee shard with insufficient lovelace", () => {
    const inputs = [
      makeMixInput("aa".repeat(32), 0, 7n, 11n),
      makeMixInput("bb".repeat(32), 0, 5n, 13n),
    ];
    expect(() =>
      planMixTx({
        inputs,
        ySecrets: [3n, 5n],
        permutation: [0, 1],
        params: PARAMS,
        addresses: ADDRESSES,
        feeShard: makeFeeShard(100n), // way below max_fee
        networkId: 0,
      }),
    ).toThrow();
  });

  it("uses canonical PayMixFee redeemer + unit datum bytes", () => {
    const inputs = [
      makeMixInput("aa".repeat(32), 0, 7n, 11n),
      makeMixInput("bb".repeat(32), 0, 5n, 13n),
    ];
    const plan = planMixTx({
      inputs,
      ySecrets: [3n, 5n],
      permutation: [0, 1],
      params: PARAMS,
      addresses: ADDRESSES,
      feeShard: makeFeeShard(),
      networkId: 0,
    });
    expect(plan.payMixFeeRedeemerCborHex).toBe(PAY_MIX_FEE_REDEEMER_CBOR_HEX);
    expect(plan.feeShardOutput.inlineDatumHex).toBe(FEE_UNIT_DATUM_CBOR_HEX);
  });
});

// ---------------------------------------------------------------------------
// Cross-check: verify the generated proof against the same statement vector.
// This is the "is the planner internally consistent" test.
// ---------------------------------------------------------------------------

describe("tx/mix — sigma-OR cross-verification", () => {
  it("every input's proof verifies against the output statement vector", () => {
    const inputs = [
      makeMixInput("11".repeat(32), 0, 21n, 31n),
      makeMixInput("22".repeat(32), 0, 41n, 43n),
      makeMixInput("33".repeat(32), 0, 47n, 53n),
    ];
    const ys: Scalar[] = [2n, 3n, 5n];
    const perm = [2, 0, 1];

    const plan = planMixTx({
      inputs,
      ySecrets: ys,
      permutation: perm,
      params: PARAMS,
      addresses: ADDRESSES,
      feeShard: makeFeeShard(),
      networkId: 0,
    });

    const datums = plan.outputs.map((o) => hexToBytes(o.inlineDatumHex));
    const values = plan.outputs.map(() => encodeAdaOnlyValueCbor(PARAMS.denomLovelace));
    const ctx = computeMixCtx({
      outputDatums: datums,
      outputValues: values,
      mixScriptHashHex: PARAMS.mixScriptHash,
    });
    const stmts: DHTupleStatement[] = plan.outputs.map((o) => ({
      ap: pointFromBytes(o.a),
      bp: pointFromBytes(o.b),
    }));
    for (let i = 0; i < plan.inputs.length; i++) {
      const inp = plan.inputs[i]!;
      const ok = verifySigmaOr(
        pointFromBytes(inp.a),
        pointFromBytes(inp.b),
        stmts,
        { branches: plan.proofs[i]!.branches },
        ctx,
      );
      expect(ok).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/^0x/i, "");
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Suppress unused-import warnings for symbols kept for readability.
void G1_COMPRESSED_BYTES;
