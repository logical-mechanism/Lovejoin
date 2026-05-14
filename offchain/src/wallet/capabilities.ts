// CIP-30 wallet capability allowlist (issue #147).
//
// Lovejoin's fan-out strategy chains k waves of Mix txs back-to-back,
// each child consuming its parent's still-mempool outputs via mesh's
// `chainFrom.utxos`. In wallet-fee mode the user's connected CIP-30
// wallet has to sign every leaf tx, AND the wallet's own
// `getUtxos()` / coin-selection layer has to tolerate inputs that only
// exist in the mempool — not every wallet does. Some wallets only resolve
// inputs against the chain UTxO set and reject in-flight refs at sign
// time, which would crash the fan-out mid-run with no clean recovery.
//
// We treat the allowlist as a hard gate: only wallets we have empirically
// validated against the wallet-funded fan-out path are surfaced as
// eligible to the UI. The intent is conservative — false negatives just
// mean one extra release cycle to add a wallet, while false positives
// would brick the user's tree mid-run with the only recovery being
// "wait for the next block and rescan".
//
// This module is pure data + a lookup helper. The UI imports the helper
// to gate the fee-payer toggle at fan-out depth ≥ 2; the SDK does NOT
// enforce the allowlist at tx-build time, because callers running their
// own automation against `submitFanout` may have their own knowledge of
// which wallet they're driving.

/**
 * Per-wallet capability flags. A wallet is on the chained-tx allowlist
 * iff `chainedTxFanout` is true.
 */
export interface WalletCapabilities {
  /**
   * True when the wallet handles `signTx` for a tx whose inputs include
   * mempool-only parents (i.e. UTxOs created by an unconfirmed tx that
   * the user just submitted). False or unknown wallets fall back to the
   * shard-mode fan-out path, which is wallet-anonymous and never asks
   * the wallet to sign anything.
   *
   * Empirical work: PR #147 surfaced manual testing on Preprod against
   * Eternl and Lace. Other wallets stay opt-in until someone runs the
   * same matrix against them.
   */
  chainedTxFanout: boolean;
  /**
   * Static best-effort hint for whether the wallet supports CIP-103
   * (multi-tx signing via `signTxs`). The UI prefers the wallet's own
   * `getExtensions()` advertisement at connect time over this static
   * value — see {@link detectBatchSigningCip103}; the static table is
   * only consulted when the wallet doesn't expose getExtensions or
   * doesn't list CIP-103 there.
   *
   * Why keep a static value at all: some wallets (Eternl) ship CIP-103
   * support via an `experimental.signTxs` path that doesn't show up in
   * `getExtensions()`. The static table lets us still offer batch
   * signing in that case, while default-denying for unknown wallets.
   *
   * Empirical work: issue #149 confirmed Eternl supports CIP-103 (via
   * experimental.signTxs); Lace did not at the time of writing.
   */
  batchSigningCip103: boolean;
}

/**
 * Wallet ids as returned by mesh's `BrowserWallet.getInstalledWallets()`
 * (= the CIP-30 `cardano.<id>` namespace). Lower-cased; matched
 * case-insensitively at lookup time so a wallet that surfaces a custom
 * casing (e.g. "Eternl") still resolves correctly.
 */
export const WALLET_CAPABILITIES: Readonly<Record<string, WalletCapabilities>> = {
  // Eternl and Lace have been manually validated against the depth-2
  // wallet-funded fan-out path on Preprod with the giveme.my collateral
  // host bypassed (wallet supplies fee + collateral on every leaf).
  // Both accept an in-flight parent's outputs as inputs to a child tx
  // when the parent is in their own mempool view. Adding a new wallet
  // requires the same manual matrix; do not extend this list from a
  // datasheet.
  eternl: { chainedTxFanout: true, batchSigningCip103: true },
  lace: { chainedTxFanout: true, batchSigningCip103: false },
};

/**
 * Look up a wallet's capabilities by id (case-insensitive). Returns
 * `null` for unknown wallets so callers can distinguish "explicitly not
 * supported" from "no entry, treat as default-deny".
 */
export function getWalletCapabilities(
  walletId: string | null | undefined,
): WalletCapabilities | null {
  if (!walletId) return null;
  const key = walletId.toLowerCase();
  return WALLET_CAPABILITIES[key] ?? null;
}

/**
 * True when the connected CIP-30 wallet is known to handle the chained-tx
 * sign sequence the wallet-funded fan-out path requires. Default-deny:
 * unknown wallets return false. Used by the UI to gate the fee-payer
 * toggle at depth ≥ 2.
 */
export function walletSupportsChainedFanout(walletId: string | null | undefined): boolean {
  return getWalletCapabilities(walletId)?.chainedTxFanout === true;
}

/**
 * Minimum wallet surface for batch-sign detection. Implemented by mesh's
 * `BrowserWallet` — typed as the structural intersection so the SDK
 * doesn't import the mesh runtime just for the check.
 */
export interface BatchSigningProbe {
  getExtensions(): Promise<number[]>;
}

/**
 * Probe a connected wallet for CIP-103 (multi-tx signing) support. Used
 * by the UI at connect time to decide whether the batch-sign fan-out
 * path is available; result is cached in app state so each fan-out run
 * doesn't re-probe.
 *
 * Resolution order:
 *
 *   1. Wallet's `getExtensions()` advertises `103` → true. This is the
 *      authoritative signal per CIP-103, and catches a wallet that ships
 *      support in a future version we haven't manually validated.
 *   2. The wallet is on the static allowlist with `batchSigningCip103:
 *      true` → true. Covers wallets like Eternl that route through an
 *      `experimental.signTxs` path mesh detects internally but that
 *      doesn't surface in `getExtensions()`.
 *   3. Default-deny.
 *
 * A `getExtensions()` rejection (network glitch, wallet quirk) doesn't
 * abort — we fall through to the static allowlist so the user can still
 * batch-sign on Eternl even when its extension list fails to load.
 */
export async function detectBatchSigningCip103(
  wallet: BatchSigningProbe | null | undefined,
  walletId: string | null | undefined,
): Promise<boolean> {
  if (wallet) {
    try {
      const extensions = await wallet.getExtensions();
      if (Array.isArray(extensions) && extensions.includes(103)) return true;
    } catch {
      // fall through to static lookup.
    }
  }
  return getWalletCapabilities(walletId)?.batchSigningCip103 === true;
}
