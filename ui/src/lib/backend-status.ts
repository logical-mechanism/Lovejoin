// Cheap reachability + sync probe for the self-hosted backend.
//
// Mirrors lib/collateral-status.ts so screens can render a small status
// indicator without each one re-implementing the polling loop. The probe
// hits `/health` (see backend/src/api/server.ts) and classifies the
// response into four buckets:
//
//   "synced"     — backend reachable, runtime running, lag below threshold.
//   "syncing"    — backend reachable but lagging or runtime not yet up.
//   "down"       — backendUrl set but `/health` returned null (unreachable).
//   "blockfrost" — backendUrl is empty; the UI is using Blockfrost directly.
//
// The hook+context live in components/BackendStatus.tsx; this module is
// the pure probe so it stays trivially testable.

import { BackendClient, type HealthResponse } from "./backend.js";

export type BackendStatus = "synced" | "syncing" | "down" | "blockfrost";

export interface BackendProbeResult {
  status: BackendStatus;
  lagSeconds: number | null;
  health: HealthResponse | null;
  probedAt: number;
}

// Slot ≈ 1s on Cardano preprod/mainnet. ~60s of lag is comfortably inside
// "you're seeing fresh data"; anything beyond gets flagged as syncing so
// the user knows results may be slightly stale.
export const SYNCED_LAG_THRESHOLD_SECONDS = 60;

export async function probeBackend(
  backendUrl: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<BackendProbeResult> {
  const probedAt = Date.now();
  if (!backendUrl) {
    return { status: "blockfrost", lagSeconds: null, health: null, probedAt };
  }
  let health: HealthResponse | null = null;
  try {
    const client = new BackendClient(backendUrl);
    health = await client.health(undefined);
    // BackendClient.getJson swallows fetch errors and non-2xx into null,
    // but pass an explicit fetchFn for tests by going through fetch
    // directly when one is supplied.
    if (fetchFn !== fetch) {
      const url = `${backendUrl.replace(/\/$/, "")}/health`;
      const res = await fetchFn(url, { method: "GET", headers: { Accept: "application/json" } });
      health = res.ok ? ((await res.json()) as HealthResponse) : null;
    }
  } catch {
    health = null;
  }
  if (!health) {
    return { status: "down", lagSeconds: null, health: null, probedAt };
  }
  const lag = health.lagSeconds;
  const synced =
    health.ok &&
    health.runtimeRunning !== false &&
    lag !== null &&
    lag <= SYNCED_LAG_THRESHOLD_SECONDS;
  return {
    status: synced ? "synced" : "syncing",
    lagSeconds: lag,
    health,
    probedAt,
  };
}
