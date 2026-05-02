// Wallet-extension driver — wires CIP-30 popup automation for the
// funded-wallet Preprod flow (full-flow.spec.ts).
//
// Cardano CIP-30 wallets are browser extensions that surface popups for
// every privileged action: enable() (connect), signData() (vault unlock),
// signTx() (deposit/withdraw). Each popup is a separate Page in the same
// BrowserContext. This module finds those popups, fills the passphrase,
// and clicks the confirm button — then resolves once the popup closes
// and the page-side promise on `window.cardano.<id>` settles.
//
// Selectors are intentionally generic — Lace, Eternl, and Nami all use
// some variant of "Confirm" / "Sign" / "Authorize" / "Allow" for the
// affirmative button, plus a single password input. Wallet UIs rev
// independently, so when this breaks: open the popup interactively
// (`pnpm test:e2e --headed --debug full-flow`), inspect the DOM, and
// add a wallet-specific selector to the union below.
//
// The driver is wallet-agnostic — pass `{ kind: "lace" }` or "eternl"
// / "nami" to nudge the password-field selector when the generic match
// is ambiguous.

import { expect, type BrowserContext, type Page } from "@playwright/test";

export type WalletKind = "lace" | "eternl" | "nami" | "auto";

export interface WalletDriverOptions {
  kind?: WalletKind;
  passphrase: string;
  /** Soft timeout per popup (ms). Default 60s — wallet extensions are slow. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Affirmative-button text in priority order. First match wins. */
const CONFIRM_BUTTON_PATTERNS = [
  /^confirm$/i,
  /^sign$/i,
  /^authori[sz]e$/i,
  /^allow$/i,
  /^approve$/i,
  /^accept$/i,
  /^continue$/i,
];

/**
 * Wait for the next wallet-extension popup to open in `context`, drive it
 * (passphrase + confirm), and return once it closes. Use this around any
 * page-side action that triggers a CIP-30 prompt:
 *
 *     await Promise.all([
 *       drivePopup(context, { passphrase }),
 *       page.click("button:has-text('Connect')"),
 *     ]);
 *
 * The Promise.all pattern is critical: extensions race the page click.
 * If we awaited the click first we'd miss the popup-open event.
 */
export async function drivePopup(
  context: BrowserContext,
  { kind = "auto", passphrase, timeoutMs = DEFAULT_TIMEOUT_MS }: WalletDriverOptions,
): Promise<void> {
  const popup = await context.waitForEvent("page", { timeout: timeoutMs });
  await popup.waitForLoadState("domcontentloaded");

  // Some wallets (Lace) take a beat to render the password screen after
  // mount; some show an "Unlock" screen first that we have to confirm
  // through. Loop: try to confirm whatever screen is on top; if we still
  // see a password input, fill it and confirm again.
  const deadline = Date.now() + timeoutMs;
  let filledPassword = false;

  while (!popup.isClosed() && Date.now() < deadline) {
    // Look for a password field if we haven't filled one yet.
    if (!filledPassword) {
      const pw = await findPasswordInput(popup, kind);
      if (pw) {
        await pw.fill(passphrase);
        filledPassword = true;
      }
    }
    // Click the affirmative button if one is enabled.
    const button = await findConfirmButton(popup);
    if (button) {
      await button.click();
      // Give the wallet a moment to advance / close.
      await popup.waitForTimeout(500);
      continue;
    }
    // No actionable button + no password — the popup is mid-transition.
    // Tight retry loop with backoff is fine here; this only runs for the
    // duration of one popup.
    await popup.waitForTimeout(250);
  }

  // The popup should have closed itself by now. If not, something on the
  // wallet UI is keeping it open (re-enter passphrase prompt, error
  // banner). Surface that loudly rather than letting the caller hang.
  if (!popup.isClosed()) {
    throw new Error(
      `wallet popup did not close within ${timeoutMs}ms — wallet UI may have changed; ` +
        `re-run with --headed --debug to inspect`,
    );
  }
}

async function findPasswordInput(popup: Page, kind: WalletKind) {
  const candidates = [
    // Wallet-specific overrides — checked first so the generic match
    // doesn't grab a different field.
    kind === "lace" && popup.locator('input[type="password"][data-testid*="password" i]').first(),
    kind === "eternl" && popup.locator('input[type="password"]').first(),
    kind === "nami" && popup.locator('input[type="password"]').first(),
    // Generic.
    popup.locator('input[type="password"]').first(),
  ].filter(Boolean) as ReturnType<Page["locator"]>[];

  for (const c of candidates) {
    if ((await c.count()) > 0 && (await c.isVisible().catch(() => false))) {
      return c;
    }
  }
  return null;
}

async function findConfirmButton(popup: Page) {
  for (const pattern of CONFIRM_BUTTON_PATTERNS) {
    const button = popup.getByRole("button", { name: pattern }).first();
    if (
      (await button.count()) > 0 &&
      (await button.isVisible().catch(() => false)) &&
      (await button.isEnabled().catch(() => false))
    ) {
      return button;
    }
  }
  return null;
}

/**
 * Pick the wallet entry inside the Lovejoin WalletModal, then drive the
 * resulting CIP-30 enable() popup. Returns once the modal closes (the
 * Lovejoin app considers the wallet connected once `enable()` resolves).
 */
export async function connectWallet(
  context: BrowserContext,
  page: Page,
  opts: { kind?: WalletKind; passphrase: string; walletNameRegex: RegExp },
): Promise<void> {
  // Open the modal (header "Connect" CTA).
  await page
    .getByRole("button", { name: /Connect( wallet)?/i })
    .first()
    .click();
  // The modal lists installed CIP-30 wallets; click the matching row.
  const walletRow = page.getByRole("button", { name: opts.walletNameRegex }).first();
  await expect(walletRow).toBeVisible({ timeout: 30_000 });
  await Promise.all([
    drivePopup(context, { kind: opts.kind, passphrase: opts.passphrase }),
    walletRow.click(),
  ]);
  // Modal should auto-close on success.
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 30_000 });
}
