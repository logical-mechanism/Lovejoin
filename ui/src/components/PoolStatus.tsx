// Pool / fee / indexer status block — rendered on Home + Pool.
//
// Spec: docs/spec/06-ui.md §"Home" / §"Pool" — "Network status: pool size,
// fee-contract balance, collateral provider status, indexer lag." The
// values come from the M5 backend's REST API; if the backend isn't
// configured we render a placeholder line.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  BackendClient,
  type FeeSnapshot,
  type HealthResponse,
  type PoolPage,
} from "../lib/backend.js";
import { CollateralProviderPill, useCollateralStatus } from "./CollateralProviderStatus.js";

export interface PoolStatusProps {
  backendUrl: string;
  /** Polling interval in ms; tests pass 0 to skip polling. */
  pollMs?: number;
}

export function PoolStatus({ backendUrl, pollMs = 30_000 }: PoolStatusProps) {
  const { t } = useTranslation();
  const [pool, setPool] = useState<PoolPage | null>(null);
  const [fee, setFee] = useState<FeeSnapshot | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const collateral = useCollateralStatus();

  useEffect(() => {
    if (!backendUrl) {
      setPool(null);
      setFee(null);
      setHealth(null);
      return;
    }
    let cancelled = false;
    let client: BackendClient | null = null;
    try {
      client = new BackendClient(backendUrl);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setError(null);
    const tick = async () => {
      if (!client) return;
      const [p, f, h] = await Promise.all([
        client.pool({ limit: 1 }),
        client.fee(),
        client.health(),
      ]);
      if (cancelled) return;
      setPool(p);
      setFee(f);
      setHealth(h);
    };
    void tick();
    if (pollMs <= 0) {
      return () => {
        cancelled = true;
      };
    }
    const id = window.setInterval(() => void tick(), pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [backendUrl, pollMs]);

  if (!backendUrl) {
    return (
      <section className="lj-card lj-card--quiet">
        <header className="lj-card__head">
          <div>
            <p className="lj-eyebrow">{t("pool_status.eyebrow")}</p>
            <h2 className="lj-card__title">{t("pool_status.title")}</h2>
          </div>
          {collateral && <CollateralProviderPill status={collateral.status} />}
        </header>
        <p className="text-sm text-whisper">{t("pool_status.no_backend")}</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="lj-card">
        <header className="lj-card__head">
          <div>
            <p className="lj-eyebrow">{t("pool_status.eyebrow")}</p>
            <h2 className="lj-card__title">{t("pool_status.title")}</h2>
          </div>
        </header>
        <div role="alert" className="lj-banner lj-banner--coral">
          <span className="lj-banner__title">{error}</span>
        </div>
      </section>
    );
  }

  return (
    <section className="lj-card lj-card--quiet">
      <header className="lj-card__head">
        <div>
          <p className="lj-eyebrow">{t("pool_status.eyebrow")}</p>
          <h2 className="lj-card__title">{t("pool_status.title")}</h2>
        </div>
        {collateral && <CollateralProviderPill status={collateral.status} />}
      </header>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4">
        <Stat label={t("pool.size")} value={pool ? String(pool.size) : "—"} />
        <Stat
          label={t("pool_status.fee_balance")}
          value={fee ? formatLovelace(fee.totalLovelace) : "—"}
        />
        <Stat
          label={t("pool.estimated_mixes_available")}
          value={fee ? String(fee.estimatedMixesAvailable) : "—"}
        />
        <Stat
          label={t("pool_status.indexer_lag")}
          value={
            health?.lagSeconds !== null && health?.lagSeconds !== undefined
              ? t("pool_status.lag_seconds_value", { n: health.lagSeconds })
              : "—"
          }
        />
      </dl>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="lj-stat">
      <dt className="lj-stat__label">{label}</dt>
      <dd className="lj-stat__value lj-stat__value--mono" data-num>
        {value}
      </dd>
    </div>
  );
}

function formatLovelace(lovelace: string | bigint): string {
  const n = typeof lovelace === "bigint" ? lovelace : BigInt(lovelace);
  // Render as ADA with 6 decimal places — same convention as cardanoscan.
  const ada = Number(n) / 1_000_000;
  if (!Number.isFinite(ada)) return n.toString();
  return `${ada.toLocaleString(undefined, { maximumFractionDigits: 6 })} ₳`;
}
