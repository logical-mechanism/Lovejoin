// Donate. Top up the shared fee_contract pool without minting a mix-box.
//
// The on-chain fee_contract accepts any positive Replenish (fee_out >
// fee_in, unit datum unchanged, ada-only). Deposits already exercise that
// path implicitly; this screen surfaces it as a standalone action so
// donors and operators can pad the pool whenever it runs low. There's
// no anonymity story here (the donor's wallet is on the tx), so the
// flow is the simplest possible: pick an amount, sign, submit.
//
// We deliberately do not unlock the vault for this flow. Donations are
// not derived from the seed; the wallet just signs a Replenish tx.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { buildDonateTx, isInputCollisionError } from "@lovejoin/sdk";

import { useAppState } from "../lib/store.js";
import { Eyebrow } from "../components/ui/Eyebrow.js";
import { Hash } from "../components/ui/Hash.js";
import { useToast } from "../components/Toaster.js";
import { useBackendStatus } from "../components/BackendStatus.js";
import { BackendClient, type FeeShard } from "../lib/backend.js";
import { formatAda } from "../lib/format.js";

const DEFAULT_AMOUNT_ADA = 5;
const MIN_AMOUNT_ADA = 1;
// Soft cap on the input field. Donations bigger than this are unusual
// enough that we want the donor to type the digit explicitly rather
// than fat-finger a stepper into the hundreds.
const MAX_AMOUNT_ADA = 1_000;
// Threshold for switching from per-shard rows to a total-only summary.
// The canonical fee_shard_target is 10; this leaves headroom for a few
// extras while keeping the list compact enough to read at a glance.
const SHARD_LIST_LIMIT = 12;

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
  const [retryAttempt, setRetryAttempt] = useState<number | null>(null);
  const [poolLovelace, setPoolLovelace] = useState<bigint | null>(null);
  const [shardCount, setShardCount] = useState<number | null>(null);
  const [shards, setShards] = useState<FeeShard[] | null>(null);

  const useBackend =
    !!config.backendUrl &&
    (backend?.status === "synced" || backend?.status === "syncing");

  // Best-effort fee-pool snapshot. The backend already exposes /fee, so
  // when the indexer is up we surface "pool is at X ADA across N shards"
  // plus a per-shard breakdown so the donor can see impact. Failure is
  // silent; donations work without it.
  const loadSnapshot = useCallback(async (): Promise<void> => {
    if (!useBackend) {
      setPoolLovelace(null);
      setShardCount(null);
      setShards(null);
      return;
    }
    try {
      const client = new BackendClient(config.backendUrl);
      const snap = await client.fee();
      if (!snap) return;
      setPoolLovelace(BigInt(snap.totalLovelace));
      setShardCount(snap.shardCount);
      setShards(snap.shards);
    } catch {
      /* surface nothing; the snapshot is decorative */
    }
  }, [config.backendUrl, useBackend]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadSnapshot();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [loadSnapshot]);

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
  // 5 ADA cushion mirrors the deposit form. Covers tx fee + change min-utxo.
  const requiredLovelace = donationLovelace + 5_000_000n;
  const balanceShort =
    walletLovelace !== null && walletLovelace < requiredLovelace;
  const validAmount = donationLovelace > 0n;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || !validAmount) return;
    setSubmitting(true);
    setRetryAttempt(null);
    try {
      // Best-effort mempool snapshot so we don't pick a shard that's
      // already an input to an in-flight tx. Backend-only feature; on
      // Blockfrost-only deploys this stays null and the retry path
      // absorbs collisions instead.
      let excludeFeeShardRefs: Array<{ txId: string; outputIndex: number }> | undefined;
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
      const result = await buildDonateTx({
        network: config.network as "preprod" | "preview" | "mainnet",
        donationLovelace,
        wallet,
        provider,
        addresses,
        ...(excludeFeeShardRefs ? { excludeFeeShardRefs } : {}),
        retry: {
          maxAttempts: 3,
          delayBetweenAttemptsMs: 2_000,
          onRetry: (info) => setRetryAttempt(info.attempt),
        },
      });
      toast.push({
        tone: "success",
        title: t("toast.donate_success"),
        txHash: result.txId,
        network: config.network,
      });
      // Re-fetch the snapshot so the impact lines update without a full
      // page reload. A small delay lets the indexer pick up the new shard
      // value; the snapshot is decorative, so it's fine if it's stale for
      // a few seconds.
      if (useBackend) {
        window.setTimeout(() => {
          void loadSnapshot();
        }, 12_000);
      }
    } catch (err) {
      const busy = isInputCollisionError(err);
      toast.push({
        tone: "error",
        title: busy ? t("tx.busy_title") : t("toast.donate_failed"),
        ...(busy ? { detail: t("tx.busy_detail") } : { detail: (err as Error).message }),
      });
    } finally {
      setSubmitting(false);
      setRetryAttempt(null);
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
            <span className="lj-stat__sub">
              {t("donate.shard_count", { count: shardCount })}
            </span>
          </div>
        )}
      </header>
      <p className="text-sm text-muted leading-relaxed max-w-prose">
        {t("donate.lede")}
      </p>

      {shards && shards.length > 0 && shards.length <= SHARD_LIST_LIMIT && (
        <div className="mt-6">
          <Eyebrow>{t("donate.shards_title")}</Eyebrow>
          <table className="lj-table mt-3">
            <thead>
              <tr>
                <th>{t("donate.shard_ref")}</th>
                <th className="lj-table__num">{t("donate.shard_balance")}</th>
              </tr>
            </thead>
            <tbody>
              {shards.map((s) => (
                <tr key={`${s.txHash}#${s.outputIndex}`}>
                  <td>
                    <Hash value={`${s.txHash}#${s.outputIndex}`} edge={6} />
                  </td>
                  <td className="lj-table__num">
                    {formatAda(BigInt(s.lovelace))} ₳
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
            {retryAttempt !== null && (
              <p className="mt-3 text-xs text-amber">
                {t("tx.retrying_collision", { attempt: retryAttempt })}
              </p>
            )}
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
