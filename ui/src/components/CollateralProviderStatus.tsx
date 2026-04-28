// Live collateral-provider status pill + banner.
//
// Spec: docs/spec/06-ui.md §"Privacy UX rules" rule 8 — when the collateral
// provider is unreachable, surface a yellow banner and DISABLE the Mix
// button. There is no fallback to wallet-collateral.
//
// Polls every 30s while mounted (cheap GET). Exposes the latest probe via
// the `useCollateralStatus` hook so the Mix button can grey itself out
// without re-implementing the polling.

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

import {
  probeCollateralProvider,
  type CollateralProbeResult,
  type CollateralStatus,
} from "../lib/collateral-status.js";

interface CollateralStatusValue {
  result: CollateralProbeResult | null;
  refresh: () => void;
}

const Ctx = createContext<CollateralStatusValue | null>(null);

const POLL_MS = 30_000;

export interface CollateralStatusProviderProps {
  endpoint: string | null;
  children: ReactNode;
  /**
   * Inject a fake fetch + a fake `Date.now` for tests so the component
   * doesn't reach out to the network.
   */
  testOverrides?: {
    fetchFn?: typeof fetch;
    pollMs?: number;
    skipPolling?: boolean;
    initial?: CollateralProbeResult;
  };
}

export function CollateralStatusProvider({
  endpoint,
  children,
  testOverrides,
}: CollateralStatusProviderProps) {
  const [result, setResult] = useState<CollateralProbeResult | null>(
    testOverrides?.initial ?? null,
  );
  const fetchFn = testOverrides?.fetchFn ?? fetch;
  const pollMs = testOverrides?.pollMs ?? POLL_MS;
  const skip = testOverrides?.skipPolling === true;
  const cancelledRef = useRef(false);

  const refresh = useMemo(() => {
    return async () => {
      const r = await probeCollateralProvider(endpoint, fetchFn);
      if (!cancelledRef.current) setResult(r);
    };
  }, [endpoint, fetchFn]);

  useEffect(() => {
    cancelledRef.current = false;
    if (skip) return;
    void refresh();
    const id = window.setInterval(() => {
      void refresh();
    }, pollMs);
    return () => {
      cancelledRef.current = true;
      window.clearInterval(id);
    };
  }, [refresh, pollMs, skip]);

  const value: CollateralStatusValue = { result, refresh: () => void refresh() };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCollateralStatus(): CollateralProbeResult | null {
  return useContext(Ctx)?.result ?? null;
}

export function useRefreshCollateralStatus(): () => void {
  return useContext(Ctx)?.refresh ?? (() => {});
}

/**
 * Compact pill — one of three colors. Safe to render anywhere; uses CSS
 * tailwind classes only.
 */
export function CollateralProviderPill({ status }: { status: CollateralStatus }) {
  const { t } = useTranslation();
  if (status === "online") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-green-500" />
        {t("collateral_provider.ok")}
      </span>
    );
  }
  if (status === "down") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-amber-500" />
        {t("collateral_provider.down")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
      <span aria-hidden="true" className="h-2 w-2 rounded-full bg-gray-400" />
      {t("collateral_provider.unknown")}
    </span>
  );
}

/**
 * Full-width banner — rendered above the Mix button whenever the
 * collateral provider is unreachable. Loud enough that the user
 * understands why the Mix button is disabled.
 */
export function CollateralProviderBanner({ status }: { status: CollateralStatus }) {
  const { t } = useTranslation();
  if (status === "online" || status === "unknown") return null;
  return (
    <p
      role="alert"
      className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900"
    >
      {t("collateral_provider.banner_down")}
    </p>
  );
}
