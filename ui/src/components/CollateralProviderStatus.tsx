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
import { useVisibleRefresh } from "../lib/use-visible-refresh.js";
import { useAfterFirstPaint } from "../lib/use-after-first-paint.js";

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

  // Hold off the first probe until the browser is past LCP. The probe
  // itself is cheap, but during the early bootstrap window the browser
  // is contending for connections with the JS bundle download — moving
  // the request out of that window cuts ~330ms off LCP on PageSpeed.
  const ready = useAfterFirstPaint(skip);

  useVisibleRefresh(
    () => {
      cancelledRef.current = false;
      void refresh();
    },
    { intervalMs: pollMs, enabled: !skip && ready },
  );

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
 * Compact pill — one dot + label. Uses the global lj-* design tokens so
 * it sits cleanly inside the new header / pool stats row.
 */
export function CollateralProviderPill({ status }: { status: CollateralStatus }) {
  const { t } = useTranslation();
  const tone =
    status === "online"
      ? "lj-dot--ok"
      : status === "down"
        ? "lj-dot--bad"
        : "";
  const label =
    status === "online"
      ? t("collateral_provider.ok")
      : status === "down"
        ? t("collateral_provider.down")
        : t("collateral_provider.unknown");
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted">
      <span aria-hidden="true" className={`lj-dot ${tone}`.trim()} />
      {label}
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
    <div role="alert" className="lj-banner lj-banner--amber">
      <span className="lj-banner__title">{t("collateral_provider.banner_down")}</span>
    </div>
  );
}
