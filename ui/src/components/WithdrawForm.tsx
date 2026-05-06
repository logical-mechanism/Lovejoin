// Vault withdraw form — destination input, optional review block,
// signal banner, submit button + confirmation modal. Drives bulk
// withdraw via @lovejoin/sdk against the parent's selected boxes.
//
// Extracted from routes/Vault.tsx during the issue #97 split. The
// parent owns the selection set (so the same state can drive both
// this form and the table); this component owns the destination,
// validation, retry, submitting, and confirm-modal state.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  GivemeMyProvider,
  buildBulkWithdrawTx,
  isInputCollisionError,
  type BulkWithdrawEntry,
} from "@lovejoin/sdk";

import { Modal } from "./ui/Modal.js";
import { useToast } from "./Toaster.js";
import { WithdrawReview } from "./WithdrawReview.js";
import { friendlyErrorMessage } from "../lib/errors.js";
import { formatAda } from "../lib/format.js";
import { validateDestination } from "../lib/seedelf.js";
import { useAppState } from "../lib/store.js";
import type { OwnedBox } from "../lib/vault.js";

// Soft hint floor. Withdraw fees are paid by the connected wallet
// (collateral comes from giveme.my); 3 ADA covers tx fee + min-utxo
// overhead with headroom across N up to bulk_withdraw's cap. Not a
// hard gate — the wallet may have a pending UTxO the SDK ends up
// using even though our cached balance can't see it.
const WITHDRAW_REQUIRED_LOVELACE = 3_000_000n;

export interface WithdrawFormProps {
  selectedBoxes: OwnedBox[];
  ownedBoxesCount: number;
  /** Parent uses this to toggle the section's lj-overlay--busy class. */
  onSubmittingChange: (busy: boolean) => void;
  /** Fires after a successful submit so the parent can clear selection. */
  onSubmitted: () => void;
}

