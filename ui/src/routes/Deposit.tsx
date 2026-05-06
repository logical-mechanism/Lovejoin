// Deposit — single form, vault-derived owner secret.
//
// Spec: §"Deposit" + M6.5 vault rework. The owner
// secret is derived from the unlocked seed at the next available index;
// on success we toast (with a cardanoscan link) and trigger a rescan
// so the new box surfaces in the Vault screen within a few seconds.
//
// The deposit-time `(a, b)` are owned by the SDK (`buildDepositTx` picks
// a fresh `d` and computes `a = [d]·G`, `b = [x·d]·G`). The UI doesn't
// persist them — `findOwnedBoxes` re-derives ownership on every unlock.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { buildBulkDepositTx } from "@lovejoin/sdk";

import { useAppState } from "../lib/store.js";
import { Eyebrow } from "../components/ui/Eyebrow.js";
import { RecoverPasswordPanel } from "../components/RecoverPasswordPanel.js";
import { TxBuildProgress } from "../components/TxBuildProgress.js";
import { useBackendStatus } from "../components/BackendStatus.js";
import { useToast } from "../components/Toaster.js";
import { deriveDepositSecret } from "../lib/vault.js";
import { BackendClient } from "../lib/backend.js";
import { friendlyErrorMessage } from "../lib/errors.js";
import { formatAda } from "../lib/format.js";
import { depositPhases } from "../lib/tx-phases.js";

