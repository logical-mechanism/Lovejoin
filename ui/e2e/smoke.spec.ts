// E2E smoke test — drives the M6.5 router shell against a real Vite dev
// server. No wallet, no chain.
//
// Spec coverage:
//   * docs/spec/06-ui.md §"Layout" — brand mark + nav + footer.
//   * docs/spec/06-ui.md §"Home" — splash hero + the three I/II/III pillars.
//   * docs/spec/06-ui.md §"Pool" — mix-width slider, fee-payer toggle,
//     collateral banner when the probe fails.
//   * docs/spec/06-ui.md §"Vault" — locked-state copy + the
//     wallet-derived unlock CTA.
//   * docs/spec/06-ui.md §"Withdraw" — preconditions copy when no wallet
//     is connected.
//
// The funded-wallet Preprod flow lives in full-flow.spec.ts (skipped
// unless E2E_PREPROD_WALLET=1).

import { expect, test } from "@playwright/test";

test.describe("M6.5 router smoke", () => {
  test("Home route renders hero + three pillars", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: /Lovejoin/i }).first()).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Three I/II/III pillar headings.
    await expect(page.getByRole("heading", { name: "Deposit" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Mix" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Withdraw" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: /main/i })).toBeVisible();
  });

  test("Pool route shows the mix-width slider + fee-payer toggle", async ({
    page,
  }) => {
    await page.goto("/pool");
    await expect(page.getByRole("slider")).toBeVisible();
    await expect(page.getByText(/Mix width/i).first()).toBeVisible();
    await expect(page.getByText(/Fee payer/i).first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Fee shard/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Wallet$/i }),
    ).toBeVisible();
  });

  test("Vault route shows the wallet-derived unlock CTA when locked", async ({
    page,
  }) => {
    await page.goto("/vault");
    await expect(
      page.getByRole("heading", { name: /Vault locked/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Unlock with wallet/i }),
    ).toBeVisible();
    // The tier-2 fallback link is present but de-emphasised.
    await expect(
      page.getByRole("button", { name: /recovery phrase/i }),
    ).toBeVisible();
  });

  test("Deposit route shows preconditions copy when no wallet is connected", async ({
    page,
  }) => {
    await page.goto("/deposit");
    await expect(page.getByText(/Connect a wallet/i).first()).toBeVisible();
  });

  test("Withdraw route shows preconditions copy when no wallet is connected", async ({
    page,
  }) => {
    await page.goto("/withdraw");
    await expect(page.getByText(/Connect a wallet/i).first()).toBeVisible();
  });
});
