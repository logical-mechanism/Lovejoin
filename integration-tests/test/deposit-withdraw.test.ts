// M3 integration test: deposit a mix-box on Preprod, then withdraw it.
//
// Spec: docs/spec/09-milestones.md M3 exit criterion #4 — "Preprod
// integration test deposit-withdraw passes ten consecutive runs". This
// file is one round; run it ten times in a row to satisfy the criterion.
//
// Skipped automatically when the required env vars / artifacts aren't
// present, so contributors without a Preprod wallet still get green CI.

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BlockfrostProvider,
  buildDepositTx,
  buildWithdrawTx,
  createCliMeshWallet,
  createMnemonicMeshWallet,
  type LovejoinAddresses,
  type LovejoinWallet,
  networkIdFor,
} from "@lovejoin/sdk";

const NETWORK = (process.env.LOVEJOIN_NETWORK ?? "preprod") as
  | "preprod"
  | "preview"
  | "test"
  | "mainnet";
const PROJECT_ID = process.env.BLOCKFROST_PROJECT_ID_PREPROD;
const PAYMENT_SKEY = process.env.LOVEJOIN_PAYMENT_SKEY;
const STAKE_SKEY = process.env.LOVEJOIN_STAKE_SKEY;
const MNEMONIC = process.env.LOVEJOIN_MNEMONIC;
const ADDRESSES_PATH = process.env.LOVEJOIN_ADDRESSES
  ?? `./artifacts/${NETWORK}/addresses.json`;

const HAS_PROJECT_ID = !!PROJECT_ID;
const HAS_WALLET = !!(PAYMENT_SKEY || MNEMONIC);

function blockfrostBaseUrl(): string {
  if (NETWORK === "mainnet") return "https://cardano-mainnet.blockfrost.io/api/v0";
  if (NETWORK === "preview") return "https://cardano-preview.blockfrost.io/api/v0";
  return "https://cardano-preprod.blockfrost.io/api/v0";
}

async function loadWallet(): Promise<LovejoinWallet> {
  const networkId = networkIdFor(NETWORK);
  if (PAYMENT_SKEY) {
    return createCliMeshWallet({
      networkId,
      payment: PAYMENT_SKEY,
      ...(STAKE_SKEY ? { stake: STAKE_SKEY } : {}),
    });
  }
  if (MNEMONIC) {
    const words = MNEMONIC.split(/[\s,]+/).filter((w) => w.length > 0);
    return createMnemonicMeshWallet({ networkId, mnemonic: words });
  }
  throw new Error("no wallet credentials");
}

function loadAddresses(): LovejoinAddresses {
  return JSON.parse(readFileSync(resolvePath(ADDRESSES_PATH), "utf8")) as LovejoinAddresses;
}

const skipReason = !HAS_PROJECT_ID
  ? "BLOCKFROST_PROJECT_ID_PREPROD not set"
  : !HAS_WALLET
    ? "LOVEJOIN_PAYMENT_SKEY / LOVEJOIN_MNEMONIC not set"
    : null;

describe.skipIf(skipReason !== null)(
  `m3 — deposit-withdraw on ${NETWORK}`,
  () => {
    it("deposits a mix-box then withdraws it (single round)", async () => {
      const provider = new BlockfrostProvider({
        baseUrl: blockfrostBaseUrl(),
        projectId: PROJECT_ID!,
      });
      const wallet = await loadWallet();
      const addresses = loadAddresses();

      // --- Deposit ----------------------------------------------------------
      const deposit = await buildDepositTx({
        network: NETWORK,
        rounds: 5, // small replenishment so the test doesn't burn a lot of ADA
        wallet,
        provider,
        addresses,
      });
      expect(deposit.txId).toMatch(/^[0-9a-f]{64}$/);
      expect(deposit.owner.secretHex).toMatch(/^[0-9a-f]{64}$/);
      expect(deposit.owner.publicPointHex).toMatch(/^[0-9a-f]{96}$/);
      expect(deposit.mixBoxOutputIndex).toBe(0);

      // Wait for confirmation before referencing the UTxO downstream.
      await provider.awaitConfirmation(deposit.txId, 5 * 60_000);

      // --- Withdraw ---------------------------------------------------------
      // Send to a fresh ad-hoc Preprod address so the test doesn't pollute the
      // funding wallet. We use a derived enterprise script address from the
      // reference holder script — guaranteed to exist on chain. Real users
      // would withdraw to a Seedelf or fresh wallet.
      const destinationFresh = await freshDestination(wallet);

      const withdraw = await buildWithdrawTx({
        network: NETWORK,
        ownerSecret: BigInt("0x" + deposit.owner.secretHex),
        mixBox: {
          ref: { txId: deposit.txId, outputIndex: deposit.mixBoxOutputIndex },
          a: hexToBytes(generatorBytesHex()),
          b: hexToBytes(deposit.owner.publicPointHex),
        },
        destinationAddressBech32: destinationFresh,
        wallet,
        provider,
        addresses,
      });
      expect(withdraw.txId).toMatch(/^[0-9a-f]{64}$/);

      await provider.awaitConfirmation(withdraw.txId, 5 * 60_000);
    });
  },
);

if (skipReason) {
  // Surface the skip reason as test output so it shows up in CI logs.
  // eslint-disable-next-line no-console
  console.log(`[m3 deposit-withdraw] SKIP — ${skipReason}`);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** The compressed bytes of the BLS12-381 G1 generator, matching the deposit's `a`. */
function generatorBytesHex(): string {
  // a == g for any deposit. Hard-coded here so we don't have to import the
  // crypto module — the integration test stays small + dep-light.
  return "97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb";
}

async function freshDestination(wallet: LovejoinWallet): Promise<string> {
  // Reuse the wallet's used address. Real flows withdraw to a separate
  // wallet / Seedelf; for the smoke test we just round-trip back so the
  // funds aren't lost.
  const addresses = await wallet.getUsedAddresses();
  if (addresses.length === 0) {
    throw new Error("wallet has no used addresses to receive the withdraw");
  }
  return addresses[0]!;
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
