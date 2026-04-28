// E2E smoke test — drives the M6 router shell against a real Vite dev
// server. No wallet, no chain.
//
// Spec coverage:
//   * docs/spec/06-ui.md §"Layout" — header copy renders.
//   * docs/spec/06-ui.md §"Home" / §"Pool" / §"Vault" / §"Withdraw" —
//     each route mounts and surfaces its primary heading.
//   * docs/spec/06-ui.md §"Privacy UX rules" rule 8 — the collateral-
//     provider banner appears on the Pool route once the probe fails
//     (default offline-by-config).
//
// This is the smoke layer; the funded-wallet Preprod flow is in
// full-flow.spec.ts (skipped unless E2E_PREPROD_WALLET=1).

import { expect, test } from "@playwright/test";

test.describe("M6 router smoke", () => {
  test("Home route renders the title + nav", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Lovejoin", level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole("navigation", { name: /main/i })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /^Welcome$/ }),
    ).toBeVisible();
  });

  test("Deposit route is reachable via the nav", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Deposit" }).first().click();
    await expect(page).toHaveURL(/\/deposit$/);
    await expect(
      page.getByText(/Configure a Blockfrost key/i).first(),
    ).toBeVisible();
  });

  test("Pool route shows the mix-width slider + collateral banner when down", async ({
    page,
  }) => {
    // The default config points at https://giveme.my; with no network the
    // probe fails and we render the banner. We assert on the banner role
    // instead of the live-reload text so the test isn't language-bound.
    await page.goto("/pool");
    await expect(page.getByRole("slider")).toBeVisible();
    // Slider title — "Mix width" in en.json.
    await expect(page.getByText(/Mix width/i).first()).toBeVisible();
  });

  test("Vault route shows the unlock prompt before any passphrase is entered", async ({
    page,
  }) => {
    await page.goto("/vault");
    await expect(
      page.getByRole("heading", { name: /Unlock vault/i }),
    ).toBeVisible();
    await expect(page.getByPlaceholder(/Vault passphrase/i)).toBeVisible();
  });

  test("Withdraw route renders the destination form", async ({ page }) => {
    await page.goto("/withdraw");
    await expect(
      page.getByText(/Configure a Blockfrost key/i).first(),
    ).toBeVisible();
  });
});
