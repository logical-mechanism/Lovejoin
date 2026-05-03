// Playwright configuration for the M6 E2E suite.
//
// Spec: docs/spec/09-milestones.md M6 — "E2E Playwright test on Preprod:
// connect wallet, deposit, run 3 mixes via 'Mix N random boxes' at varied
// N, withdraw to fresh address, verify on chain."
//
// Two run modes:
//
//   1. Local dev (default): smoke spec against an auto-spawned Vite dev
//      server on http://localhost:${E2E_PORT}. The funded-wallet
//      full-flow spec self-skips unless E2E_PREPROD_WALLET=1 is set.
//
//   2. Staging dispatch: E2E_BASE_URL=https://preprod.lovejo.in plus
//      E2E_PREPROD_WALLET=1 runs full-flow against the deployed staging
//      site (workflow_dispatch). No webServer is started.
//
// The deep wallet-driven flow needs a real CIP-30 browser-extension
// wallet + a funded Preprod address, so it stays gated behind explicit
// env vars rather than running on every PR. See ui/e2e/README.md.

import { defineConfig } from "@playwright/test";

const PORT = process.env.E2E_PORT ?? "5179";
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const USE_LOCAL_DEV_SERVER = !process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // share one dev-server / staging origin across specs
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    // Capture video for the funded-wallet flow so workflow_dispatch
    // runs leave an artefact a maintainer can replay; smoke runs are
    // fast enough that the trace alone is fine.
    video: process.env.E2E_PREPROD_WALLET === "1" ? "retain-on-failure" : "off",
  },
  // Only spawn the local Vite dev server when no remote E2E_BASE_URL was
  // supplied. Returning `undefined` (vs an empty array) keeps Playwright
  // from doing health-check polling against a port nobody is listening on.
  webServer: USE_LOCAL_DEV_SERVER
    ? {
        command: `pnpm dev --port ${PORT} --strictPort`,
        port: Number(PORT),
        reuseExistingServer: !process.env.CI,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 120_000,
      }
    : undefined,
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
