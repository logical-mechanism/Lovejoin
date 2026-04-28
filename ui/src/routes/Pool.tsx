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
// `useEffect` polls the pool every 30 s. The first fetch sets `loading`
// so users don't stare at a "0 boxes loaded" UI on a slow network. On
// subsequent polls we don't re-show the loading state — the user
// already trusts the screen.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { MixFeePayer } from "@lovejoin/sdk";

import { MixButton } from "../components/MixButton.js";
import { MixWidthSlider } from "../components/MixWidthSlider.js";
import {
  CollateralProviderBanner,
  CollateralProviderPill,
  useCollateralStatus,
} from "../components/CollateralProviderStatus.js";
import { Eyebrow } from "../components/ui/Eyebrow.js";
import { useToast } from "../components/Toaster.js";
import { BackendClient } from "../lib/backend.js";
import { fetchPoolDirect, type DirectPoolEntry } from "../lib/pool.js";
import { useAppState } from "../lib/store.js";
import { friendlyErrorMessage } from "../lib/errors.js";

export function Pool() {
  const { t } = useTranslation();
  const toast = useToast();
  const { config, provider, addresses, wallet } = useAppState();
  const collateral = useCollateralStatus();
  const [poolEntries, setPoolEntries] = useState<DirectPoolEntry[]>([]);
  const [poolError, setPoolError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // The slider's cap is whatever the deployed addresses bundle declares.
  // Falls back to N=2 if the field is absent (older bootstraps); the
  // slider clamps `value` into [2, max], so a cap of 2 just means "no
  // slider" — the user can still mix at N=2.
  const maxN = addresses?.protocol?.max_n ?? 2;
  const [n, setN] = useState<number>(maxN);
  const [feePayer, setFeePayer] = useState<MixFeePayer>("shard");

  // If max_n changes (network swap), re-clamp current width.
  useMemo(() => {
    if (n > maxN) setN(maxN);
  }, [maxN, n]);

  useEffect(() => {
    if (!provider || !addresses) return;
    let cancelled = false;
    let firstRun = true;
    const refresh = async () => {
      if (firstRun) setLoading(true);
      try {
        if (config.backendUrl) {
          const client = new BackendClient(config.backendUrl);
          const page = await client.pool({ limit: 500 });
          if (!page || cancelled) return;
          setPoolEntries(
            page.boxes.map((b) => ({
              ref: { txId: b.txHash.toLowerCase(), outputIndex: b.outputIndex },
              a: hexToBytes(b.a),
              b: hexToBytes(b.b),
            })),
          );
          setPoolError(null);
          return;
        }
        const direct = await fetchPoolDirect({ provider, addresses });
        if (cancelled) return;
        setPoolEntries(direct);
        setPoolError(null);
      } catch (e) {
        if (!cancelled) setPoolError((e as Error).message);
      } finally {
        if (!cancelled && firstRun) {
          setLoading(false);
          firstRun = false;
        }
      }
    };
    void refresh();
    const id = window.setInterval(() => void refresh(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [provider, addresses, config.backendUrl]);

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

      <section className="lj-card">
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
          <MixWidthSlider value={n} maxN={maxN} onChange={setN} />

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Eyebrow>{t("pool.fee_payer_label")}</Eyebrow>
            <div className="lj-toggle" role="group">
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
            <p className="text-xs text-whisper basis-full leading-relaxed">
              {feePayer === "shard"
                ? t("pool.fee_payer_shard_hint")
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
                {t("pool.review_collateral_value")}
              </dd>
            </div>
          </dl>
        </div>

        <div className="mt-8">
          {showLoading && (
            <div className="lj-loading" aria-live="polite">
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
              {!wallet ? (
                <p className="text-sm text-whisper">{t("pool.connect_to_mix")}</p>
              ) : provider && addresses ? (
                <MixButton
                  network={config.network}
                  provider={provider}
                  addresses={addresses}
                  wallet={wallet}
                  poolEntries={poolEntries}
                  n={n}
                  feePayer={feePayer}
                  onSubmitted={(txId) =>
                    toast.push({
                      tone: "success",
                      title: t("toast.mix_success", { n }),
                      txHash: txId,
                      network: config.network,
                    })
                  }
                  onError={(msg) =>
                    toast.push({
                      tone: "error",
                      title: t("toast.mix_failed"),
                      detail: friendlyErrorMessage(msg, t),
                    })
                  }
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
