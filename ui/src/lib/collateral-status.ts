// Collateral-provider reachability probe.
//
// Spec: §"Privacy UX rules" rule 8 — when the collateral
// provider is unreachable, surface a yellow banner and DISABLE the Mix
// button. There is no fallback to wallet-collateral; doing so would defeat
// wallet-anonymity.
//
// `probeCollateralProvider` does a cheap GET against the upstream's
// `known_hosts/` discovery endpoint, which lives at the host root rather
// than under the per-network collateral path. We *don't* probe the
// configured collateral endpoint directly because the actual collateral
// signing path only accepts POST; a GET there 405s or 302s, which curl
// handles fine but a browser fetch + redirect can fail with a CORS-redirect
// quirk that production-deploy lovejo.in hit but the Vite dev server
// didn't. `known_hosts/` returns 200 + JSON with `Access-Control-Allow-Origin: *`,
// no redirects, no quirks.

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
  // Probe the upstream's `<host>/known_hosts/` discovery endpoint rather
  // than appending `/health` to the per-network collateral path — that
  // path 302s to / on giveme.my, which curl follows but a browser fetch
  // can stall on under CORS-redirect rules. `known_hosts/` is a stable
  // 200 + JSON contract.
  let target: string;
  try {
    const u = new URL(endpoint);
    target = `${u.origin}/known_hosts/`;
  } catch {
    return {
      status: "down",
      endpoint,
      errorMessage: "endpoint is not a valid URL",
      checkedAtMs,
    };
  }
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
