// Blockfrost-backed implementation of the `addressHistory` half of
// `DbSyncClient`. Used as a fallback for `/history/:address` while the
// self-hosted db-sync is unavailable (initial sync, planned outage, brief
// connectivity blip). When db-sync is back, the route prefers it again
// because a single SQL query is much cheaper than the N+1 Blockfrost
// calls this client makes.
//
// Cost shape: 1 call to `/addresses/{addr}/transactions` plus 1 call to
// `/txs/{tx_hash}/utxos` per returned tx (to sum lovelace paid to the
// address — Blockfrost's address-tx index doesn't carry that in the
// per-tx row). With limit ≤ 50 that's at most 51 HTTP calls per
// `/history/:address`. Acceptable while db-sync is the long-term home;
// if this path becomes hot we can cache or batch.
//
// `ping`/`close` are token implementations so this slots into the same
// `DbSyncClient` interface the route already consumes.

import type { AddressTxHistoryEntry, HistoryClient } from "./dbsync.js";

/** Subset of `fetch` we depend on. Lets tests inject a mock cleanly. */
export type FetchFn = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface BlockfrostHistoryConfig {
  /** Base URL — e.g. `https://cardano-preprod.blockfrost.io/api/v0`. */
  baseUrl: string;
  /** Blockfrost project id. */
  projectId: string;
  /** Inject a mock in tests; defaults to `globalThis.fetch`. */
  fetchFn?: FetchFn;
}

interface AddressTxRow {
  tx_hash: string;
  tx_index: number;
  block_height: number;
  /** Unix epoch seconds — Blockfrost's wire shape. */
  block_time: number;
}

interface TxUtxosResponse {
  outputs: Array<{
    address: string;
    amount: Array<{ unit: string; quantity: string }>;
  }>;
}

export class BlockfrostHistoryClient implements HistoryClient {
  private readonly baseUrl: string;
  private readonly projectId: string;
  private readonly fetchFn: FetchFn;

  constructor(config: BlockfrostHistoryConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.projectId = config.projectId;
    const injected = config.fetchFn;
    const globalFetch = (globalThis as { fetch?: FetchFn }).fetch;
    if (!injected && !globalFetch) {
      throw new Error(
        "BlockfrostHistoryClient: no fetch implementation available. Pass `fetchFn` explicitly.",
      );
    }
    this.fetchFn = injected ?? (globalFetch!.bind(globalThis) as FetchFn);
  }

  async addressHistory(address: string, limit: number): Promise<AddressTxHistoryEntry[]> {
    if (!Number.isFinite(limit) || limit <= 0 || limit > 500) {
      throw new Error(`addressHistory: limit must be 1..500, got ${limit}`);
    }
    const txs = (await this.get(`/addresses/${address}/transactions?count=${limit}&order=desc`)) as
      | AddressTxRow[]
      | null;
    if (!Array.isArray(txs)) return [];

    const out: AddressTxHistoryEntry[] = [];
    for (const tx of txs) {
      const utxos = (await this.get(`/txs/${tx.tx_hash}/utxos`)) as TxUtxosResponse | null;
      let lovelace = 0n;
      if (utxos && Array.isArray(utxos.outputs)) {
        for (const o of utxos.outputs) {
          if (o.address !== address) continue;
          for (const amt of o.amount) {
            if (amt.unit === "lovelace") lovelace += BigInt(amt.quantity);
          }
        }
      }
      out.push({
        txHash: tx.tx_hash,
        blockHeight: tx.block_height,
        blockTime: new Date(tx.block_time * 1000).toISOString(),
        lovelaceReceived: lovelace,
      });
    }
    return out;
  }

  async ping(): Promise<void> {
    // `/health` is the canonical Blockfrost smoke endpoint; it's an
    // unauthenticated 200/JSON if the API is up.
    const res = await this.fetchFn(`${this.baseUrl}/health`, {
      headers: { project_id: this.projectId },
    });
    if (!res.ok) {
      // Drain + log the body server-side; do not include it in the
      // thrown error. Blockfrost upstream bodies have been observed
      // echoing the project id in 4xx responses, and that error then
      // bubbles into the `/history` fallback path on the API surface
      // (security review v1, finding M3).
      const body = await res.text();
      console.error(`[blockfrost] /health ${res.status}: ${body.slice(0, 200)}`);
      throw new Error(`Blockfrost /health ${res.status}`);
    }
  }

  async close(): Promise<void> {
    /* nothing to release — fetch is stateless */
  }

  private async get(path: string): Promise<unknown> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      headers: { project_id: this.projectId },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text();
      console.error(
        `[blockfrost] GET ${path} (${res.status} ${res.statusText}): ${body.slice(0, 200)}`,
      );
      throw new Error(`Blockfrost GET ${path} (${res.status} ${res.statusText})`);
    }
    return await res.json();
  }
}

/**
 * Default Blockfrost base URL for a given Lovejoin network. Callers can
 * still pass an explicit `BLOCKFROST_BASE_URL` to override (e.g. for a
 * self-hosted Blockfrost mirror).
 */
export function defaultBlockfrostBaseUrl(network: "preprod" | "preview" | "mainnet"): string {
  switch (network) {
    case "preprod":
      return "https://cardano-preprod.blockfrost.io/api/v0";
    case "preview":
      return "https://cardano-preview.blockfrost.io/api/v0";
    case "mainnet":
      return "https://cardano-mainnet.blockfrost.io/api/v0";
  }
}
