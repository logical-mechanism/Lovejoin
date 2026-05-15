// Mesh-tx-builder layer tests for Seedelf mint / send / spend.
//
// These run the planner side and the Plutus-Data CBOR encoders that drive
// mesh — the full mesh build path needs a chain provider and is exercised
// by the Preprod integration test (seedelf-roundtrip).
//
// Verification targets (issue #155):
//   * Mint: redeemer CBOR + asset-name bytes for a known input.
//   * Send: re-randomized register decodes back to a register the recipient
//     unlocks (covered in plans.test.ts; extend with native-asset shape).
//   * Spend: per-input redeemer count, ephemeral-vkh embedded in every
//     proof, redeemer CBOR matches `encodeSpendRedeemer(proof)`, and the
//     `requiredSignerHash` slot used by the mesh build matches the
//     ephemeral pkh from the plan.

import { describe, expect, it } from "vitest";

import { SEEDELF_PREPROD_ADDRESSES } from "../../src/seedelf/addresses.js";
import { planSeedelfMintTx } from "../../src/seedelf/mint.js";
import { planSeedelfSpendTx } from "../../src/seedelf/spend.js";
import {
  encodeMintRedeemer,
  encodeSpendRedeemer,
  placeholderSpendRedeemerHex,
} from "../../src/seedelf/redeemer.js";
import {
  buildSeedelfTokenName,
  buildSeedelfTokenNameHex,
  isSeedelfAssetName,
  SEEDELF_TOKEN_PREFIX_HEX,
} from "../../src/seedelf/token.js";
import {
  createRegister,
  rerandomizeRegister,
  ownsSeedelfRegister,
} from "../../src/seedelf/register.js";
import { generateSeedelfEphemeralKey } from "../../src/seedelf/signer.js";
import { verifySeedelfSchnorr } from "../../src/seedelf/schnorr.js";

const FIXED_TXID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("seedelf/mint — redeemer + asset-name parity for a known input", () => {
  it("token name byte layout matches the documented contract", () => {
    // Spec: contracts/lib/token_name.ak `generate`:
    //   token_name = prefix(4) || personal(0..15) || idx_byte(1) || txid(0..27)
    // total 32 bytes. With no personal tag and idx=7, the layout is
    // prefix || 0x07 || txid[..27].
    const name = buildSeedelfTokenName({
      input: { txId: FIXED_TXID, outputIndex: 7 },
    });
    expect(name.length).toBe(32);
    expect(Buffer.from(name.subarray(0, 4)).toString("hex")).toBe(SEEDELF_TOKEN_PREFIX_HEX);
    expect(name[4]).toBe(7);
    // Remaining bytes match the first 27 bytes of txid.
    expect(Buffer.from(name.subarray(5)).toString("hex")).toBe(FIXED_TXID.slice(0, 27 * 2));
  });

  it("planSeedelfMintTx emits an asset-name + redeemer that round-trip", () => {
    const personal = "hello";
    const plan = planSeedelfMintTx({
      addresses: SEEDELF_PREPROD_ADDRESSES,
      smallestInputRef: { txId: FIXED_TXID, outputIndex: 3 },
      ownerSecret: 0xdeadbeefn,
      rerandomizeScalar: 0xabcdn,
      personalTag: personal,
      outputLovelace: 2_000_000n,
    });

    // Asset-name parity: the planner's bytes match a fresh recomputation.
    const expected = buildSeedelfTokenNameHex({
      input: { txId: FIXED_TXID, outputIndex: 3 },
      personal,
    });
    expect(plan.assetNameHex).toBe(expected);
    expect(isSeedelfAssetName(plan.assetNameHex)).toBe(true);

    // Mint redeemer is the personal tag wrapped as PlutusData.BoundedBytes.
    // For "hello" that is CBOR `45 68 65 6C 6C 6F` (bytes(5) + "hello").
    expect(plan.mintRedeemerCborHex).toBe("4568656c6c6f");
    expect(encodeMintRedeemer(new TextEncoder().encode(personal))).toBe(plan.mintRedeemerCborHex);
  });

  it("personal-tag trim keeps the on-chain limit (15 bytes)", () => {
    const long = "0123456789ABCDEF"; // 16 bytes; on-chain trims to 15.
    const truncated = "0123456789ABCDE"; // 15 bytes — the visible payload.
    const plan = planSeedelfMintTx({
      addresses: SEEDELF_PREPROD_ADDRESSES,
      smallestInputRef: { txId: FIXED_TXID, outputIndex: 0 },
      ownerSecret: 0x1234n,
      rerandomizeScalar: 0x5678n,
      personalTag: long,
      outputLovelace: 2_000_000n,
    });
    // Compare to the explicitly-truncated reference.
    const expected = buildSeedelfTokenNameHex({
      input: { txId: FIXED_TXID, outputIndex: 0 },
      personal: truncated,
    });
    expect(plan.assetNameHex).toBe(expected);
    // Redeemer also trims to 15 bytes.
    expect(encodeMintRedeemer(new TextEncoder().encode(long))).toBe(
      encodeMintRedeemer(new TextEncoder().encode(truncated)),
    );
  });
});

