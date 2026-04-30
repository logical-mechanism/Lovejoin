// "Mix N random boxes" button — the Pool screen's primary CTA.
//
// Spec: docs/spec/06-ui.md §"Pool" + M6.5 — picks N boxes uniformly at
// random from the pool, picks a fee shard, requests collateral, builds +
// submits the Mix tx. M6.5 restored the fee-payer toggle (shard | wallet)
// the M6 implementation hard-coded.
//
// Hard-disabled when the collateral provider is unreachable (Privacy UX
// rule 8). Cooldown of 5 s after each click prevents accidental
// double-submission while a tx is in flight.
//
// Wallet handling: shard-mode submission is wallet-anonymous by design —
// no wallet input, no wallet signature, collateral signed by giveme.my.
// The button is therefore reachable WITHOUT a connected wallet on the
// shard path: anyone can submit mix txs to the public pool, which
// improves linkage probability for everyone. Wallet-mode still requires
// a wallet (the wallet pays the fee + signs); the button disables
// itself with an inline hint when that combination is selected without
// a wallet present.
//
// Box-selection strategy (see pickMixInputs):
//   * Shard mode → uniform random over the whole pool. The whole point
//     of the shared path is "truly random" — submitter anonymity is
//     wasted if the on-chain shape of the inputs leaks who picked.
//   * Wallet mode + locked vault / no owned boxes / no owned in pool →
//     uniform random. We can't bias toward unknown owned boxes.
//   * Wallet mode + small pool (< POOL_BIAS_THRESHOLD) + at least one
//     owned box visible in the pool → force-include exactly one of the
//     submitter's own boxes, fill the rest from non-owned. The wallet's
//     pkh is already on the tx (it pays the fee), so an observer can
//     correlate submitter→inputs anyway; the privacy floor isn't moved
//     by force-inclusion. What it DOES buy is real progress for the
//     fee they're spending — an early-pool user paying for wallet-mode
//     wants to actively advance their own box's anonymity.
//   * Wallet mode + healthy pool (≥ POOL_BIAS_THRESHOLD) → uniform
//     random. In a healthy pool the natural-random hit rate on owned
//     boxes is high enough that biasing is unnecessary, and "wallet-fee
//     mix tx ALWAYS includes one of submitter's boxes" would leak a
//     correlatable pattern across many txs — which random selection
//     in a populated pool naturally avoids.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserWallet } from "@meshsdk/core";
import {
  buildMixTx,
  type ChainProvider,
  type LovejoinAddresses,
  type MixFeePayer,
  type MixInput,
  type Utxo,
} from "@lovejoin/sdk";

import type { Network } from "../lib/sdk.js";
import { useAppState } from "../lib/store.js";
import {
  useCollateralStatus,
  useRefreshCollateralStatus,
} from "./CollateralProviderStatus.js";
import { Modal } from "./ui/Modal.js";

/** Pool-size cutoff for wallet-mode owned-box biasing. See header comment. */
const POOL_BIAS_THRESHOLD = 8;

const COOLDOWN_MS = 5000;

export interface MixButtonProps {
  network: Network;
  provider: ChainProvider;
  addresses: LovejoinAddresses;
  /**
   * Connected CIP-30 wallet, or null. Shard-mode submission works with
   * either; wallet-mode requires a non-null wallet (it pays the fee +
   * signs the tx).
   */
  wallet: BrowserWallet | null;
  /** Pool of boxes to pick from (already filtered to mix-script address). */
  poolEntries: ReadonlyArray<{ ref: { txId: string; outputIndex: number }; a: Uint8Array; b: Uint8Array }>;
  n: number;
  /** Who pays the tx fee. "shard" pulls from the on-chain pool; "wallet" charges the submitter. */
  feePayer: MixFeePayer;
  onSubmitted: (txId: string) => void;
  onError: (message: string) => void;
  /**
   * Bubbled to the parent so it can wrap its section in a busy overlay
   * the moment the user confirms — the build/sign/submit takes 5–10 s
   * and the button alone is too small a feedback target for that wait.
   */
  onSubmittingChange?: (submitting: boolean) => void;
}

