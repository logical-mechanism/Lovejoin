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
      <section className="rounded-md border border-gray-200 bg-white p-4 text-sm">
        <h2 className="text-lg font-semibold">{t("pool_status.title")}</h2>
        <p className="mt-2 text-xs text-gray-600">{t("pool_status.no_backend")}</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800">
        <h2 className="text-lg font-semibold">{t("pool_status.title")}</h2>
        <p className="mt-2 text-xs">{error}</p>
      </section>
    );
  }

  return (
    <section className="rounded-md border border-gray-200 bg-white p-4">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("pool_status.title")}</h2>
        {collateral && <CollateralProviderPill status={collateral.status} />}
      </header>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Stat
          label={t("pool.size")}
          value={pool ? String(pool.size) : "—"}
        />
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
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm">{value}</dd>
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
