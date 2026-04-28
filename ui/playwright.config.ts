// Playwright configuration for the M6 E2E suite.
//
// Spec: docs/spec/09-milestones.md M6 — "E2E Playwright test on Preprod:
// connect wallet, deposit, run 3 mixes via 'Mix N random boxes' at varied
// N, withdraw to fresh address, verify on chain."
//
// The deep wallet-driven flow needs a real CIP-30 browser-extension wallet
// + a funded Preprod address — only practical to run in a developer's
// local environment, not in default CI. The smoke suite (e2e/smoke.spec.ts)
// covers the route shell + the URL-driven navigation that doesn't depend
// on a wallet, so CI gets the regression coverage without the funded-key
// requirement. The funded-wallet flow lives in `e2e/full-flow.spec.ts`
// (skipped unless E2E_PREPROD_WALLET=1 is set).

import { defineConfig } from "@playwright/test";

const PORT = process.env.E2E_PORT ?? "5179";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // we share one dev-server instance across specs
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm dev --port ${PORT} --strictPort`,
    port: Number(PORT),
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
