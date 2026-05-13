// Pool — the user-as-mixer surface.
//
// One unified Mix panel. The intensity dial picks single-tx (k=1) vs
// fan-out (k≥2); the same CTA fires both. Previously this route
// stacked a single-tx card and a separate fan-out card; consolidating
// them into one panel removes the "extra options at the bottom that
// may be missed" failure mode flagged in issue #137.
//
// Layout (top → bottom):
//   • Optional collateral-down banner (sticks above the section card).
//   • Section header (eyebrow + title + collateral pill).
//   • Lede paragraph.
//   • <MixPanel/> — intensity dial, fee-payer toggle (k=1 only),
//     review block, disclosure (k≥2 only), single CTA, progress.
//   • Empty / loading / error branches replace MixPanel when the pool
//     can't be shown.
//
// `useVisibleRefresh` drives the pool refresh: fires on mount (with the
// loading skeleton), every 30 s while the tab is visible, and again the
// moment the user tabs back from a stale background.
//
// Honors `?intensity=N` to pre-select the dial — used by the Vault's
// "Run a fan-out" CTA. `?advanced=1` unlocks depth-4 fan-out.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { isInputCollisionError } from "@lovejoin/sdk";

import { MixPanel } from "../components/MixPanel.js";
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
import { fetchPoolDirect, type DirectPoolEntry } from "../lib/pool.js";
import { useAppState } from "../lib/store.js";
import { friendlyErrorMessage } from "../lib/errors.js";
import { mixPhases } from "../lib/tx-phases.js";
import { useVisibleRefresh } from "../lib/use-visible-refresh.js";

export function Pool() {
  const { t } = useTranslation();
  const toast = useToast();
  const { config, provider, addresses, wallet } = useAppState();
  // `?advanced=1` unlocks depth-4 fan-out — power-user override that
  // skips the empirically-validated cap. See CLAUDE.md.
  const advanced = typeof window !== "undefined" && window.location.search.includes("advanced=1");
  const [searchParams] = useSearchParams();
  const initialIntensity = useMemo(() => {
    const raw = searchParams.get("intensity");
    if (raw === null) return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 1 && parsed <= 4 ? parsed : undefined;
  }, [searchParams]);
  const collateral = useCollateralStatus();
  const backend = useBackendStatus();
  const [poolEntries, setPoolEntries] = useState<DirectPoolEntry[]>([]);
  const [poolError, setPoolError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Bubbled up from <MixPanel> so we can darken the whole card while
  // build+sign+submit is in flight (5–10 s). The button alone is too
  // small a feedback target for that wait.
  const [mixSubmitting, setMixSubmitting] = useState(false);

  const protocol = addresses?.protocol;
  const legacyMaxN = protocol?.max_n ?? 2;
  const maxNShard = protocol?.max_n_shard ?? legacyMaxN;

  const backendStatus = backend?.status ?? null;

  const { refresh: refreshPool } = useVisibleRefresh(
    async (trigger) => {
      if (!provider || !addresses) return;
      if (trigger === "mount") setLoading(true);
      try {
        let entries: DirectPoolEntry[] | null = null;
        const useBackend =
          !!config.backendUrl && (backendStatus === "synced" || backendStatus === "syncing");
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
  const showError = !!poolError;
  const showLoading = loading && !poolError;
  const showEmpty = !loading && !poolError && poolEntries.length === 0;
  const showReady = !loading && !poolError && poolEntries.length > 0;

  return (
    <section
      className={`lj-card lj-overlay ${mixSubmitting ? "lj-overlay--busy" : ""}`}
      aria-busy={mixSubmitting}
    >
      {collateral?.status === "down" && <CollateralProviderBanner status={collateral.status} />}

      <header className="lj-card__head">
        <div>
          <Eyebrow>{t("pool.eyebrow")}</Eyebrow>
          <h2 className="lj-card__title">{t("pool.section_title")}</h2>
        </div>
        {collateral && <CollateralProviderPill status={collateral.status} />}
      </header>
      <p className="text-sm text-muted leading-relaxed max-w-prose">{t("pool.lede")}</p>

      {showError && (
        <div className="mt-8 lj-banner lj-banner--coral" role="alert">
          <span className="lj-banner__title">{t("pool.scan_failed_title")}</span>
          <span className="lj-banner__detail">{friendlyErrorMessage(poolError, t)}</span>
        </div>
      )}

      {showEmpty && (
        <div className="mt-8 lj-empty">
          <p className="lj-empty__title">{t("pool.empty_title")}</p>
          <p>{t("pool.empty_hint")}</p>
          <div className="mt-5">
            <Link to="/deposit" className="lj-btn lj-btn--primary lj-btn--lg">
              {t("pool.empty_cta")}
            </Link>
          </div>
        </div>
      )}

      {/* MixPanel renders during loading too. The intensity dial, fee-payer
       *  toggle, and review block are useful for orientation even before
       *  data lands; the hooks gracefully report disabled when provider /
       *  addresses are null, and the CTA reflects that. Only error +
       *  empty states replace the panel. */}
      {!showError && !showEmpty && (
        <>
          <MixPanel
            network={config.network}
            provider={provider}
            addresses={addresses}
            wallet={wallet}
            poolEntries={poolEntries}
            advanced={advanced}
            onSubmittingChange={setMixSubmitting}
            {...(initialIntensity !== undefined ? { initialIntensity } : {})}
            onSingleMixSubmitted={(txId) =>
              toast.push({
                tone: "success",
                title: t("toast.mix_success", { n: maxNShard }),
                txHash: txId,
                network: config.network,
              })
            }
            onSingleMixError={(msg) => {
              const busy = isInputCollisionError(msg);
              toast.push({
                tone: "error",
                title: busy ? t("tx.busy_title") : t("toast.mix_failed"),
                detail: busy ? t("tx.busy_detail") : friendlyErrorMessage(msg, t),
              });
            }}
          />
          {showLoading && (
            <p className="mt-6 text-xs text-whisper" role="status" aria-live="polite">
              {t("pool.scanning")}
            </p>
          )}
          {showReady && (
            <p className="mt-6 text-xs text-whisper">
              {t("pool.pool_loaded", { count: poolEntries.length })}
            </p>
          )}
        </>
      )}

      <div className="lj-overlay__indicator">
        <TxBuildProgress
          active={mixSubmitting}
          phases={mixPhases(t, maxNShard)}
          ariaLabel={t("pool.mix_submitting")}
        />
      </div>
    </section>
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
