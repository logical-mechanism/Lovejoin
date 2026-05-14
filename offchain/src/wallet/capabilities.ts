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
  eternl: { chainedTxFanout: true },
  lace: { chainedTxFanout: true },
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
