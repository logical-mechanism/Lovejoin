// Funded-wallet Preprod E2E — the deep flow described in
// docs/spec/09-milestones.md M6: connect, deposit, run mixes via "Mix N
// random boxes" at varied N, withdraw to a fresh address, verify on chain.
//
// This spec is intentionally skipped under default `pnpm test:e2e`; the
// CIP-30 wallet extension + funded Preprod address are local-developer
// concerns. Set E2E_PREPROD_WALLET=1 to opt in. Required env:
//   * E2E_BLOCKFROST_PROJECT_ID    — Preprod Blockfrost key
//   * E2E_WALLET_EXTENSION_PATH    — unpacked .crx of Lace/Eternl/Nami
//   * E2E_WALLET_PASSPHRASE        — wallet password for unattended tests
//   * E2E_DESTINATION_BECH32       — fresh withdraw destination
// Optional:
//   * E2E_WALLET_KIND              — "lace" | "eternl" | "nami" | "auto" (default: auto)
//   * E2E_WALLET_NAME_REGEX        — JS regex matched against installed-
//                                    wallet entries in the Lovejoin modal
//                                    (default: /lace|eternl|nami/i)
//   * E2E_BASE_URL                 — staging origin (e.g.
//                                    https://preprod.lovejo.in); when
//                                    set, the Vite dev server is not
//                                    spawned. See playwright.config.ts.
//
// Run from `ui/` against a local Vite dev server:
//   E2E_PREPROD_WALLET=1 \
//   E2E_WALLET_EXTENSION_PATH=/path/to/unpacked-extension \
//   E2E_WALLET_PASSPHRASE=… E2E_BLOCKFROST_PROJECT_ID=preprod… \
//   E2E_DESTINATION_BECH32=addr_test1… \
//     pnpm test:e2e --headed full-flow
//
// The test asserts only the headline outcomes — three mix-tx hashes, one
// withdraw-tx hash, and the on-chain confirmation of the withdraw — to
// keep it resilient to UI copy changes.

import { test as base, chromium, expect, type BrowserContext } from "@playwright/test";
import { connectWallet, drivePopup, type WalletKind } from "./wallet-driver";

const ENABLED = process.env.E2E_PREPROD_WALLET === "1";

interface Env {
  blockfrostProjectId: string;
  extensionPath: string;
  passphrase: string;
  destination: string;
  walletKind: WalletKind;
  walletNameRegex: RegExp;
}

function readEnv(): Env {
  const required = {
    E2E_BLOCKFROST_PROJECT_ID: process.env.E2E_BLOCKFROST_PROJECT_ID,
    E2E_WALLET_EXTENSION_PATH: process.env.E2E_WALLET_EXTENSION_PATH,
    E2E_WALLET_PASSPHRASE: process.env.E2E_WALLET_PASSPHRASE,
    E2E_DESTINATION_BECH32: process.env.E2E_DESTINATION_BECH32,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `full-flow.spec.ts: missing required env: ${missing.join(", ")} ` +
        `(E2E_PREPROD_WALLET=1 was set, so these are mandatory)`,
    );
  }
  const kind = (process.env.E2E_WALLET_KIND ?? "auto") as WalletKind;
  const walletNameRegex = process.env.E2E_WALLET_NAME_REGEX
    ? new RegExp(process.env.E2E_WALLET_NAME_REGEX, "i")
    : /lace|eternl|nami/i;
  return {
    blockfrostProjectId: required.E2E_BLOCKFROST_PROJECT_ID!,
    extensionPath: required.E2E_WALLET_EXTENSION_PATH!,
    passphrase: required.E2E_WALLET_PASSPHRASE!,
    destination: required.E2E_DESTINATION_BECH32!,
    walletKind: kind,
    walletNameRegex,
  };
}

// Override the default {context, page} fixtures with a persistent context
// that has the wallet extension loaded. CIP-30 wallets only inject
// `window.cardano.*` when the extension's service-worker is alive, which
// requires `launchPersistentContext` (not a regular incognito context).
//
// Headless Chromium does not load extensions, so this flow forces
// headed mode. CI runners need an Xvfb wrapper.
//
// Fixtures are lazy in Playwright — when test.skip() short-circuits the
// describe block, this body never runs, so we don't bother with a no-op
// fallback for the skip path.
const test = base.extend<{ context: BrowserContext }>({
  context: async ({}, use) => {
    const env = readEnv();
    const ctx = await chromium.launchPersistentContext("", {
      headless: false,
      args: [
        `--disable-extensions-except=${env.extensionPath}`,
        `--load-extension=${env.extensionPath}`,
        // Prevent the first-run "What's new" tab from racing with our
        // own page navigation.
        "--no-first-run",
        "--no-default-browser-check",
      ],
      // Wallet extensions read locale; pin to en-US so popup-button text
      // matches our `/^confirm$/i` etc. selectors regardless of host OS.
      locale: "en-US",
    });
    await use(ctx);
    await ctx.close();
  },
});

