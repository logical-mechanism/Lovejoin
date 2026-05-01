// Backend (self-hosted indexer) status — context + footer badge.
//
// Mirrors CollateralProviderStatus.tsx: one polling loop hoisted to App
// level, every screen reads the latest probe via `useBackendStatus`. The
// goal is a single, low-noise signal in the footer telling the user
// whether they're getting data from our own stack or from Blockfrost.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { probeBackend, type BackendProbeResult } from "../lib/backend-status.js";
import { useAfterFirstPaint } from "../lib/use-after-first-paint.js";

interface BackendStatusValue {
  result: BackendProbeResult | null;
  refresh: () => void;
}

const Ctx = createContext<BackendStatusValue | null>(null);

const POLL_MS = 15_000;

export interface BackendStatusProviderProps {
  backendUrl: string | null;
  children: ReactNode;
  testOverrides?: {
    fetchFn?: typeof fetch;
    pollMs?: number;
    skipPolling?: boolean;
    initial?: BackendProbeResult;
  };
}

export function BackendStatusProvider({
  backendUrl,
  children,
  testOverrides,
}: BackendStatusProviderProps) {
  const [result, setResult] = useState<BackendProbeResult | null>(
    testOverrides?.initial ?? null,
  );
  const fetchFn = testOverrides?.fetchFn ?? fetch;
  const pollMs = testOverrides?.pollMs ?? POLL_MS;
  const skip = testOverrides?.skipPolling === true;
  const cancelledRef = useRef(false);

  const refresh = useMemo(() => {
    return async () => {
      const r = await probeBackend(backendUrl, fetchFn);
      if (!cancelledRef.current) setResult(r);
    };
  }, [backendUrl, fetchFn]);

  // Same first-paint gate the collateral probe uses — keeps the /health
  // request off the LCP-critical connection pool. Once `ready` flips,
  // the probe runs immediately and the 15s polling kicks in.
  const ready = useAfterFirstPaint(skip);
  useEffect(() => {
    cancelledRef.current = false;
    if (skip) return;
    if (!ready) return;
    void refresh();
    const id = window.setInterval(() => {
      void refresh();
    }, pollMs);
    return () => {
      cancelledRef.current = true;
      window.clearInterval(id);
    };
  }, [refresh, pollMs, skip, ready]);

  const value: BackendStatusValue = { result, refresh: () => void refresh() };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBackendStatus(): BackendProbeResult | null {
  return useContext(Ctx)?.result ?? null;
}

/**
 * Compact footer badge — one dot + one short label. Reuses the global
 * lj-dot tokens so it sits cleanly alongside the existing footer chips.
 */
export function ProviderBadge() {
  const { t } = useTranslation();
  const probe = useBackendStatus();
  // Before the first probe lands, render nothing — the footer is fine to
  // show "preprod · do not use real funds" alone for half a second rather
  // than flash an unknown state.
  if (!probe) return null;
  const { status, lagSeconds } = probe;
  const tone =
    status === "synced"
      ? "lj-dot--ok"
      : status === "syncing"
        ? "lj-dot--warn"
        : status === "down"
          ? "lj-dot--bad"
          : "";
  const label =
    status === "synced"
      ? t("provider.badge_synced")
      : status === "syncing"
        ? lagSeconds !== null
          ? t("provider.badge_syncing_lag", { lag: formatLag(lagSeconds) })
          : t("provider.badge_syncing")
        : status === "down"
          ? t("provider.badge_down")
          : t("provider.badge_blockfrost");
  const title =
    status === "synced"
      ? t("provider.tooltip_synced")
      : status === "syncing"
        ? t("provider.tooltip_syncing")
        : status === "down"
          ? t("provider.tooltip_down")
          : t("provider.tooltip_blockfrost");
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={title}
      aria-label={title}
    >
      <span aria-hidden="true" className={`lj-dot ${tone}`.trim()} />
      {label}
    </span>
  );
}

function formatLag(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}
