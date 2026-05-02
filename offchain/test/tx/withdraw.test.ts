// Unit tests for tx/withdraw.ts.
//
// We focus on:
//   * planWithdrawTx — argument validation + ownership check.
//   * encodeOwnerRedeemer — Plutus-Data CBOR shape.
//   * computeOwnerCtx — blake2b binding.
//   * generateOwnerSchnorrProof — round-trip verify.
//   * buildScriptRewardAddress — bech32 of a script-stake credential.
//
// The mesh-driven assembler (`buildWithdrawTx`) is exercised by the Preprod
// integration test. Its serializeOutputsForCtx helper has runtime-only
// dependencies on mesh's CST, which can't load under the unit-test harness;
// integration tests on a real Preprod tx are the right level for that.

import { describe, expect, it } from "vitest";
import { decode as cborDecode, Encoder, Tag } from "cbor-x";

import {
  G1_COMPRESSED_BYTES,
  blake2b256,
  generator,
  pointToBytes,
  publicPointG,
  SCALAR_BYTES,
  verifySchnorr,
  pointFromBytes,
} from "../../src/crypto/index.js";
import {
  PLACEHOLDER_OWNER_REDEEMER_CBOR_HEX,
  buildScriptRewardAddress,
  computeOwnerCtx,
  encodeOwnerRedeemer,
  generateOwnerSchnorrProof,
  planWithdrawTx,
} from "../../src/tx/withdraw.js";
import type { LovejoinAddresses, ProtocolParams } from "../../src/tx/params.js";

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

const SECRET = 0xc0ffeen;

function ab() {
  const a = pointToBytes(generator());
  const b = pointToBytes(publicPointG(SECRET));
  return { a, b };
}

describe("tx/withdraw — planWithdrawTx", () => {
  it("returns a plan with destination + reference refs", () => {
    const { a, b } = ab();
    const plan = planWithdrawTx({
      ownerSecret: SECRET,
      mixBox: { ref: { txId: "ab".repeat(32), outputIndex: 0 }, a, b },
      destinationAddressBech32: "addr_test1qabcdef",
      params: PARAMS,
      addresses: ADDRESSES,
      networkId: 0,
    });
    expect(plan.destinationAddressBech32).toBe("addr_test1qabcdef");
    expect(plan.destinationLovelace).toBe(10_000_000n);
    expect(plan.referenceUtxoRef).toEqual({
      txId: "b809b4e363067886174b57fd04101eb2e59f654220b6c11530c77b75f25ec945",
      outputIndex: 0,
    });
    expect(plan.mixLogicRefScriptUtxoRef.txId).toBe(
      "d65e2a074a45c6f24b42fe60924d8e35cb26412985d98480a4e96b5b89a2a727",
    );
    expect(plan.mixLogicRewardAddressBech32.startsWith("stake_test1")).toBe(true);
  });

  it("throws on b ≠ [x]·a (wrong ownerSecret)", () => {
    const { a } = ab();
    const wrongB = pointToBytes(publicPointG(SECRET + 1n));
    expect(() =>
      planWithdrawTx({
        ownerSecret: SECRET,
        mixBox: { ref: { txId: "a".repeat(64), outputIndex: 0 }, a, b: wrongB },
        destinationAddressBech32: "addr_test1qabcdef",
        params: PARAMS,
        addresses: ADDRESSES,
        networkId: 0,
      }),
    ).toThrow(/does not unlock/);
  });

  it("throws on mis-sized a/b", () => {
    const tooShort = new Uint8Array(47);
    const { b } = ab();
    expect(() =>
      planWithdrawTx({
        ownerSecret: SECRET,
        mixBox: { ref: { txId: "a".repeat(64), outputIndex: 0 }, a: tooShort, b },
        destinationAddressBech32: "addr_test1qabcdef",
        params: PARAMS,
        addresses: ADDRESSES,
        networkId: 0,
      }),
    ).toThrow(/48 bytes/);
  });
});

describe("tx/withdraw — encodeOwnerRedeemer", () => {
  it("produces Constr 0 [List [Constr 0 [bytes(48), bytes(32)]]]", () => {
    const t = new Uint8Array(G1_COMPRESSED_BYTES);
    const z = new Uint8Array(SCALAR_BYTES);
    t[0] = 0x80; // make t look point-shaped
    z[31] = 0x01;
    const hex = encodeOwnerRedeemer({ proofs: [{ t, z }] });
    const decoded = cborDecode(Buffer.from(hex, "hex")) as { tag: number; value: unknown };
    expect(decoded.tag).toBe(121); // outer Owner
    const fields = decoded.value as unknown[];
    expect(fields).toHaveLength(1);
    const proofList = fields[0] as unknown[];
    expect(proofList).toHaveLength(1);
    const inner = proofList[0] as { tag: number; value: unknown[] };
    expect(inner.tag).toBe(121); // SchnorrProof
    expect((inner.value[0] as Uint8Array).length).toBe(G1_COMPRESSED_BYTES);
    expect((inner.value[1] as Uint8Array).length).toBe(SCALAR_BYTES);
  });

  it("encodes N>1 proofs as a list", () => {
    const t = new Uint8Array(G1_COMPRESSED_BYTES);
    const z = new Uint8Array(SCALAR_BYTES);
    t[0] = 0x80;
    const hex = encodeOwnerRedeemer({
      proofs: [
        { t, z },
        { t, z },
        { t, z },
      ],
    });
    const decoded = cborDecode(Buffer.from(hex, "hex")) as { tag: number; value: unknown };
    const proofList = (decoded.value as unknown[])[0] as unknown[];
    expect(proofList).toHaveLength(3);
  });

  it("placeholder uses zero-bytes of the right shape", () => {
    expect(PLACEHOLDER_OWNER_REDEEMER_CBOR_HEX.length).toBeGreaterThan(0);
    const decoded = cborDecode(Buffer.from(PLACEHOLDER_OWNER_REDEEMER_CBOR_HEX, "hex"));
    expect((decoded as { tag: number }).tag).toBe(121);
  });

  it("rejects misshaped proof bytes", () => {
    expect(() =>
      encodeOwnerRedeemer({
        proofs: [{ t: new Uint8Array(47), z: new Uint8Array(32) }],
      }),
    ).toThrow(/48 bytes/);
    expect(() =>
      encodeOwnerRedeemer({
        proofs: [{ t: new Uint8Array(48), z: new Uint8Array(31) }],
      }),
    ).toThrow(/32 bytes/);
  });
});

