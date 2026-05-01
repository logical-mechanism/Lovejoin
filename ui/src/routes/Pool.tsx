// Pool — the user-as-mixer surface.
//
// Spec: docs/spec/06-ui.md §"Pool" + M6.5 design pass + M6.5+ punch-list
// (H2 loading, H6 empty onboarding, H7 concrete linkage review, M2
// coral on errors, L1 friendly error copy).
//
// Layout (top → bottom):
//   • Optional collateral-down banner (sticks above the section card).
//   • Section header (eyebrow + title + collateral pill).
//   • Lede paragraph.
//   • Mix-width slider (clamps to runtime max_n surfaced via addresses.json).
//   • Fee-payer toggle (shard | wallet) with one-line tradeoff per option.
//   • Tx review block — concrete N, linkage formula, pool size, fee path.
//   • Action area — depends on (loading | empty | error | ready):
//       loading: pulsing "Scanning pool…"
//       empty:   onboarding empty state with "Make a deposit" CTA
//       error:   coral banner with friendly retry copy
//       ready:   the MixButton CTA
//
// `useVisibleRefresh` drives the pool refresh: fires on mount (with the
// loading skeleton), every 30 s while the tab is visible, and again the
// moment the user tabs back from a stale background. The mount fetch
// sets `loading` so users don't stare at a "0 boxes loaded" UI on a
// slow first paint; subsequent triggers leave the existing data in
// place and silently update.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { isInputCollisionError, type MixFeePayer } from "@lovejoin/sdk";

import { MixButton } from "../components/MixButton.js";
import { useBackendStatus } from "../components/BackendStatus.js";
import {
  CollateralProviderBanner,
  CollateralProviderPill,
  useCollateralStatus,
} from "../components/CollateralProviderStatus.js";
import { Eyebrow } from "../components/ui/Eyebrow.js";
import { useToast } from "../components/Toaster.js";
import { TxBuildProgress } from "../components/TxBuildProgress.js";
import { BackendClient } from "../lib/backend.js";
import { formatAda } from "../lib/format.js";
import { fetchPoolDirect, type DirectPoolEntry } from "../lib/pool.js";
import { useAppState } from "../lib/store.js";
import { friendlyErrorMessage } from "../lib/errors.js";
import { mixPhases } from "../lib/tx-phases.js";
import { useVisibleRefresh } from "../lib/use-visible-refresh.js";

