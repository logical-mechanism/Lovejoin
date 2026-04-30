// Donate — top up the shared fee_contract pool without minting a mix-box.
//
// The on-chain fee_contract accepts any positive Replenish (fee_out >
// fee_in, unit datum unchanged, ada-only). Deposits already exercise that
// path implicitly; this screen surfaces it as a standalone action so
// donors and operators can pad the pool whenever it runs low. There's
// no anonymity story here — the donor's wallet is on the tx — so the
// flow is the simplest possible: pick an amount, sign, submit.
//
// We deliberately do not unlock the vault for this flow. Donations are
// not derived from the seed; the wallet just signs a Replenish tx.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { buildDonateTx } from "@lovejoin/sdk";

import { useAppState } from "../lib/store.js";
import { Eyebrow } from "../components/ui/Eyebrow.js";
import { useToast } from "../components/Toaster.js";
import { useBackendStatus } from "../components/BackendStatus.js";
import { BackendClient } from "../lib/backend.js";
import { formatAda } from "../lib/format.js";

const DEFAULT_AMOUNT_ADA = 5;
const MIN_AMOUNT_ADA = 1;
// Soft cap on the input field — donations bigger than this are unusual
// enough that we want the donor to type the digit explicitly rather
// than fat-finger a stepper into the hundreds.
const MAX_AMOUNT_ADA = 1_000;

export function Donate() {
  const { t } = useTranslation();
  const toast = useToast();
  const {
    config,
    provider,
    addresses,
    wallet,
    walletLovelace,
    refreshWalletBalance,
  } = useAppState();
  const backend = useBackendStatus();

  const [amountAda, setAmountAda] = useState<number>(DEFAULT_AMOUNT_ADA);
  const [submitting, setSubmitting] = useState(false);
  const [poolLovelace, setPoolLovelace] = useState<bigint | null>(null);
  const [shardCount, setShardCount] = useState<number | null>(null);

  // Best-effort fee-pool snapshot. The backend already exposes /fee, so
  // when the indexer is up we surface "pool is at X ADA across N shards"
  // to give the donor a sense of impact. Failure is silent — donations
  // work without it.
  useEffect(() => {
    let cancelled = false;
    const useBackend =
      !!config.backendUrl &&
      (backend?.status === "synced" || backend?.status === "syncing");
    if (!useBackend) {
      setPoolLovelace(null);
      setShardCount(null);
      return;
    }
    void (async () => {
      try {
        const client = new BackendClient(config.backendUrl);
        const snap = await client.fee();
        if (cancelled || !snap) return;
        setPoolLovelace(BigInt(snap.totalLovelace));
        setShardCount(snap.shardCount);
      } catch {
        /* surface nothing — the snapshot is decorative */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config.backendUrl, backend?.status]);

  if (!provider || !addresses || !wallet) {
    return (
      <section className="lj-card">
        <header className="lj-card__head">
          <div>
            <Eyebrow>{t("donate.eyebrow")}</Eyebrow>
            <h2 className="lj-card__title">{t("donate.section_title")}</h2>
          </div>
        </header>
        <p className="text-sm text-muted leading-relaxed max-w-prose">
          {t("donate.preconditions_missing")}
        </p>
      </section>
    );
  }

  const donationLovelace = BigInt(Math.max(0, Math.floor(amountAda * 1_000_000)));
  // 5 ADA cushion mirrors the deposit form — covers tx fee + change min-utxo.
  const requiredLovelace = donationLovelace + 5_000_000n;
  const balanceShort =
    walletLovelace !== null && walletLovelace < requiredLovelace;
  const validAmount = donationLovelace > 0n;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || !validAmount) return;
    setSubmitting(true);
    try {
      const result = await buildDonateTx({
        network: config.network as "preprod" | "preview" | "mainnet",
        donationLovelace,
        wallet,
        provider,
        addresses,
      });
      toast.push({
        tone: "success",
        title: t("toast.donate_success"),
        txHash: result.txId,
        network: config.network,
      });
      // Re-fetch the snapshot so the impact line updates without a full
      // page reload. A small delay lets the indexer pick up the new shard
      // value; the snapshot is decorative, so it's fine if it's stale for
      // a few seconds.
      const useBackend =
        !!config.backendUrl &&
        (backend?.status === "synced" || backend?.status === "syncing");
      if (useBackend) {
        window.setTimeout(() => {
          void (async () => {
            try {
              const client = new BackendClient(config.backendUrl);
              const snap = await client.fee();
              if (snap) {
                setPoolLovelace(BigInt(snap.totalLovelace));
                setShardCount(snap.shardCount);
              }
            } catch {
              /* same as the mount fetch — silent */
            }
          })();
        }, 12_000);
      }
    } catch (err) {
      toast.push({
        tone: "error",
        title: t("toast.donate_failed"),
        detail: (err as Error).message,
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
          <Eyebrow>{t("donate.eyebrow")}</Eyebrow>
          <h2 className="lj-card__title">{t("donate.section_title")}</h2>
        </div>
        {poolLovelace !== null && shardCount !== null && (
          <div className="lj-stat">
            <span className="lj-stat__label">{t("donate.pool_label")}</span>
            <span className="lj-stat__value" data-num>
              {formatAda(poolLovelace)} ₳
            </span>
          </div>
        )}
      </header>
      <p className="text-sm text-muted leading-relaxed max-w-prose">
        {t("donate.lede")}
      </p>

      <form
        className="mt-6 flex flex-col gap-6"
        onSubmit={(e) => void onSubmit(e)}
        aria-busy={submitting}
      >
        <fieldset disabled={submitting} className="contents">
          <label className="lj-field">
            <span className="lj-field__label">{t("donate.amount_label")}</span>
            <input
              type="number"
              min={MIN_AMOUNT_ADA}
              max={MAX_AMOUNT_ADA}
              step="any"
              value={amountAda}
              onChange={(e) => {
                const next = Number.parseFloat(e.target.value);
                if (Number.isFinite(next)) {
                  setAmountAda(Math.min(MAX_AMOUNT_ADA, Math.max(0, next)));
                } else {
                  setAmountAda(0);
                }
              }}
              className="lj-input max-w-[10rem]"
            />
            <span className="lj-field__hint">{t("donate.amount_help")}</span>
          </label>

          <div className="lj-banner lj-banner--signal">
            <span className="lj-eyebrow">{t("donate.tx_preview_title")}</span>
            <span className="lj-banner__detail">
              {t("donate.tx_preview_copy", { amount: formatAda(donationLovelace) })}
            </span>
          </div>

          <div>
            <button
              type="submit"
              disabled={submitting || !validAmount}
              className="lj-btn lj-btn--primary lj-btn--lg"
            >
              {submitting && (
                <span className="lj-spinner lj-spinner--sm" aria-hidden="true" />
              )}
              {submitting ? t("donate.submitting") : t("donate.submit")}
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

      {submitting && (
        <div className="lj-overlay__indicator">
          <div className="lj-spinner" aria-label={t("donate.submitting")} />
        </div>
      )}
    </section>
  );
}