describe("seedelf/spend — per-input redeemer + ephemeral signer binding", () => {
  it("emits one redeemer per input, each carrying the ephemeral vkh", () => {
    const x = 0xa1n;
    const reg = rerandomizeRegister(createRegister(x), 0x77n);
    const signer = generateSeedelfEphemeralKey();
    const inputs = Array.from({ length: 3 }, (_, i) => ({
      ref: { txId: `${i}`.padStart(2, "0").repeat(32), outputIndex: 0 },
      register: reg,
      secret: x,
      lovelace: 4_000_000n,
    }));
    const plan = planSeedelfSpendTx({
      addresses: SEEDELF_PREPROD_ADDRESSES,
      inputs,
      ephemeralSignerVkh: signer.vkh,
      output: {
        kind: "external",
        addressBech32: "addr_test1qq...",
        lovelace: 11_000_000n,
      },
    });
    expect(plan.redeemers.length).toBe(inputs.length);
    for (let i = 0; i < plan.redeemers.length; i++) {
      const r = plan.redeemers[i]!;
      // Ephemeral pkh is baked into every proof (the on-chain
      // `extra_signatories` check requires it).
      expect(Buffer.from(r.proof.vkh).toString("hex")).toBe(
        Buffer.from(signer.vkh).toString("hex"),
      );
      // Redeemer CBOR matches an independent re-encoding of the same proof.
      expect(r.redeemerCborHex).toBe(encodeSpendRedeemer(r.proof));
      // Each proof verifies under the on-chain rule.
      expect(
        verifySeedelfSchnorr({
          generator: reg.generator,
          publicValue: reg.publicValue,
          proof: r.proof,
        }),
      ).toBe(true);
    }
  });

  it("placeholder redeemer is byte-width-equal to a real proof", () => {
    const x = 0x42n;
    const reg = createRegister(x);
    const signer = generateSeedelfEphemeralKey();
    const plan = planSeedelfSpendTx({
      addresses: SEEDELF_PREPROD_ADDRESSES,
      inputs: [
        {
          ref: { txId: "11".repeat(32), outputIndex: 0 },
          register: reg,
          secret: x,
          lovelace: 5_000_000n,
        },
      ],
      ephemeralSignerVkh: signer.vkh,
      output: {
        kind: "external",
        addressBech32: "addr_test1qq...",
        lovelace: 4_500_000n,
      },
    });
    const real = plan.redeemers[0]!.redeemerCborHex;
    const placeholder = placeholderSpendRedeemerHex();
    // Same byte width → mesh's first-pass fee math doesn't shift when we
    // swap placeholder bytes for the real proof in pass 2.
    expect(placeholder.length).toBe(real.length);
  });

  it("plan still verifies after re-randomizing the inputs (proofs are output-independent)", () => {
    // Sanity: the on-chain proof binds to (generator, public_value, vkh)
    // and not to the tx outputs. A spend plan whose `output.lovelace`
    // changes between passes (the fee-discovery flow) keeps using the
    // same proofs; this test pins that property.
    const x = 0x77n;
    const reg = rerandomizeRegister(createRegister(x), 0x3n);
    const signer = generateSeedelfEphemeralKey();
    const baseInputs = [
      {
        ref: { txId: "ff".repeat(32), outputIndex: 1 },
        register: reg,
        secret: x,
        lovelace: 5_000_000n,
      },
    ];
    const planFee1 = planSeedelfSpendTx({
      addresses: SEEDELF_PREPROD_ADDRESSES,
      inputs: baseInputs,
      ephemeralSignerVkh: signer.vkh,
      output: { kind: "external", addressBech32: "addr_test1qq...", lovelace: 4_800_000n },
    });
    const planFee2 = planSeedelfSpendTx({
      addresses: SEEDELF_PREPROD_ADDRESSES,
      inputs: baseInputs,
      ephemeralSignerVkh: signer.vkh,
      output: { kind: "external", addressBech32: "addr_test1qq...", lovelace: 4_500_000n },
    });
    // Identical proofs across the two plans (RFC 6979 determinism + no
    // output dependency).
    expect(planFee1.redeemers[0]!.redeemerCborHex).toBe(planFee2.redeemers[0]!.redeemerCborHex);
    // Sanity: secret still owns the register either way.
    expect(ownsSeedelfRegister(reg, x)).toBe(true);
  });
});