export function WithdrawForm({
  selectedBoxes,
  ownedBoxesCount,
  onSubmittingChange,
  onSubmitted,
}: WithdrawFormProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const {
    config,
    provider,
    addresses,
    wallet,
    vault,
    walletLovelace,
    rescan,
    markTxPending,
    refreshWalletBalance,
  } = useAppState();
  const [destination, setDestination] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    onSubmittingChange(submitting);
  }, [submitting, onSubmittingChange]);

  const totalLovelace = useMemo(
    () => selectedBoxes.reduce((acc, b) => acc + b.entry.utxo.lovelace, 0n),
    [selectedBoxes],
  );

  const validation = useMemo(
    () => validateDestination(destination, config.network),
    [destination, config.network],
  );

  const preconditionsOk = !!provider && !!addresses && !!wallet && !!vault;
  const canSubmit =
    preconditionsOk && selectedBoxes.length > 0 && validation.status === "ok" && !submitting;

  const balanceShort =
    !!wallet && walletLovelace !== null && walletLovelace < WITHDRAW_REQUIRED_LOVELACE;

  const onRequestSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setConfirmOpen(true);
  };

  const onConfirmSubmit = async () => {
    if (!preconditionsOk || selectedBoxes.length === 0 || submitting) return;
    if (validation.status !== "ok") return;
    setConfirmOpen(false);
    setSubmitting(true);
    setRetryAttempt(null);
    try {
      const entries: BulkWithdrawEntry[] = selectedBoxes.map((b) => ({
        mixBox: { ref: b.entry.ref, a: b.entry.a, b: b.entry.b },
        ownerSecret: b.secret,
      }));
      // Empty config endpoint = let the SDK use its pinned host URL.
      const collateralProvider = new GivemeMyProvider({
        network: config.network,
        ...(config.collateralProviderEndpoint
          ? { endpoint: config.collateralProviderEndpoint }
          : {}),
      });
      const result = await buildBulkWithdrawTx({
        network: config.network as "preprod" | "preview" | "mainnet",
        entries,
        destinationAddressBech32: destination.trim(),
        wallet: wallet!,
        provider: provider!,
        addresses: addresses!,
        collateralProvider,
        retry: {
          maxAttempts: 3,
          delayBetweenAttemptsMs: 2_000,
          onRetry: (info) => setRetryAttempt(info.attempt),
        },
      });
      toast.push({
        tone: "success",
        title: t("toast.withdraw_success"),
        txHash: result.txId,
        network: config.network,
      });
      // Mark the just-submitted boxes as pending so the rows render
      // dimmed + locked until the rescan confirms the spend (or the
      // 90 s safety timer expires). Closes the perceptual gap between
      // "submitted" toast and the boxes leaving the table.
      markTxPending(
        selectedBoxes.map((b) => `${b.entry.ref.txId.toLowerCase()}#${b.entry.ref.outputIndex}`),
      );
      setDestination("");
      onSubmitted();
      window.setTimeout(() => void rescan(), 12_000);
    } catch (err) {
      const busy = isInputCollisionError(err);
      toast.push({
        tone: "error",
        title: busy ? t("tx.busy_title") : t("toast.withdraw_failed"),
        detail: busy ? t("tx.busy_detail") : friendlyErrorMessage((err as Error).message, t),
      });
    } finally {
      setSubmitting(false);
      setRetryAttempt(null);
      void refreshWalletBalance();
    }
  };

  return (
    <>
      <form className="space-y-6" onSubmit={onRequestSubmit} aria-busy={submitting}>
        <fieldset disabled={submitting} className="contents">
          <div className="mt-4 mb-6 border-t border-b border-rule py-6">
            <p className="lj-eyebrow mb-3">{t("withdraw.destination_section")}</p>
            <div className="lj-field">
              <label className="lj-field__label" htmlFor="vault-destination">
                {t("withdraw.destination_label")}
              </label>
              <input
                id="vault-destination"
                type="text"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                placeholder={t("withdraw.destination_placeholder")}
                className={`lj-input${
                  validation.status === "invalid" || validation.status === "wrong-network"
                    ? " lj-input--error"
                    : ""
                }`}
                aria-invalid={
                  validation.status === "invalid" || validation.status === "wrong-network"
                }
                aria-describedby="vault-destination-help"
              />
              <div id="vault-destination-help">
                {validation.status === "invalid" && (
                  <p className="lj-field__error" role="alert">
                    {t("withdraw.dest_invalid")}
                  </p>
                )}
                {validation.status === "wrong-network" && (
                  <p className="lj-field__warn" role="alert">
                    {t("withdraw.dest_wrong_network")}
                  </p>
                )}
                {validation.status === "ok" && validation.kind.kind === "regular-key" && (
                  <p className="lj-field__hint">{t("withdraw.dest_regular_key")}</p>
                )}
                {validation.status === "ok" && validation.kind.kind === "stealth" && (
                  <p className="lj-field__hint">{t("withdraw.dest_stealth")}</p>
                )}
              </div>
            </div>
          </div>

          {selectedBoxes.length > 0 && (
            <WithdrawReview
              lovelace={totalLovelace}
              destination={destination}
              validation={validation}
            />
          )}

          <div className="lj-banner lj-banner--signal">
            <span className="lj-eyebrow">{t("withdraw.tx_preview_title")}</span>
            <span className="lj-banner__detail">{t("withdraw.tx_preview_copy")}</span>
          </div>

          <div>
            <button
              type="submit"
              disabled={!canSubmit}
              className="lj-btn lj-btn--primary lj-btn--lg"
            >
              {submitting && <span className="lj-spinner lj-spinner--sm" aria-hidden="true" />}
              {submitting ? t("withdraw.submitting") : t("withdraw.submit")}
            </button>
            {!preconditionsOk && (
              <p className="mt-3 text-sm text-muted">{t("withdraw.preconditions_missing")}</p>
            )}
            {preconditionsOk &&
              selectedBoxes.length === 0 &&
              ownedBoxesCount > 0 &&
              !submitting && (
                <p className="mt-3 text-xs text-whisper">{t("withdraw.no_box_selected")}</p>
              )}
            {balanceShort && walletLovelace !== null && !submitting && (
              <p className="mt-3 text-xs text-amber">
                {t("wallet.insufficient_balance", {
                  have: formatAda(walletLovelace),
                  need: formatAda(WITHDRAW_REQUIRED_LOVELACE),
                })}
              </p>
            )}
            {retryAttempt !== null && (
              <p className="mt-3 text-xs text-amber">
                {t("tx.retrying_collision", { attempt: retryAttempt })}
              </p>
            )}
          </div>
        </fieldset>
      </form>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t("withdraw.confirm_title")}
      >
        <header className="mb-5">
          <p className="lj-eyebrow">{t("withdraw.confirm_eyebrow")}</p>
          <h2 className="mt-2 font-display text-2xl font-light tracking-tight text-paper">
            {t("withdraw.confirm_title")}
          </h2>
          <p className="mt-2 text-sm text-muted">{t("withdraw.confirm_lede")}</p>
        </header>
        <dl className="lj-banner lj-banner--signal flex-col items-stretch gap-3">
          <div>
            <dt className="lj-eyebrow">{t("withdraw.confirm_summary_label")}</dt>
            <dd className="lj-banner__detail mt-1">
              {t("withdraw.selection_summary", {
                count: selectedBoxes.length,
                total: formatAda(totalLovelace),
              })}
            </dd>
          </div>
          <div>
            <dt className="lj-eyebrow">{t("withdraw.destination_label")}</dt>
            <dd className="mt-1 break-all font-mono text-xs text-paper">{destination.trim()}</dd>
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
            {t("withdraw.confirm_submit")}
          </button>
        </footer>
      </Modal>
    </>
  );
}