export function MixButton({
  network,
  provider,
  addresses,
  wallet,
  poolEntries,
  n,
  feePayer,
  onSubmitted,
  onError,
  onSubmittingChange,
}: MixButtonProps) {
  const { t } = useTranslation();
  const { ownedBoxes, markTxPending } = useAppState();
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const cooldownTimer = useRef<number | null>(null);
  const collateral = useCollateralStatus();
  const refreshCollateral = useRefreshCollateralStatus();

  // Set of owned box refs for the wallet-mode bias strategy. Empty when
  // the vault is locked, when the user has no boxes, or when nothing
  // they own is currently in the pool — pickMixInputs falls back to
  // pure random in any of those cases. Memoized on `ownedBoxes` so it
  // doesn't churn each render of the Pool screen.
  const ownedRefSet = useMemo(
    () => new Set(ownedBoxes.map((b) => refKey(b.entry.ref))),
    [ownedBoxes],
  );

  useEffect(() => {
    return () => {
      if (cooldownTimer.current !== null) {
        window.clearInterval(cooldownTimer.current);
      }
    };
  }, []);

  const collateralOk = collateral?.status === "online";
  const enoughBoxes = poolEntries.length >= n && n >= 2;
  // Wallet-mode pays the fee from a wallet UTxO and needs a wallet
  // signature; without a connected wallet there's no path to build
  // that tx. Shard-mode has no such constraint.
  const walletModeNeedsWallet = feePayer === "wallet" && !wallet;
  const disabled =
    submitting ||
    cooldown > 0 ||
    !collateralOk ||
    !enoughBoxes ||
    walletModeNeedsWallet;

  const onRequestSubmit = () => {
    if (disabled) return;
    // Wallet-fee mode: the wallet's signTx prompt IS the confirmation
    // — showing a modal first is a redundant click. Shard-fee mode has
    // no signing prompt (the tx is submitter-anonymous), so the modal
    // is still the only surface where the user actually confirms.
    if (feePayer === "wallet") {
      void onConfirmSubmit();
      return;
    }
    setConfirmOpen(true);
  };

  const onConfirmSubmit = async () => {
    if (disabled) return;
    setConfirmOpen(false);
    setSubmitting(true);
    onSubmittingChange?.(true);
    try {
      const picked = pickMixInputs({
        pool: poolEntries,
        n,
        feePayer,
        ownedRefs: ownedRefSet,
      });
      const inputs = picked.map<MixInput>((e) => {
        const utxo: Utxo = {
          ref: e.ref,
          address: "",
          lovelace: BigInt(addresses.protocol.denom_lovelace),
          assets: {},
          inlineDatum: null,
          referenceScript: null,
        };
        return { ref: e.ref, a: e.a, b: e.b, utxo };
      });
      const result = await buildMixTx({
        network: network as "preprod" | "preview" | "mainnet",
        inputs,
        // SDK accepts `wallet?` and validates per-mode internally —
        // shard mode + giveme.my succeeds with `undefined`, wallet
        // mode throws if it isn't here. The disabled calc above
        // already gates the wallet-mode-without-wallet case, so this
        // null→undefined coercion only ever runs for shard mode.
        ...(wallet ? { wallet } : {}),
        provider,
        addresses,
        feePayer,
      });
      // Mark any of the user's own boxes that ended up as Mix inputs
      // as pending so the Vault row dims out until the rescan
      // confirms the spend. Only relevant when wallet-mode + bias hit
      // (or shard-mode pure-random happened to grab one), so most
      // submits write zero refs here.
      const ownedInputs = picked
        .map((e) => refKey(e.ref))
        .filter((key) => ownedRefSet.has(key));
      if (ownedInputs.length > 0) {
        markTxPending(ownedInputs);
      }
      onSubmitted(result.txId);
      startCooldown();
    } catch (e) {
      onError((e as Error).message);
      refreshCollateral();
    } finally {
      setSubmitting(false);
      onSubmittingChange?.(false);
    }
  };

  const startCooldown = () => {
    setCooldown(COOLDOWN_MS / 1000);
    if (cooldownTimer.current !== null) window.clearInterval(cooldownTimer.current);
    cooldownTimer.current = window.setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) {
          if (cooldownTimer.current !== null) window.clearInterval(cooldownTimer.current);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  };

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={onRequestSubmit}
        disabled={disabled}
        className="lj-btn lj-btn--primary lj-btn--lg"
      >
        {submitting && (
          <span className="lj-spinner lj-spinner--sm" aria-hidden="true" />
        )}
        {submitting
          ? t("pool.mix_submitting")
          : cooldown > 0
            ? t("pool.mix_cooldown", { s: cooldown })
            : t("pool.mix_n_random_boxes", { n })}
      </button>
      {!collateralOk && (
        <p className="text-xs text-amber">{t("pool.mix_disabled_collateral")}</p>
      )}
      {collateralOk && !enoughBoxes && (
        <p className="text-xs text-whisper">
          {t("pool.mix_disabled_pool", { have: poolEntries.length, need: n })}
        </p>
      )}
      {collateralOk && enoughBoxes && walletModeNeedsWallet && (
        <p className="text-xs text-whisper">
          {t("pool.mix_disabled_wallet_needed")}
        </p>
      )}

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t("pool.confirm_title")}
      >
        <header className="mb-5">
          <p className="lj-eyebrow">{t("pool.confirm_eyebrow")}</p>
          <h2 className="mt-2 font-display text-2xl font-light tracking-tight text-paper">
            {t("pool.confirm_title")}
          </h2>
          <p className="mt-2 text-sm text-muted">
            {feePayer === "shard"
              ? t("pool.confirm_lede_shard")
              : t("pool.confirm_lede_wallet")}
          </p>
        </header>
        <dl className="lj-banner lj-banner--signal flex-col items-stretch gap-3">
          <div className="flex justify-between gap-4">
            <dt className="lj-eyebrow">{t("pool.review_width")}</dt>
            <dd className="font-mono text-sm text-paper" data-num>
              {n}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="lj-eyebrow">{t("pool.review_fee_path")}</dt>
            <dd className="text-sm text-paper">
              {feePayer === "shard"
                ? t("pool.review_fee_path_shard")
                : t("pool.review_fee_path_wallet")}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="lj-eyebrow">{t("pool.review_collateral")}</dt>
            <dd className="text-sm text-muted">
              {t("pool.review_collateral_value")}
            </dd>
          </div>
        </dl>
        <footer className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className="lj-btn lj-btn--quiet"
            onClick={() => setConfirmOpen(false)}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="lj-btn lj-btn--primary"
            onClick={() => void onConfirmSubmit()}
          >
            {t("pool.confirm_submit")}
          </button>
        </footer>
      </Modal>
    </div>
  );
}

