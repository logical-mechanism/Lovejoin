// Backend API client.
//
// Spec: docs/spec/05-backend.md / docs/spec/06-ui.md §"Pool" — the Pool
// screen reads pool size + fee shard balance + indexer lag from the M5
// backend's REST API. Falls back gracefully when the backend isn't
// configured: the UI still renders, but the pool view shows a "configure
// backend" placeholder rather than spinning forever.
//
// This client deliberately exposes the wire shape from `backend/src/api/server.ts`
// and not a polished domain type — we want UI changes to track backend
// changes without an extra translation layer.

export interface Tip {
  slot: number;
  hash: string;
  blockNo: number;
}

export interface HealthResponse {
  ok: boolean;
  tip: Tip | null;
  chainTip: Tip | null;
  lagSeconds: number | null;
  referenceUtxoOk: boolean;
  runtimeRunning: boolean | null;
  runtimeError: string | null;
}

export interface PoolBox {
  txHash: string;
  outputIndex: number;
  a: string;
  b: string;
  generation?: number;
  createdSlot?: number;
}

export interface PoolPage {
  tip: Tip | null;
  size: number;
  cursor: number | null;
  nextCursor: number | null;
  boxes: PoolBox[];
}

export interface FeeShard {
  txHash: string;
  outputIndex: number;
  lovelace: string;
}

export interface FeeSnapshot {
  totalLovelace: string;
  shardCount: number;
  shards: FeeShard[];
  maxFeePerMix: string;
  estimatedMixesAvailable: number;
}

export class BackendClient {
  constructor(private readonly baseUrl: string) {
    if (!/^https?:\/\//.test(baseUrl)) {
      throw new Error(`BackendClient: baseUrl must include scheme, got ${baseUrl}`);
    }
  }

  /**
   * Cheap reachability probe — used by Home + Pool to decide whether to
   * surface the indexer status block. Returns null if the backend is
   * unreachable (network error or non-2xx) so callers can render a
   * "backend offline" badge without crashing.
   */
  async health(signal?: AbortSignal): Promise<HealthResponse | null> {
    return this.getJson<HealthResponse>("/health", signal);
  }

  async pool(opts: { cursor?: number; limit?: number } = {}, signal?: AbortSignal): Promise<PoolPage | null> {
    const qs = new URLSearchParams();
    if (opts.cursor !== undefined) qs.set("cursor", String(opts.cursor));
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    const path = qs.size > 0 ? `/pool?${qs.toString()}` : "/pool";
    return this.getJson<PoolPage>(path, signal);
  }

  async fee(signal?: AbortSignal): Promise<FeeSnapshot | null> {
    return this.getJson<FeeSnapshot>("/fee", signal);
  }

  private async getJson<T>(path: string, signal?: AbortSignal): Promise<T | null> {
    const url = `${this.baseUrl.replace(/\/$/, "")}${path}`;
    try {
      const init: RequestInit = { method: "GET", headers: { Accept: "application/json" } };
      if (signal) init.signal = signal;
      const res = await fetch(url, init);
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }
}
