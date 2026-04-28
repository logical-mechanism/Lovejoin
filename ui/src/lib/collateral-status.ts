// Collateral-provider reachability probe.
//
// Spec: docs/spec/06-ui.md §"Privacy UX rules" rule 8 — when the collateral
// provider is unreachable, surface a yellow banner and DISABLE the Mix
// button. There is no fallback to wallet-collateral; doing so would defeat
// wallet-anonymity.
//
// `probeCollateralProvider` is a cheap GET against the configured endpoint.
// Most providers expose `/health` (giveme.my does); we treat any 2xx as
// "online". A non-2xx, network error, or missing endpoint all collapse to
// "down" so the UI's banner logic stays a single boolean.

export type CollateralStatus = "online" | "down" | "unknown";

export interface CollateralProbeResult {
  status: CollateralStatus;
  /** ms latency on a successful probe; undefined otherwise. */
  latencyMs?: number;
  /** Last-error message if the probe failed; undefined otherwise. */
  errorMessage?: string;
  /** Endpoint the probe targeted. */
  endpoint: string;
  /** Wall-clock millis of the probe. */
  checkedAtMs: number;
}

export async function probeCollateralProvider(
  endpoint: string | null,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<CollateralProbeResult> {
  const checkedAtMs = Date.now();
  if (!endpoint || !endpoint.trim()) {
    return {
      status: "unknown",
      endpoint: endpoint ?? "",
      errorMessage: "no endpoint configured",
      checkedAtMs,
    };
  }
  const target = endpoint.replace(/\/$/, "") + "/health";
  const start = Date.now();
  try {
    const init: RequestInit = { method: "GET", headers: { Accept: "application/json" } };
    if (signal) init.signal = signal;
    const res = await fetchFn(target, init);
    if (!res.ok) {
      return {
        status: "down",
        endpoint: target,
        errorMessage: `HTTP ${res.status}`,
        checkedAtMs,
      };
    }
    return {
      status: "online",
      endpoint: target,
      latencyMs: Date.now() - start,
      checkedAtMs,
    };
  } catch (e) {
    return {
      status: "down",
      endpoint: target,
      errorMessage: (e as Error).message,
      checkedAtMs,
    };
  }
}