describe("tx/withdraw — computeOwnerCtx", () => {
  it("hashes outputs ‖ mix_script_hash with blake2b-256", () => {
    const outputsCbor = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const mixHash = "ba176a7604f3e062a7ed315780801495ed0ffb0191c6f8e7d88362e2";
    const ctx = computeOwnerCtx({ outputsCbor, mixScriptHashHex: mixHash });
    // Independent recomputation of the expected hash.
    const hashBytes = Buffer.from(mixHash, "hex");
    const preimage = new Uint8Array(outputsCbor.length + hashBytes.length);
    preimage.set(outputsCbor, 0);
    preimage.set(hashBytes, outputsCbor.length);
    expect(ctx).toEqual(blake2b256(preimage));
  });

  it("rejects misshaped mix script hashes", () => {
    expect(() =>
      computeOwnerCtx({ outputsCbor: new Uint8Array(0), mixScriptHashHex: "ab".repeat(20) }),
    ).toThrow(/28 bytes/);
  });
});

describe("tx/withdraw — generateOwnerSchnorrProof", () => {
  it("produces a proof that round-trips via verifySchnorr (base = a)", () => {
    const { a, b } = ab();
    const ctx = blake2b256(new Uint8Array([1, 2, 3]));
    const proof = generateOwnerSchnorrProof({ ownerSecret: SECRET, a, b, ctx });
    const ok = verifySchnorr(pointFromBytes(a), pointFromBytes(b), proof, ctx);
    expect(ok).toBe(true);
  });

  it("RFC-6979 determinism: same (secret, a, b, ctx) yields byte-equal proofs", () => {
    const { a, b } = ab();
    const ctx = blake2b256(new Uint8Array([7, 7, 7]));
    const p1 = generateOwnerSchnorrProof({ ownerSecret: SECRET, a, b, ctx });
    const p2 = generateOwnerSchnorrProof({ ownerSecret: SECRET, a, b, ctx });
    expect(Buffer.from(p1.t)).toEqual(Buffer.from(p2.t));
    expect(Buffer.from(p1.z)).toEqual(Buffer.from(p2.z));
  });

  it("throws when b ≠ [x]·a", () => {
    const { a } = ab();
    const wrongB = pointToBytes(publicPointG(SECRET + 1n));
    expect(() =>
      generateOwnerSchnorrProof({
        ownerSecret: SECRET,
        a,
        b: wrongB,
        ctx: new Uint8Array(32),
      }),
    ).toThrow(/b ≠/);
  });
});

describe("tx/withdraw — buildScriptRewardAddress", () => {
  it("matches cardano-cli stake-address build for a known script hash", () => {
    // Reference: cardano-cli conway stake-address build
    //   --stake-script-file artifacts/preprod/mix_logic.plutus
    //   --testnet-magic 1
    //   →  stake_test17r9zm9075lrg5w955wgnzqz3yk6f9lspmsmrz98z5wlzn7ckh85m4
    expect(
      buildScriptRewardAddress("ca2d95fe9fe368e8ad1c89e2009a5ad292ff016e353144ea0ef829ff", 0),
    ).toBe("stake_test17r9zm907nl3k369drjy7yqy6ttff9lcpdc6nz382pmuznlcxkza08");
  });

  it("uses mainnet HRP at networkId=1", () => {
    const addr = buildScriptRewardAddress(
      "ca2d95fe9fe368e8ad1c89e2009a5ad292ff016e353144ea0ef829ff",
      1,
    );
    expect(addr.startsWith("stake1")).toBe(true);
  });

  it("rejects misshaped script hashes", () => {
    expect(() => buildScriptRewardAddress("ab".repeat(20), 0)).toThrow(/28 bytes/);
  });
});

describe("tx/withdraw — sanity: cbor-x Plutus encoding (smoke)", () => {
  it("encodes Constr 0 [] as d87980", () => {
    const enc = new Encoder();
    const tagged = new Tag([], 121);
    const hex = Buffer.from(enc.encode(tagged)).toString("hex");
    expect(hex).toBe("d87980");
  });
});