test.describe("M6 funded-wallet Preprod flow", () => {
  test.skip(!ENABLED, "set E2E_PREPROD_WALLET=1 + a funded wallet to enable");
  // Real chain interaction: connect (≈30s) + deposit (≈30s wait + ≈90s
  // confirmation) + 3 mixes (≈90s each) + withdraw (≈90s confirmation).
  // Generous overall ceiling rather than tight-per-step deadlines.
  test.setTimeout(15 * 60_000);

  test("deposit → mix x3 → withdraw against Preprod", async ({ context }) => {
    const env = readEnv();
    const page = context.pages()[0] ?? (await context.newPage());

    // 1) Land on the home route. baseURL comes from playwright.config.ts
    // (localhost in dev, preprod.lovejo.in in staging dispatch).
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 3, name: "Deposit" })).toBeVisible();

    // 2) Connect wallet.
    await connectWallet(context, page, {
      kind: env.walletKind,
      passphrase: env.passphrase,
      walletNameRegex: env.walletNameRegex,
    });

    // 3) Unlock the vault via signData. The Vault page's "Unlock with
    // wallet" button triggers a wallet popup with a CIP-8 sign request;
    // the driver fills the passphrase + confirms.
    await page.goto("/vault");
    await expect(page.getByRole("heading", { name: /Vault locked/i })).toBeVisible();
    await Promise.all([
      drivePopup(context, { kind: env.walletKind, passphrase: env.passphrase }),
      page.getByRole("button", { name: /Unlock with wallet/i }).click(),
    ]);
    // Once unlocked, the locked-state heading disappears.
    await expect(page.getByRole("heading", { name: /Vault locked/i })).toBeHidden({
      timeout: 30_000,
    });

    // 4) Deposit a single mix-box. The submit button signs a tx via the
    // wallet popup; on success a toast renders the cardanoscan link with
    // the deposit tx hash in the href.
    await page.goto("/deposit");
    const depositSubmit = page.getByRole("button", { name: /^Deposit$/ });
    await expect(depositSubmit).toBeEnabled({ timeout: 30_000 });
    await Promise.all([
      drivePopup(context, { kind: env.walletKind, passphrase: env.passphrase }),
      depositSubmit.click(),
    ]);
    const depositTx = await waitForToastTxHash(page, /Deposit submitted/i);
    await awaitConfirmation(env.blockfrostProjectId, depositTx);

    // Allow the periodic vault rescan a window to discover the new box
    // before we start submitting mix txs that depend on it. The Deposit
    // route schedules a rescan ~12s after submit.
    await page.waitForTimeout(15_000);

    // 5) Run three Mix txs. Shard-mode mixes are wallet-anonymous (no
    // wallet signature), so no popups fire — we just click + scrape the
    // tx hash from the toast. Pool's N is fixed by the deployed cap; we
    // run three rounds to stack linkage entropy as the milestone spec
    // requires ("3 mixes via 'Mix N random boxes' at varied N" — N is
    // varied across deploys, not within a single run).
    const mixTxIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      await page.goto("/pool");
      const mixButton = page.getByRole("button", { name: /Submit Mix tx/i });
      await expect(mixButton).toBeEnabled({ timeout: 60_000 });
      await mixButton.click();
      const mixTx = await waitForToastTxHash(page, /Mix submitted/i);
      mixTxIds.push(mixTx);
      await awaitConfirmation(env.blockfrostProjectId, mixTx);
    }
    expect(mixTxIds).toHaveLength(3);
    expect(new Set(mixTxIds).size).toBe(3); // distinct hashes

    // 6) Withdraw the first owned box to E2E_DESTINATION_BECH32. The
    // Vault list links each row to /vault/<txid>/<idx>; we click the
    // first row's primary action and fill the destination field.
    await page.goto("/vault");
    const firstRowAction = page.getByRole("link", { name: /Withdraw/i }).first();
    await expect(firstRowAction).toBeVisible({ timeout: 60_000 });
    await firstRowAction.click();
    await page
      .getByRole("textbox", { name: /destination|address/i })
      .first()
      .fill(env.destination);
    const withdrawSubmit = page.getByRole("button", { name: /^Withdraw$/ });
    await expect(withdrawSubmit).toBeEnabled({ timeout: 30_000 });
    await Promise.all([
      drivePopup(context, { kind: env.walletKind, passphrase: env.passphrase }),
      withdrawSubmit.click(),
    ]);
    const withdrawTx = await waitForToastTxHash(page, /Withdraw submitted/i);
    await awaitConfirmation(env.blockfrostProjectId, withdrawTx);
  });
});

/**
 * Wait for a success-toast that matches `titlePattern` and pull the tx
 * hash out of its cardanoscan link. The link href is stable
 * (`https://preprod.cardanoscan.io/transaction/<hash>`); the toast title
 * copy and i18n is not.
 */
async function waitForToastTxHash(
  page: import("@playwright/test").Page,
  titlePattern: RegExp,
): Promise<string> {
  const toast = page.getByRole("status").filter({ hasText: titlePattern }).first();
  await expect(toast).toBeVisible({ timeout: 3 * 60_000 });
  const link = toast.getByRole("link").first();
  const href = await link.getAttribute("href");
  if (!href) throw new Error("toast rendered without a cardanoscan link");
  const match = href.match(/\/transaction\/([0-9a-f]{64})/i);
  if (!match) throw new Error(`could not extract tx hash from href: ${href}`);
  return match[1].toLowerCase();
}

/**
 * Poll Blockfrost `/txs/{hash}` until the tx appears (i.e. is in a
 * confirmed block). Throws on timeout. Independent of the SDK's own
 * `awaitConfirmation` so the E2E doesn't depend on offchain build state.
 */
async function awaitConfirmation(
  blockfrostProjectId: string,
  txHash: string,
  timeoutMs = 8 * 60_000,
): Promise<void> {
  const url = `https://cardano-preprod.blockfrost.io/api/v0/txs/${txHash}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(url, { headers: { project_id: blockfrostProjectId } });
    if (r.ok) return;
    if (r.status !== 404) {
      throw new Error(`Blockfrost ${url} returned ${r.status} ${r.statusText}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`tx ${txHash} did not confirm within ${timeoutMs}ms`);
}