/** Stable Set key for a UTxO ref. Lowercase tx-hash to match indexer canon. */
function refKey(ref: { txId: string; outputIndex: number }): string {
  return `${ref.txId.toLowerCase()}#${ref.outputIndex}`;
}

/**
 * Mix-input picker with the shard / wallet / owned-bias strategy spelled
 * out in the file header. Pure function — exported for unit tests so we
 * can pin every branch (random, biased, biased-fallback).
 *
 * Returns an array of length `n`. Caller is responsible for ensuring
 * `pool.length >= n` (the MixButton's `enoughBoxes` gate enforces it).
 *
 * Branch table:
 *   shard mode                              → uniform random
 *   wallet mode + owned set empty           → uniform random
 *   wallet mode + nothing owned in pool     → uniform random
 *   wallet mode + pool ≥ POOL_BIAS_THRESHOLD → uniform random
 *   wallet mode + small pool + owned in pool:
 *     - if non-owned has ≥ n-1 entries → 1 random owned + (n-1) random non-owned
 *     - else (owned dominates the pool) → uniform random over the whole pool
 */
export function pickMixInputs<T extends { ref: { txId: string; outputIndex: number } }>(
  args: {
    pool: ReadonlyArray<T>;
    n: number;
    feePayer: MixFeePayer;
    ownedRefs: ReadonlySet<string>;
  },
): T[] {
  const { pool, n, feePayer, ownedRefs } = args;

  const useBias =
    feePayer === "wallet" &&
    ownedRefs.size > 0 &&
    pool.length < POOL_BIAS_THRESHOLD;

  if (!useBias) {
    return pickRandomBoxes(pool, n);
  }

  const ownedInPool = pool.filter((e) => ownedRefs.has(refKey(e.ref)));
  if (ownedInPool.length === 0) {
    // Vault unlocked but none of the user's boxes are currently in the
    // pool — no bias possible, fall back to uniform random.
    return pickRandomBoxes(pool, n);
  }

  const notOwned = pool.filter((e) => !ownedRefs.has(refKey(e.ref)));
  if (notOwned.length < n - 1) {
    // The user owns most or all of the small pool — fall back to uniform
    // random. Forcing a 1-owned + (n-1)-non-owned shape isn't possible.
    return pickRandomBoxes(pool, n);
  }

  const ownedPick = ownedInPool[Math.floor(Math.random() * ownedInPool.length)]!;
  const others = pickRandomBoxes(notOwned, n - 1);
  return [ownedPick, ...others];
}

function pickRandomBoxes<T>(items: ReadonlyArray<T>, n: number): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr.slice(0, n);
}
