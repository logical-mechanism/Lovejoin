// resolveRecipientRegister: looks up a recipient register by their
// seedelf id (5eed0e1f… locator NFT) at the wallet contract address.

import { describe, expect, it } from "vitest";

import type {
  ChainProvider,
  Hex28,
  Hex32,
  NetworkProtocolParameters,
  Utxo,
  UtxoRef,
} from "../../src/chain/provider.js";
import {
  createRegister,
  encodeRegisterDatum,
  rerandomizeRegister,
} from "../../src/seedelf/register.js";
import { SEEDELF_PREPROD_ADDRESSES } from "../../src/seedelf/addresses.js";
import { buildSeedelfTokenNameHex } from "../../src/seedelf/token.js";
import { resolveRecipientRegister } from "../../src/seedelf/send.js";

function mockProvider(utxos: Utxo[]): ChainProvider {
  return {
    submitTx: async (): Promise<Hex32> => {
      throw new Error("not used");
    },
    getUtxos: async () => utxos,
    getUtxoByRef: async (_: UtxoRef) => null,
    awaitConfirmation: async () => undefined,
    getReferenceUtxo: async (_p: Hex28, _n: string) => {
      throw new Error("not used");
    },
    getProtocolParameters: async (): Promise<NetworkProtocolParameters> => {
      throw new Error("not used");
    },
  };
}

function fakeUtxoWithLocator(args: {
  txId: string;
  policyId: string;
  assetNameHex: string;
  inlineDatum: string;
}): Utxo {
  return {
    ref: { txId: args.txId, outputIndex: 0 },
    address: "addr_test1qq...",
    lovelace: 5_000_000n,
    assets: { [`${args.policyId}${args.assetNameHex}`]: 1n },
    inlineDatum: args.inlineDatum,
    referenceScript: null,
  };
}

describe("seedelf/send — resolveRecipientRegister", () => {
  it("returns the register + utxo for a matching seedelf id", async () => {
    const recipientSecret = 0x42n;
    const recipientRegister = rerandomizeRegister(createRegister(recipientSecret), 17n);
    const seedelfIdHex = buildSeedelfTokenNameHex({
      input: { txId: "aa".repeat(32), outputIndex: 0 },
      personal: "carol",
    });
    const provider = mockProvider([
      fakeUtxoWithLocator({
        txId: "bb".repeat(32),
        policyId: SEEDELF_PREPROD_ADDRESSES.seedelfPolicyId,
        assetNameHex: seedelfIdHex,
        inlineDatum: encodeRegisterDatum(recipientRegister),
      }),
    ]);

    const resolved = await resolveRecipientRegister({
      provider,
      addresses: SEEDELF_PREPROD_ADDRESSES,
      seedelfIdHex,
    });
    expect(resolved).not.toBeNull();
    expect(Buffer.from(resolved!.register.generator).toString("hex")).toBe(
      Buffer.from(recipientRegister.generator).toString("hex"),
    );
  });

  it("returns null when no UTxO carries the locator", async () => {
    const seedelfIdHex = buildSeedelfTokenNameHex({
      input: { txId: "aa".repeat(32), outputIndex: 0 },
    });
    const provider = mockProvider([]);
    const resolved = await resolveRecipientRegister({
      provider,
      addresses: SEEDELF_PREPROD_ADDRESSES,
      seedelfIdHex,
    });
    expect(resolved).toBeNull();
  });

  it("rejects malformed seedelf ids", async () => {
    const provider = mockProvider([]);
    await expect(
      resolveRecipientRegister({
        provider,
        addresses: SEEDELF_PREPROD_ADDRESSES,
        seedelfIdHex: "deadbeef", // wrong prefix + length
      }),
    ).rejects.toThrow(/5eed0e1f/);
  });
});