export function Deposit() {
  const { t } = useTranslation();
  const toast = useToast();
  const {
    config,
    provider,
    addresses,
    wallet,
    vault,
    vaultBusy,
    vaultError,
    nextDepositIndex,
    rescan,
    unlockWithWallet,
    walletLovelace,
    refreshWalletBalance,
  } = useAppState();
  const backend = useBackendStatus();
  const [rounds, setRounds] = useState<number>(30);
  const [count, setCount] = useState<number>(1);
  const [submitting, setSubmitting] = useState(false);
  // Mirrors the Vault locked screen so users on hardware wallets that
  // don't expose signData have the same password-recovery escape hatch
  // from here.
  const [showFallback, setShowFallback] = useState(false);

  // Reasonable upper bound: a deposit tx has 1 fee-shard input, N mix-box
  // outputs, 1 fee-shard output, plus mesh's wallet change — all ada-only.
  // 20 mix-boxes per tx fits comfortably within Cardano's 16 KB tx size
  // (each mix-box output is ~150 bytes for the address+value+inline datum).
  const MAX_BULK_COUNT = 20;

  // Locked-vault state mirrors the Vault screen exactly: always render
  // the unlock CTA so the path forward is visible, gate it behind a
  // connected wallet (disabled + "no_wallet" hint), and offer the
  // BIP-39 fallback for wallets that don't expose signData. Previously
  // this screen had a separate "no wallet" dead-end branch with no
  // actionable button — and no fallback at all, so users on signData-
  // less wallets hit a wall here even though Vault would have let them
  // through.
  if (!vault || vault.seed.length === 0) {
    if (showFallback) {
      return <RecoverPasswordPanel onClose={() => setShowFallback(false)} />;
    }
    return (
      <section className="lj-card">
        <header className="lj-card__head">
          <div>
            <Eyebrow>{t("deposit.eyebrow")}</Eyebrow>
            <h2 className="lj-card__title">{t("deposit.section_title")}</h2>
          </div>
        </header>
        <p className="text-sm text-muted leading-relaxed max-w-prose">{t("vault.locked_lede")}</p>
        <div className="mt-6">
          <button
            type="button"
            className="lj-btn lj-btn--primary lj-btn--lg"
            disabled={!wallet || vaultBusy}
            onClick={() => void unlockWithWallet()}
          >
            {vaultBusy && <span className="lj-spinner lj-spinner--sm" aria-hidden="true" />}
            {vaultBusy ? t("vault.unlocking") : t("vault.unlock_with_wallet")}
          </button>
        </div>
        {!wallet && <p className="mt-4 text-sm text-whisper">{t("vault.no_wallet")}</p>}
        <div className="mt-6 border-t border-rule pt-4">
          <button
            type="button"
            className="lj-btn lj-btn--quiet"
            onClick={() => setShowFallback(true)}
            disabled={!wallet}
            title={!wallet ? t("vault.no_wallet") : undefined}
          >
            {t("vault.recover_link")}
            <span aria-hidden="true">→</span>
          </button>
        </div>
        {vaultError && (
          <div className="lj-banner lj-banner--coral mt-6">
            <span className="lj-banner__title">
              {t("vault.unlock_failed", { message: vaultError })}
            </span>
          </div>
        )}
      </section>
    );
  }

  // Vault is unlocked — but the form below dereferences provider /
  // addresses / wallet directly, so guard them here. In practice unlock
  // requires a wallet, so the wallet check should never fail; provider
  // / addresses can still be null on a fresh load with a stale env, in
  // which case the Layout has already surfaced an `addressesError`
  // banner above this screen.
  if (!provider || !addresses || !wallet) {
    return (
      <section className="lj-card">
        <p className="text-sm text-muted">{t("deposit.preconditions_missing")}</p>
      </section>
    );
  }

  const denomLovelace = BigInt(addresses.protocol.denom_lovelace);
  const denomAda = formatAda(denomLovelace);

  // Estimated minimum spendable lovelace required for the configured
  // (count) deposits: the deposited principal × count, plus a 5 ADA
  // cushion to cover the tx fee + the change min-utxo. We treat this
  // as a soft hint, not a hard gate — the wallet's own balance may
  // include locked / pending UTxOs the SDK can't actually spend, so
  // false-negatives at the form level are worse than letting the user
  // attempt and surface mesh's authoritative error if it really fails.
  const requiredLovelace = denomLovelace * BigInt(count) + 5_000_000n;
  const balanceShort = walletLovelace !== null && walletLovelace < requiredLovelace;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      // Derive N owner secrets at consecutive HKDF indices so each new
      // mix-box has a distinct (a, b) and the vault rescan can find them
      // by sweeping the index range on next unlock.
      const ownerSecrets = Array.from(
        { length: count },
        (_, i) => deriveDepositSecret(vault.seed, nextDepositIndex + i).secret,
      );
      // Best-effort mempool snapshot so we don't pick a fee shard that's
      // already an input to an in-flight tx. Backend-only feature; on
      // Blockfrost-only deploys the snapshot stays empty and the SDK's
      // pickFeeShardOptional falls back to uniform-random across all
      // live shards.
      let excludeFeeShardRefs: Array<{ txId: string; outputIndex: number }> | undefined;
      const useBackend =
        !!config.backendUrl && (backend?.status === "synced" || backend?.status === "syncing");
      if (useBackend) {
        try {
          const client = new BackendClient(config.backendUrl);
          const snap = await client.mempoolInputs();
          if (snap && snap.inputs.length > 0) {
            excludeFeeShardRefs = snap.inputs.map((r) => ({
              txId: r.txHash,
              outputIndex: r.outputIndex,
            }));
          }
        } catch {
          /* mempool fetch failed; fall through to retry-only */
        }
      }
      const result = await buildBulkDepositTx({
        network: config.network as "preprod" | "preview" | "mainnet",
        rounds,
        ownerSecrets,
        wallet,
        provider,
        addresses,
        ...(excludeFeeShardRefs ? { excludeFeeShardRefs } : {}),
      });
      toast.push({
        tone: "success",
        title: t("toast.deposit_success"),
        txHash: result.txId,
        network: config.network,
      });
      window.setTimeout(() => void rescan(), 12_000);
    } catch (err) {
      toast.push({
        tone: "error",
        title: t("toast.deposit_failed"),
        detail: friendlyErrorMessage((err as Error).message, t),
      });
    } finally {
      setSubmitting(false);
      void refreshWalletBalance();
    }
  };

  return (
    <section className={`lj-card lj-overlay ${submitting ? "lj-overlay--busy" : ""}`}>
      <header className="lj-card__head">
        <div>
          <Eyebrow>{t("deposit.eyebrow")}</Eyebrow>
          <h2 className="lj-card__title">{t("deposit.section_title")}</h2>
        </div>
        <div className="lj-stat">
          <span className="lj-stat__label">{t("common.amount")}</span>
          <span className="lj-stat__value" data-num>
            {denomAda} ₳
          </span>
        </div>
      </header>
      <p className="text-sm text-muted leading-relaxed max-w-prose">{t("deposit.lede")}</p>

      <form
        className="mt-6 flex flex-col gap-6"
        onSubmit={(e) => void onSubmit(e)}
        aria-busy={submitting}
      >
        <fieldset disabled={submitting} className="contents">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="lj-field">
              <label className="lj-field__label" htmlFor="deposit-count">
                {t("deposit.count_label")}
              </label>
              <input
                id="deposit-count"
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_BULK_COUNT}
                value={count}
                onChange={(e) =>
                  setCount(
                    Math.min(MAX_BULK_COUNT, Math.max(1, Number.parseInt(e.target.value, 10) || 1)),
                  )
                }
                className="lj-input max-w-[10rem]"
                aria-describedby="deposit-count-help"
              />
              <span id="deposit-count-help" className="lj-field__hint">
                {t("deposit.count_help", {
                  denom: denomAda,
                  total: formatAda(denomLovelace * BigInt(count)),
                })}
              </span>
            </div>

            <div className="lj-field">
              <label className="lj-field__label" htmlFor="deposit-rounds">
                {t("deposit.rounds_label")}
              </label>
              <input
                id="deposit-rounds"
                type="number"
                inputMode="numeric"
                min={1}
                max={500}
                value={rounds}
                onChange={(e) => setRounds(Number.parseInt(e.target.value, 10) || 1)}
                className="lj-input max-w-[10rem]"
                aria-describedby="deposit-rounds-help"
              />
              <span id="deposit-rounds-help" className="lj-field__hint">
                {t("deposit.rounds_help")}
              </span>
            </div>
          </div>

          <div className="lj-banner lj-banner--signal">
            <span className="lj-eyebrow">{t("deposit.tx_preview_title")}</span>
            <span className="lj-banner__detail">
              {count > 1
                ? t("deposit.tx_preview_copy_bulk", {
                    count,
                    denom: denomAda,
                    total: formatAda(denomLovelace * BigInt(count)),
                  })
                : t("deposit.tx_preview_copy", { denom: denomAda })}
            </span>
          </div>

          <div>
            <button
              type="submit"
              disabled={submitting || rounds <= 0 || count <= 0}
              className="lj-btn lj-btn--primary lj-btn--lg"
            >
              {submitting && <span className="lj-spinner lj-spinner--sm" aria-hidden="true" />}
              {submitting ? t("deposit.submitting") : t("deposit.submit")}
            </button>
            {balanceShort && walletLovelace !== null && (
              <p className="mt-3 text-xs text-amber">
                {t("wallet.insufficient_balance", {
                  have: formatAda(walletLovelace),
                  need: formatAda(requiredLovelace),
                })}
              </p>
            )}
          </div>
        </fieldset>
      </form>

      <div className="lj-overlay__indicator">
        <TxBuildProgress
          active={submitting}
          phases={depositPhases(t)}
          ariaLabel={t("deposit.submitting")}
        />
      </div>
    </section>
  );
}