export function Pool() {
  const { t } = useTranslation();
  const toast = useToast();
  const { config, provider, addresses, wallet } = useAppState();
  const collateral = useCollateralStatus();
  const backend = useBackendStatus();
  const [poolEntries, setPoolEntries] = useState<DirectPoolEntry[]>([]);
  const [poolError, setPoolError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Bubbled up from <MixButton> so we can darken the whole card while
  // build+sign+submit is in flight (5–10 s). The button alone is too
  // small a feedback target for that wait.
  const [mixSubmitting, setMixSubmitting] = useState(false);

  // N is fixed by the selected fee mode — no half-width mixes. Shard mode
  // adds a fee_contract.spend invocation (~187M CPU at Conway prices) which
  // pushes N=4 over the 10G CPU cap; wallet mode skips fee_contract and
  // fits N=4 with headroom. Both caps are stamped into addresses.json by
  // `make sync-ui-addresses` from `config/network.<net>.json`. Legacy
  // `max_n` is read as a fallback for older bootstraps.
  const protocol = addresses?.protocol;
  const legacyMaxN = protocol?.max_n ?? 2;
  const maxNShard = protocol?.max_n_shard ?? legacyMaxN;
  const maxNWallet = protocol?.max_n_wallet ?? legacyMaxN;
  const maxFeePerMixAda = protocol?.max_fee_per_mix_lovelace
    ? formatAda(BigInt(protocol.max_fee_per_mix_lovelace))
    : "?";
  // Persist the fee-payer toggle across reloads so power users who
  // prefer wallet-mode don't have to re-flip it every session. Lazy
  // init avoids hydration churn; the key is namespaced under
  // `lovejoin.pool.*` so future Pool prefs slot in alongside it.
  const [feePayer, setFeePayer] = useState<MixFeePayer>(() => {
    try {
      const stored = window.localStorage.getItem("lovejoin.pool.feePayer");
      if (stored === "shard" || stored === "wallet") return stored;
    } catch {
      /* localStorage unavailable (private mode etc.) — fall back to default. */
    }
    return "shard";
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("lovejoin.pool.feePayer", feePayer);
    } catch {
      /* same; persistence is nice-to-have, not load-bearing. */
    }
  }, [feePayer]);
  const n = feePayer === "shard" ? maxNShard : maxNWallet;

  // The badge probe lives in App-level context; pull the status into a
  // primitive so the pool refresh effect re-fires when it flips and
  // doesn't spuriously re-fire on every probe tick.
  const backendStatus = backend?.status ?? null;

  const { refresh: refreshPool } = useVisibleRefresh(
    async (trigger) => {
      if (!provider || !addresses) return;
      // Only the first paint shows the big "Scanning…" line. Visibility,
      // interval, and manual triggers refresh in place — the user is
      // already looking at populated data and a sudden skeleton would
      // feel like a regression.
      if (trigger === "mount") setLoading(true);
      try {
        // Provider preference: when the self-hosted backend is reachable
        // AND its indexer is caught up to chain tip, treat it as
        // authoritative — even an empty result is a real "no boxes".
        // Fall back to Blockfrost only when the backend is unreachable,
        // still syncing, or unconfigured. We're leaning on our own
        // stack; Blockfrost is the safety net, not the default.
        let entries: DirectPoolEntry[] | null = null;
        const useBackend =
          !!config.backendUrl &&
          (backendStatus === "synced" || backendStatus === "syncing");
        if (useBackend) {
          try {
            const client = new BackendClient(config.backendUrl);
            const page = await client.pool({ limit: 500 });
            if (page) {
              const fromBackend = page.boxes.map((b) => ({
                ref: { txId: b.txHash.toLowerCase(), outputIndex: b.outputIndex },
                a: hexToBytes(b.a),
                b: hexToBytes(b.b),
              }));
              // Trust an empty-but-synced backend; otherwise (syncing
              // and empty), keep `entries` null so we fall through.
              if (backendStatus === "synced" || fromBackend.length > 0) {
                entries = fromBackend;
              }
            }
          } catch {
            // Backend threw — let Blockfrost cover.
          }
        }
        if (!entries) {
          entries = await fetchPoolDirect({ provider, addresses });
        }
        setPoolEntries(entries);
        setPoolError(null);
      } catch (e) {
        setPoolError((e as Error).message);
      } finally {
        if (trigger === "mount") setLoading(false);
      }
    },
    { intervalMs: 30_000, enabled: !!provider && !!addresses },
  );

  // When the backend health flips (e.g. syncing → synced) we want to
  // re-read the pool immediately rather than wait up to 30 s for the
  // next interval tick. Skip the very first run so we don't fire a
  // duplicate fetch on top of the hook's mount call.
  const lastBackendStatus = useRef(backendStatus);
  useEffect(() => {
    if (lastBackendStatus.current === backendStatus) return;
    lastBackendStatus.current = backendStatus;
    refreshPool();
  }, [backendStatus, refreshPool]);

  // Status branches for the action area. Render priority:
  //   error > loading > empty > ready
  // (a stale-error visible during a refresh tick is more honest than a
  // mid-refresh skeleton that ignores the previous failure).
  const showError = !!poolError;
  const showLoading = loading && !poolError;
  const showEmpty = !loading && !poolError && poolEntries.length === 0;
  const showReady = !loading && !poolError && poolEntries.length > 0;

  return (
    <>
      {collateral?.status === "down" && (
        <CollateralProviderBanner status={collateral.status} />
      )}

      <section
        className={`lj-card lj-overlay ${mixSubmitting ? "lj-overlay--busy" : ""}`}
        aria-busy={mixSubmitting}
      >
        <header className="lj-card__head">
          <div>
            <Eyebrow>{t("pool.eyebrow")}</Eyebrow>
            <h2 className="lj-card__title">{t("pool.section_title")}</h2>
          </div>
          {collateral && <CollateralProviderPill status={collateral.status} />}
        </header>
        <p className="text-sm text-muted leading-relaxed max-w-prose">
          {t("pool.lede")}
        </p>

        <div className="mt-6 flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Eyebrow id="fee-payer-label">{t("pool.fee_payer_label")}</Eyebrow>
            <div
              className="lj-toggle"
              role="group"
              aria-labelledby="fee-payer-label"
              aria-describedby="fee-payer-hint"
            >
              <button
                type="button"
                aria-pressed={feePayer === "shard"}
                onClick={() => setFeePayer("shard")}
              >
                {t("pool.fee_payer_shard")}
              </button>
              <button
                type="button"
                aria-pressed={feePayer === "wallet"}
                onClick={() => setFeePayer("wallet")}
              >
                {t("pool.fee_payer_wallet")}
              </button>
            </div>
            <p
              id="fee-payer-hint"
              className="text-xs text-whisper basis-full leading-relaxed"
            >
              {feePayer === "shard"
                ? t("pool.fee_payer_shard_hint", { cap: maxFeePerMixAda })
                : t("pool.fee_payer_wallet_hint")}
            </p>
          </div>
        </div>

        <div
          className="lj-review mt-8"
          role="group"
          aria-label={t("pool.review_title")}
        >
          <span className="lj-eyebrow">{t("pool.review_title")}</span>
          <dl className="lj-review__rows">
            <div className="lj-review__row">
              <dt className="lj-review__label">{t("pool.review_width")}</dt>
              <dd className="lj-review__value lj-review__value--num" data-num>
                {n}
              </dd>
            </div>
            <div className="lj-review__row">
              <dt className="lj-review__label">{t("pool.review_linkage")}</dt>
              <dd className="lj-review__value">
                {t("pool.review_linkage_value", { n })}
              </dd>
            </div>
            <div className="lj-review__row">
              <dt className="lj-review__label">{t("pool.review_selection")}</dt>
              <dd className="lj-review__value">
                {showLoading
                  ? t("pool.review_selection_loading")
                  : t("pool.review_selection_value", {
                      n,
                      pool: poolEntries.length,
                    })}
              </dd>
            </div>
            <div className="lj-review__row">
              <dt className="lj-review__label">{t("pool.review_fee_path")}</dt>
              <dd className="lj-review__value">
                {feePayer === "shard"
                  ? t("pool.review_fee_path_shard")
                  : t("pool.review_fee_path_wallet")}
              </dd>
            </div>
            <div className="lj-review__row">
              <dt className="lj-review__label">{t("pool.review_collateral")}</dt>
              <dd className="lj-review__value lj-review__value--muted">
                {feePayer === "shard"
                  ? t("pool.review_collateral_value_shard")
                  : t("pool.review_collateral_value_wallet")}
              </dd>
            </div>
          </dl>
        </div>

        <div className="mt-8">
          {showLoading && (
            <div className="lj-loading" role="status" aria-live="polite">
              {t("pool.scanning")}
            </div>
          )}

          {showEmpty && (
            <div className="lj-empty">
              <p className="lj-empty__title">{t("pool.empty_title")}</p>
              <p>{t("pool.empty_hint")}</p>
              <div className="mt-5 flex justify-center">
                <Link to="/deposit" className="lj-btn lj-btn--primary lj-btn--lg">
                  {t("pool.empty_cta")}
                </Link>
              </div>
            </div>
          )}

          {showReady && (
            <div className="flex flex-wrap items-end gap-6">
              {provider && addresses ? (
                // Shard-mode submission is wallet-anonymous: no wallet
                // input, no signature, collateral signed by giveme.my.
                // The button is reachable even with no wallet connected
                // — anyone can contribute mix txs to the public pool,
                // which improves linkage probability for everyone.
                // Wallet-mode still requires a wallet; MixButton's own
                // disabled calc handles that case with an inline hint.
                <MixButton
                  network={config.network}
                  provider={provider}
                  addresses={addresses}
                  wallet={wallet}
                  poolEntries={poolEntries}
                  n={n}
                  feePayer={feePayer}
                  onSubmittingChange={setMixSubmitting}
                  onSubmitted={(txId) =>
                    toast.push({
                      tone: "success",
                      title: t("toast.mix_success", { n }),
                      txHash: txId,
                      network: config.network,
                    })
                  }
                  onError={(msg) => {
                    const busy = isInputCollisionError(msg);
                    toast.push({
                      tone: "error",
                      title: busy ? t("tx.busy_title") : t("toast.mix_failed"),
                      detail: busy ? t("tx.busy_detail") : friendlyErrorMessage(msg, t),
                    });
                  }}
                />
              ) : null}
              <span className="text-xs text-whisper">
                {t("pool.pool_loaded", { count: poolEntries.length })}
              </span>
            </div>
          )}

          {showError && (
            <div className="lj-banner lj-banner--coral" role="alert">
              <span className="lj-banner__title">
                {t("pool.scan_failed_title")}
              </span>
              <span className="lj-banner__detail">
                {friendlyErrorMessage(poolError, t)}
              </span>
            </div>
          )}
        </div>

        <div className="lj-overlay__indicator">
          <TxBuildProgress
            active={mixSubmitting}
            phases={mixPhases(t, n)}
            ariaLabel={t("pool.mix_submitting")}
          />
        </div>
      </section>
    </>
  );
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/^0x/i, "");
  if (cleaned.length % 2 !== 0) throw new Error("hex must have even length");
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
