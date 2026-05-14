// Issue #155 integration test: mint a Seedelf register, send ADA into
// it, then spend it back out to the same wallet. Exercises the full
// mesh wiring (wallet-paid mint + send, external-collateral spend with
// ephemeral signer) end-to-end against the live Seedelf-Wallet deployment
// on Preprod.
//
// Skipped automatically when the required env vars / artifacts aren't
// present so contributors without a Preprod wallet still get green CI.
// The wallet pays for: mint output min-UTxO + mint tx fee, send-to-self
// payment, and the collateral host call's own min-UTxO is irrelevant
// (host pre-funds its own collateral).

import { describe, expect, it } from "vitest";

import {
  defaultSeedelfAddresses,
  deriveSeedelfSecret,
  mintSeedelfTx,
  resolveRecipientRegister,
  sendToSeedelfTx,
  spendFromSeedelfTx,
  classifySeedelfUtxos,
  type OwnedSeedelfUtxo,
} from "@lovejoin/sdk";

import { loadWallet, makeProvider, NETWORK, skipReason } from "./_lib.js";

const reason = (() => {
  const baseReason = skipReason();
  if (baseReason) return baseReason;
  if (!defaultSeedelfAddresses(NETWORK as "preprod" | "preview" | "test" | "mainnet")) {
    return `no canonical Seedelf deployment for network "${NETWORK}"`;
  }
  return null;
})();

describe.skipIf(reason !== null)(`seedelf roundtrip on ${NETWORK}`, () => {
  it(
    "mints → sends into → spends out of a fresh stealth register",
    async () => {
      const provider = makeProvider();
      const wallet = await loadWallet();
      const addresses = defaultSeedelfAddresses(
        NETWORK as "preprod" | "preview" | "test" | "mainnet",
      )!;

      // Derive a fresh seed for the test run. We can't easily call the
      // wallet's signData flow from a server-side CIP-30 wallet, so we
      // synthesize a stable seed from the env-supplied skey/mnemonic via
      // a SHA-256 of the wallet's first used address. That keeps the
      // test deterministic per wallet but distinct across wallets.
      const addrSeedSource = await wallet.getUsedAddresses();
      if (addrSeedSource.length === 0) {
        throw new Error("test wallet has no used addresses; fund it on Preprod first");
      }
      const seed = await deriveTestSeed(addrSeedSource[0]!);
      const x0 = deriveSeedelfSecret(seed, 0);

      // --- 1. MINT ---------------------------------------------------------
      const mintResult = await mintSeedelfTx({
        network: NETWORK as "preprod" | "preview" | "test" | "mainnet",
        addresses,
        provider,
        wallet,
        ownerSecret: x0,
        personalTag: "lj-it",
      });
      expect(mintResult.txId).toMatch(/^[0-9a-f]{64}$/);
      console.log(`[seedelf-it] minted register tx=${mintResult.txId}`);
      await provider.awaitConfirmation(mintResult.txId, 5 * 60_000);

      // --- 2. SEND ---------------------------------------------------------
      const seedelfIdHex = mintResult.plan.assetNameHex;
      const resolved = await resolveRecipientRegister({
        provider,
        addresses,
        seedelfIdHex,
      });
      if (!resolved) {
        throw new Error(`failed to find register UTxO for minted id ${seedelfIdHex}`);
      }
      const SEND_LOVELACE = 6_000_000n;
      const sendResult = await sendToSeedelfTx({
        network: NETWORK as "preprod" | "preview" | "test" | "mainnet",
        addresses,
        provider,
        wallet,
        recipientRegister: resolved.register,
        lovelace: SEND_LOVELACE,
      });
      expect(sendResult.txId).toMatch(/^[0-9a-f]{64}$/);
      console.log(`[seedelf-it] sent ${SEND_LOVELACE} lovelace tx=${sendResult.txId}`);
      await provider.awaitConfirmation(sendResult.txId, 5 * 60_000);

      // --- 3. CLASSIFY -----------------------------------------------------
      // The scanner should surface one fund UTxO holding our send.
      const { seedelfWalletAddressBech32 } = await import("@lovejoin/sdk");
      const wcAddress = seedelfWalletAddressBech32(addresses);
      const utxos = await provider.getUtxos(wcAddress);
      const classified = classifySeedelfUtxos({
        utxos,
        secrets: [{ index: 0, secret: x0 }],
      });
      const ownedFund = classified.funds.find(
        (f: OwnedSeedelfUtxo) => f.utxo.lovelace === SEND_LOVELACE,
      );
      if (!ownedFund) {
        throw new Error(
          `expected a fund UTxO holding ${SEND_LOVELACE} lovelace; scanner saw ${classified.funds.length}`,
        );
      }

      // --- 4. SPEND --------------------------------------------------------
      const destination = (await wallet.getUsedAddresses())[0]!;
      const spendResult = await spendFromSeedelfTx({
        network: NETWORK as "preprod" | "preview" | "test" | "mainnet",
        addresses,
        provider,
        wallet, // for collateral fallback when no pinned host on this network
        inputs: [
          {
            ref: ownedFund.utxo.ref,
            register: ownedFund.register,
            secret: x0,
            lovelace: ownedFund.utxo.lovelace,
          },
        ],
        destination: { kind: "external", addressBech32: destination },
      });
      expect(spendResult.txId).toMatch(/^[0-9a-f]{64}$/);
      console.log(`[seedelf-it] spent fund tx=${spendResult.txId} fee=${spendResult.feeLovelace}`);
      await provider.awaitConfirmation(spendResult.txId, 5 * 60_000);

      // The send'd UTxO should no longer be in the user's owned fund set.
      const afterUtxos = await provider.getUtxos(wcAddress);
      const afterClassified = classifySeedelfUtxos({
        utxos: afterUtxos,
        secrets: [{ index: 0, secret: x0 }],
      });
      expect(
        afterClassified.funds.find(
          (f: OwnedSeedelfUtxo) =>
            f.utxo.ref.txId === ownedFund.utxo.ref.txId &&
            f.utxo.ref.outputIndex === ownedFund.utxo.ref.outputIndex,
        ),
      ).toBeUndefined();
    },
    30 * 60_000,
  );
});

async function deriveTestSeed(uniquePerWallet: string): Promise<Uint8Array> {
  const { createHash } = await import("node:crypto");
  return new Uint8Array(createHash("sha256").update(uniquePerWallet).digest());
}
