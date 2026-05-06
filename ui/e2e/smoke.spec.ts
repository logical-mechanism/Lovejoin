// E2E smoke test — drives the M6.5 router shell against a real Vite dev
// server. No wallet, no chain.
//
// Spec coverage:
//   *  §"Layout" — brand mark + nav + footer.
//   *  §"Home" — splash hero + the three I/II/III pillars.
//   *  §"Pool" — Pool section title, fee-payer toggle,
//     review block.
//   *  §"Vault" — locked-state copy + the
//     wallet-derived unlock CTA.
//   *  §"Withdraw" — preconditions copy when no wallet
//     is connected.
//
// Plus an automated WCAG 2.1 A/AA scan via @axe-core/playwright on every
// route in this spec. The UI already has good a11y bones (skip link,
// sr-only h1 per route, ARIA labels on nav, RTL via the locale registry);
// the axe scan is the regression net for the next change that would
// otherwise ship a missing label, a colour-contrast slip, or a broken
// landmark structure.
//
// The funded-wallet Preprod flow lives in full-flow.spec.ts (skipped
// unless E2E_PREPROD_WALLET=1).

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function expectNoA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations).toEqual([]);
}

test.describe("M6.5 router smoke", () => {
  test("Home route renders hero + three pillars", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: /Lovejoin/i }).first()).toBeVisible();
    // Layout owns the route-derived <h1> (sr-only); the visible hero line
    // is an h2. Pillars are h3 — match those specifically so the hero's
    // "Deposit in public…" h2 doesn't collide with the pillar h3 "Deposit".
    await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Deposit" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Mix" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Withdraw" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: /main/i })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test("Pool route shows the fee-payer toggle + review block", async ({ page }) => {
    await page.goto("/pool");
    // Section heading (en.json pool.section_title = "Mix").
    await expect(page.getByRole("heading", { level: 2, name: "Mix" })).toBeVisible();
    // Fee-payer toggle. Both buttons are always present; the active one
    // flips via aria-pressed.
    await expect(page.getByRole("button", { name: /Fee shard/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Wallet$/i })).toBeVisible();
    // Review block — surfaces the chosen Mix width even before any
    // pool / addresses load (defaults to 2).
    await expect(page.getByText(/Mix width/i).first()).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test("Vault route shows the wallet-derived unlock CTA when locked", async ({ page }) => {
    await page.goto("/vault");
    await expect(page.getByRole("heading", { name: /Vault locked/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Unlock with wallet/i })).toBeVisible();
    // Tier-2 fallback link is present but de-emphasised. en.json
    // vault.recover_link = "Use a recovery password instead".
    await expect(page.getByRole("button", { name: /recovery password/i })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test("Deposit route shows preconditions copy when no wallet is connected", async ({ page }) => {
    await page.goto("/deposit");
    await expect(page.getByText(/Connect a wallet/i).first()).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test("/withdraw redirects to /vault (the merged owned-boxes view)", async ({ page }) => {
    // The standalone /withdraw route was folded into Vault during M6.5+;
    // the redirect is wired in App.tsx so old bookmarks still land. Land
    // on /withdraw and assert we end up on the Vault locked-state.
    await page.goto("/withdraw");
    await expect(page).toHaveURL(/\/vault$/);
    await expect(page.getByRole("heading", { name: /Vault locked/i })).toBeVisible();
    await expectNoA11yViolations(page);
  });
});
