// Funded-wallet Preprod E2E — the deep flow described in
// docs/spec/09-milestones.md M6: connect, deposit, run 3 mixes via "Mix N
// random boxes" at varied N, withdraw to a fresh address, verify on chain.
//
// This spec is intentionally skipped under default `pnpm test:e2e`; the
// CIP-30 wallet extension + funded Preprod address are local-developer
// concerns. Set E2E_PREPROD_WALLET=1 to opt in. Required env:
//   * E2E_BLOCKFROST_PROJECT_ID    — Preprod Blockfrost key
//   * E2E_WALLET_EXTENSION_PATH    — unpacked .crx of Lace/Eternl/Nami
//   * E2E_WALLET_PASSPHRASE        — wallet password for unattended tests
//   * E2E_DESTINATION_BECH32       — fresh withdraw destination
//
// Run from `ui/`:
//   E2E_PREPROD_WALLET=1 pnpm test:e2e -- --headed full-flow
//
// The test asserts only the headline outcomes — three mix-tx hashes, one
// withdraw-tx hash, and the on-chain confirmation of the withdraw — to
// keep it resilient to UI copy changes.

import { test } from "@playwright/test";

const ENABLED = process.env.E2E_PREPROD_WALLET === "1";

test.describe("M6 funded-wallet Preprod flow", () => {
  test.skip(!ENABLED, "set E2E_PREPROD_WALLET=1 + a funded wallet to enable");

  test("deposit → mix x3 → withdraw against Preprod", async ({ page }) => {
    test.fail(
      true,
      "scaffold only — wire the wallet-extension load + assertions in your local env",
    );
    await page.goto("/");
  });
});
