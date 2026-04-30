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

import { useEffect, useRef, useState } from "react";
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
import {
  useCollateralStatus,
  useRefreshCollateralStatus,
} from "./CollateralProviderStatus.js";
import { Modal } from "./ui/Modal.js";

const COOLDOWN_MS = 5000;

export interface MixButtonProps {
  network: Network;
  provider: ChainProvider;
  addresses: LovejoinAddresses;
  wallet: BrowserWallet;
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
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const cooldownTimer = useRef<number | null>(null);
  const collateral = useCollateralStatus();
  const refreshCollateral = useRefreshCollateralStatus();

  useEffect(() => {
    return () => {
      if (cooldownTimer.current !== null) {
        window.clearInterval(cooldownTimer.current);
      }
    };
  }, []);

  const collateralOk = collateral?.status === "online";
  const enoughBoxes = poolEntries.length >= n && n >= 2;
  const disabled = submitting || cooldown > 0 || !collateralOk || !enoughBoxes;

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
      const inputs = pickRandomBoxes(poolEntries, n).map<MixInput>((e) => {
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
        wallet,
        provider,
        addresses,
        feePayer,
      });
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

function pickRandomBoxes<T>(items: ReadonlyArray<T>, n: number): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr.slice(0, n);
}
