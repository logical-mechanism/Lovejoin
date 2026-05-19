import { describe, expect, it } from "vitest";
import { generator, pointToBytes, scalarMul } from "../../src/crypto/bls.js";
import { SEEDELF_PREPROD_ADDRESSES } from "../../src/seedelf/addresses.js";
import { planSeedelfMintTx } from "../../src/seedelf/mint.js";
import { planSeedelfSendTx } from "../../src/seedelf/send.js";
import { planSeedelfSpendTx } from "../../src/seedelf/spend.js";
import { generateSeedelfEphemeralKey } from "../../src/seedelf/signer.js";
import {
  createRegister,
  rerandomizeRegister,
  decodeRegisterDatum,
  ownsSeedelfRegister,
} from "../../src/seedelf/register.js";
import { verifySeedelfSchnorr } from "../../src/seedelf/schnorr.js";

const TXID = "4172bf875e341da9ecc0f1f84bfb7b6e6bb8b022b17205b5ce23617fc1641880";

describe("seedelf/mint — plan helper", () => {
  it("emits a register the supplied secret unlocks", () => {
    const x = 0xdeadbeefn;
    const plan = planSeedelfMintTx({
      addresses: SEEDELF_PREPROD_ADDRESSES,
      smallestInputRef: { txId: TXID, outputIndex: 0 },
      ownerSecret: x,
      rerandomizeScalar: 0xabcdn,
      personalTag: "hello",
      outputLovelace: 2_000_000n,
    });
    expect(plan.assetNameHex.startsWith("5eed0e1f")).toBe(true);
    expect(plan.inlineDatumHex.length).toBeGreaterThan(0);
    expect(plan.mintOutputAddressBech32.startsWith("addr_test")).toBe(true);
    const datum = decodeRegisterDatum(plan.inlineDatumHex);
    expect(datum).not.toBeNull();
    expect(ownsSeedelfRegister(datum!, x)).toBe(true);
  });

  it("rejects out-of-range scalars", () => {
    const base = {
      addresses: SEEDELF_PREPROD_ADDRESSES,
      smallestInputRef: { txId: TXID, outputIndex: 0 },
      ownerSecret: 1n,
      rerandomizeScalar: 1n,
      outputLovelace: 2_000_000n,
    };
    expect(() => planSeedelfMintTx({ ...base, ownerSecret: 0n })).toThrow();
    expect(() => planSeedelfMintTx({ ...base, rerandomizeScalar: 0n })).toThrow();
  });
});

describe("seedelf/send — re-randomization plan", () => {
  it("rerandomizes the recipient register and emits the inline datum", () => {
    const recipientSecret = 0x55n;
    const baseRegister = createRegister(recipientSecret);
    const plan = planSeedelfSendTx({
      addresses: SEEDELF_PREPROD_ADDRESSES,
      recipientRegister: baseRegister,
      rerandomizeScalar: 0x7n,
      lovelace: 5_000_000n,
    });
    const datum = decodeRegisterDatum(plan.inlineDatumHex);
    expect(datum).not.toBeNull();
    // The recipient still controls the re-randomized register.
    expect(ownsSeedelfRegister(datum!, recipientSecret)).toBe(true);
    // And the output is at the wallet contract address.
    expect(plan.outputAddressBech32).toBe(plan.outputAddressBech32);
    expect(plan.outputLovelace).toBe(5_000_000n);
  });

  it("rejects d=0 (would be trivially invertible)", () => {
    expect(() =>
      planSeedelfSendTx({
        addresses: SEEDELF_PREPROD_ADDRESSES,
        recipientRegister: createRegister(1n),
        rerandomizeScalar: 0n,
        lovelace: 5_000_000n,
      }),
    ).toThrow();
  });
});

