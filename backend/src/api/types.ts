// Shared types for the REST API plugins. Defined here (rather than in
// server.ts) so route plugins can depend on them without a back-edge
// import on the entrypoint module.

import type { BackendConfig } from "../config.js";
import type { DbSyncClient } from "../db/dbsync.js";
import type { IndexerState } from "../indexer/state.js";
import type { IndexerRuntime } from "../indexer/runtime.js";
import type { OgmiosTxClient } from "../indexer/ogmios-tx.js";
import type { MempoolPoller } from "../indexer/mempool.js";
import type { LovejoinLogger } from "../logger.js";

export interface ApiServerDeps {
  state: IndexerState;
  runtime: IndexerRuntime | null;
  config: BackendConfig;
  /**
   * Primary db-sync client. Drives `/tx/:hash`, `/tx/:hash/utxos`. When
   * null those routes return 503. `/utxos/:address` is served from
   * indexer state and does not require db-sync.
   */
  dbsync: DbSyncClient | null;
  /**
   * Mempool-side ogmios client used by `/submit` and `/evaluate`.
   * Optional — tests omit it; the routes 503 when absent so the wire
   * surface still exists and clients see a meaningful error.
   */
  ogmiosTx?: OgmiosTxClient | null;
  /**
   * Mempool poller backing `/mempool/inputs`. Optional — when absent
   * the route returns an empty snapshot so clients can keep working
   * without mempool-aware picking.
   */
  mempoolPoller?: MempoolPoller | null;
  /**
   * Root logger threaded into Fastify as `loggerInstance`. Routes use
   * `request.log` (which inherits this instance) for per-request
   * structured logging. Optional — when omitted, `buildServer` builds
   * a fresh pino instance from env (`LOG_LEVEL`, `LOG_PRETTY`,
   * `NODE_ENV`, `VITEST`); tests therefore stay silent by default.
   */
  logger?: LovejoinLogger;
  /** When set, used as the "now" for `lagSeconds`; tests pin it. */
  nowMs?: () => number;
}

export interface RouteOptions {
  deps: ApiServerDeps;
}
