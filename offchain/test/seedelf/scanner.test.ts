import { describe, expect, it } from "vitest";
import type { Utxo } from "../../src/chain/provider.js";
import {
  createRegister,
  encodeRegisterDatum,
  rerandomizeRegister,
} from "../../src/seedelf/register.js";
import { SEEDELF_PREPROD_ADDRESSES } from "../../src/seedelf/addresses.js";
import { classifySeedelfUtxos } from "../../src/seedelf/scanner.js";
import { buildSeedelfTokenNameHex } from "../../src/seedelf/token.js";

function fakeUtxo(args: {
  txId: string;
  outputIndex?: number;
  address?: string;
  lovelace?: bigint;
  inlineDatum: string;
  seedelfTokenHex?: string;
}): Utxo {
  const policy = SEEDELF_PREPROD_ADDRESSES.seedelfPolicyId;
  const assets: Record<string, bigint> = {};
  if (args.seedelfTokenHex) {
    assets[policy + args.seedelfTokenHex] = 1n;
  }
  return {
    ref: { txId: args.txId, outputIndex: args.outputIndex ?? 0 },
    address: args.address ?? "addr_test1...",
    lovelace: args.lovelace ?? 5_000_000n,
    assets,
    inlineDatum: args.inlineDatum,
    referenceScript: null,
  };
}

describe("seedelf/scanner — classify owned UTxOs", () => {
  it("partitions registers (with NFT) from funds (no NFT)", () => {
    const owner1 = 0x11n;
    const owner2 = 0x22n;
    const stranger = 0x99n;

    // Two registers (with NFTs) for owner1, both unique re-rands.
    const reg1a = rerandomizeRegister(createRegister(owner1), 7n);
    const reg1b = rerandomizeRegister(createRegister(owner1), 13n);
    // One funded UTxO for owner1 (re-rand of one of their existing
    // registers, no new NFT).
    const reg1c = rerandomizeRegister(reg1a, 99n);
    // One UTxO that's a register for owner2.
    const reg2 = rerandomizeRegister(createRegister(owner2), 5n);
    // One UTxO at the same address but not owned by anyone in our seed.
    const regStranger = rerandomizeRegister(createRegister(stranger), 3n);

    const dummyTokenHex = buildSeedelfTokenNameHex({
      input: { txId: "ab".repeat(32), outputIndex: 0 },
      personal: "test",
    });

    const utxos: Utxo[] = [
      fakeUtxo({
        txId: "00".repeat(32),
        outputIndex: 0,
        inlineDatum: encodeRegisterDatum(reg1a),
        seedelfTokenHex: dummyTokenHex,
      }),
      fakeUtxo({
        txId: "11".repeat(32),
        outputIndex: 0,
        inlineDatum: encodeRegisterDatum(reg1b),
        seedelfTokenHex: dummyTokenHex,
      }),
      fakeUtxo({
        txId: "22".repeat(32),
        outputIndex: 0,
        inlineDatum: encodeRegisterDatum(reg1c),
      }),
      fakeUtxo({
        txId: "33".repeat(32),
        outputIndex: 0,
        inlineDatum: encodeRegisterDatum(reg2),
        seedelfTokenHex: dummyTokenHex,
      }),
      fakeUtxo({
        txId: "44".repeat(32),
        outputIndex: 0,
        inlineDatum: encodeRegisterDatum(regStranger),
        seedelfTokenHex: dummyTokenHex,
      }),
    ];

    const result = classifySeedelfUtxos({
      utxos,
      secrets: [
        { index: 0, secret: owner1 },
        { index: 1, secret: owner2 },
      ],
    });
    expect(result.scannedCount).toBe(5);
    expect(result.registers.length).toBe(3);
    expect(result.funds.length).toBe(1);
    expect(result.funds[0]!.utxo.ref.txId).toBe("22".repeat(32));
    // The stranger's UTxO is excluded.
    for (const r of result.registers) {
      expect([owner1, owner2]).toContain(r.secret);
    }
  });

  it("skips UTxOs without an inline datum", () => {
    const reg = createRegister(1n);
    const utxos: Utxo[] = [
      {
        ref: { txId: "00".repeat(32), outputIndex: 0 },
        address: "addr_test1...",
        lovelace: 5_000_000n,
        assets: {},
        inlineDatum: null,
        referenceScript: null,
      },
      fakeUtxo({
        txId: "11".repeat(32),
        inlineDatum: encodeRegisterDatum(reg),
      }),
    ];
    const result = classifySeedelfUtxos({
      utxos,
      secrets: [{ index: 0, secret: 1n }],
    });
    expect(result.funds.length).toBe(1);
    expect(result.registers.length).toBe(0);
  });

  it("skips UTxOs with garbage datums", () => {
    const utxos: Utxo[] = [fakeUtxo({ txId: "00".repeat(32), inlineDatum: "d87980" })];
    const result = classifySeedelfUtxos({
      utxos,
      secrets: [{ index: 0, secret: 1n }],
    });
    expect(result.registers.length).toBe(0);
    expect(result.funds.length).toBe(0);
  });
});