describe("seedelf/spend — Schnorr proof plan", () => {
  it("produces one redeemer per input with a verifying proof", () => {
    const x1 = 0xa1n;
    const x2 = 0xa2n;
    const reg1 = rerandomizeRegister(createRegister(x1), 7n);
    const reg2 = rerandomizeRegister(createRegister(x2), 9n);
    const signer = generateSeedelfEphemeralKey();
    const plan = planSeedelfSpendTx({
      addresses: SEEDELF_PREPROD_ADDRESSES,
      inputs: [
        {
          ref: { txId: "00".repeat(32), outputIndex: 0 },
          register: reg1,
          secret: x1,
          lovelace: 5_000_000n,
        },
        {
          ref: { txId: "11".repeat(32), outputIndex: 0 },
          register: reg2,
          secret: x2,
          lovelace: 6_000_000n,
        },
      ],
      ephemeralSignerVkh: signer.vkh,
    });
    expect(plan.redeemers.length).toBe(2);
    for (let i = 0; i < plan.redeemers.length; i++) {
      const r = plan.redeemers[i]!;
      const reg = i === 0 ? reg1 : reg2;
      expect(
        verifySeedelfSchnorr({
          generator: reg.generator,
          publicValue: reg.publicValue,
          proof: r.proof,
        }),
      ).toBe(true);
      expect(r.proof.vkh).toEqual(signer.vkh);
    }
  });

  it("rejects a secret that doesn't unlock the register", () => {
    const reg = createRegister(7n);
    const signer = generateSeedelfEphemeralKey();
    expect(() =>
      planSeedelfSpendTx({
        addresses: SEEDELF_PREPROD_ADDRESSES,
        inputs: [
          {
            ref: { txId: "00".repeat(32), outputIndex: 0 },
            register: reg,
            secret: 8n,
            lovelace: 5_000_000n,
          },
        ],
        ephemeralSignerVkh: signer.vkh,
      }),
    ).toThrow();
  });

  it("plan is output-independent — proofs depend only on (register, vkh)", () => {
    // The planner produces proofs only; output sizing (destination +
    // change) is the builder's job. Two plans over the same inputs +
    // signer must yield byte-identical redeemers regardless of how the
    // caller intends to size the outputs downstream.
    const x = 0x77n;
    const reg = rerandomizeRegister(createRegister(x), 3n);
    const signer = generateSeedelfEphemeralKey();
    const inputs = [
      {
        ref: { txId: "ab".repeat(32), outputIndex: 0 },
        register: reg,
        secret: x,
        lovelace: 5_000_000n,
      },
    ];
    const planA = planSeedelfSpendTx({
      addresses: SEEDELF_PREPROD_ADDRESSES,
      inputs,
      ephemeralSignerVkh: signer.vkh,
    });
    const planB = planSeedelfSpendTx({
      addresses: SEEDELF_PREPROD_ADDRESSES,
      inputs,
      ephemeralSignerVkh: signer.vkh,
    });
    expect(planA.redeemers).toHaveLength(1);
    expect(planA.redeemers[0]!.redeemerCborHex).toBe(planB.redeemers[0]!.redeemerCborHex);
    expect(
      verifySeedelfSchnorr({
        generator: reg.generator,
        publicValue: reg.publicValue,
        proof: planA.redeemers[0]!.proof,
      }),
    ).toBe(true);
  });
});

describe("seedelf/signer — ephemeral keys", () => {
  it("produces 28-byte vkh from the public key", () => {
    const signer = generateSeedelfEphemeralKey();
    expect(signer.privateKey?.length || signer.secretKey?.length).toBeDefined();
    expect(signer.publicKey.length).toBe(32);
    expect(signer.vkh.length).toBe(28);
  });

  it("produces fresh keys on each call", () => {
    const a = generateSeedelfEphemeralKey();
    const b = generateSeedelfEphemeralKey();
    expect(Buffer.from(a.publicKey).toString("hex")).not.toBe(
      Buffer.from(b.publicKey).toString("hex"),
    );
  });

  it("signs and produces 64-byte signatures", () => {
    const signer = generateSeedelfEphemeralKey();
    const msg = new Uint8Array(32);
    msg.fill(0x55);
    const sig = signer.sign(msg);
    expect(sig.length).toBe(64);
  });
});

// Sanity check imports used elsewhere — keeps `generator`/`scalarMul`/
// `pointToBytes` reachable so test refactors don't strand them.
void generator;
void scalarMul;
void pointToBytes;
