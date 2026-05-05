// @lovejoin/backend entrypoint.
//
// Wires:
//   - loadConfig() — env vars + addresses.json
//   - IndexerState  — composite pool / fee / reference state
//   - IndexerRuntime — ogmios chainsync loop driving the state
//   - PostgresDbSyncClient (optional; for /history)
//   - Fastify server on PORT, listening on HOST.
//
// Spec: docs/spec/05-backend.md.

import { loadConfig } from "./config.js";
import { PostgresDbSyncClient, type DbSyncClient } from "./db/dbsync.js";
import { IndexerRuntime } from "./indexer/runtime.js";
import { IndexerState } from "./indexer/state.js";
import { MempoolPoller } from "./indexer/mempool.js";
import { OgmiosTxClient } from "./indexer/ogmios-tx.js";
import { primeFromDbSync } from "./indexer/prime.js";
import type { ChainTip } from "./indexer/types.js";
import { buildServer } from "./api/server.js";
import { buildLogger } from "./logger.js";

export const BACKEND_VERSION = "0.2.0";

export type LovejoinBackendConfig = {
  ogmiosUrl: string;
  dbsyncUrl: string | null;
  network: "preprod" | "mainnet" | "preview";
  port: number;
};

export async function main(): Promise<void> {
  const config = loadConfig();
  // Root pino logger for the whole process. Threaded into Fastify and
  // every long-running subsystem (indexer runtime, mempool poller,
  // ogmios-tx clients, db-sync client) so logs share a single shape
  // and `module:` field; no more `[prefix]` strings or bare console.*.
  const rootLogger = buildLogger({ name: `lovejoin-backend@${BACKEND_VERSION}` });
  const filter = {
    mixBoxAddress: config.derived.mixBoxAddress,
    feeContractAddress: config.derived.feeContractAddress,
    referenceNftUnit: `${config.addresses.referenceNftPolicy}${config.addresses.referenceNftAssetName}`,
  };
  const state = new IndexerState(
    config.addresses,
    filter,
    BigInt(config.addresses.protocol.max_fee_per_mix_lovelace),
  );
  // INDEXER_PRIME_TIMEOUT_MS overrides the prime-only statement
  // timeout. Defaults to 60 s in PostgresDbSyncClient; set higher
  // (or to 0 = disabled) for very busy mainnet pools running on the
  // legacy NOT EXISTS path. The public-API queries keep the pool's
  // 10 s cap regardless.
  const primeTimeoutRaw = process.env.INDEXER_PRIME_TIMEOUT_MS?.trim();
  const primeStatementTimeoutMs =
    primeTimeoutRaw && /^\d+$/.test(primeTimeoutRaw) ? Number(primeTimeoutRaw) : undefined;
  const dbsync = config.dbsyncUrl
    ? new PostgresDbSyncClient(config.dbsyncUrl, {
        ...(primeStatementTimeoutMs !== undefined ? { primeStatementTimeoutMs } : {}),
        logger: rootLogger.child({ module: "dbsync" }),
      })
    : null;

  const indexerLogger = rootLogger.child({ module: "indexer" });
  const primeParams = {
    mixBoxAddress: config.derived.mixBoxAddress,
    feeContractAddress: config.derived.feeContractAddress,
    referenceNftPolicyHex: config.addresses.referenceNftPolicy,
    referenceNftAssetNameHex: config.addresses.referenceNftAssetName,
  };
  // Cold-start prime path (issue #87): when db-sync is configured
  // and INDEXER_COLD_START allows it, bulk-load live state from
  // db-sync at its latest stable block, then resume chainsync from
  // that point. This collapses cold-start latency from O(chain
  // length) to O(pool size). The legacy `bootstrapStartPoint`
  // replay remains as the fallback when db-sync isn't available
  // (or when an operator pins INDEXER_COLD_START=replay for
  // debugging).
  const coldStartMode = (process.env.INDEXER_COLD_START ?? "prime").toLowerCase();
  let primedTip: ChainTip | null = null;
  if (coldStartMode === "prime" && dbsync) {
    try {
      primedTip = await primeFromDbSync({
        state,
        dbsync,
        params: primeParams,
        logger: indexerLogger,
      });
    } catch (err) {
      indexerLogger.warn({ err }, "prime: db-sync prime failed; falling back to chainsync replay");
    }
  } else if (coldStartMode === "prime" && !dbsync) {
    indexerLogger.warn(
      { reason: "DBSYNC_URL not configured" },
      "prime: INDEXER_COLD_START=prime requested but disabled; falling back to chainsync replay",
    );
  }

  // Resume points: primed tip first, then the bootstrap intersection,
  // then origin as the legacy walk-from-genesis path. Most production
  // deploys take the primed branch; the bootstrap branch is the
  // legacy fallback for environments without db-sync.
  const startPoints = primedTip
    ? [{ slot: primedTip.slot, id: primedTip.blockHash } as const]
    : config.bootstrapStartPoint
      ? [
          {
            slot: config.bootstrapStartPoint.slot,
            id: config.bootstrapStartPoint.blockHash,
          } as const,
        ]
      : ["origin" as const];

  // Reprime callback for in-process recovery from `DeepRollbackError`
  // and from `intersection: "origin"` reconnects past our applied
  // tip. Identical to the cold-start prime; supplied only when
  // db-sync is configured because the runtime must have somewhere to
  // pull the snapshot from.
  const reprime: (() => Promise<ChainTip>) | undefined = dbsync
    ? () =>
        primeFromDbSync({
          state,
          dbsync: dbsync satisfies DbSyncClient,
          params: primeParams,
          logger: indexerLogger,
        })
    : undefined;

  const runtime = new IndexerRuntime(state, {
    ogmiosUrl: config.ogmiosUrl,
    filter,
    startPoints,
    logger: indexerLogger,
    ...(reprime ? { reprime } : {}),
  });
  if (primedTip) {
    runtime.notePrimed();
  }

  // Tx-submission ogmios client lives on its own WebSocket so chainsync
  // (which is parked on `nextBlock` waiting for the next block) doesn't
  // block tx submit/eval and vice versa. Lazily connects on first use.
  const ogmiosTxLogger = rootLogger.child({ module: "ogmios-tx" });
  const ogmiosTx = new OgmiosTxClient({
    url: config.ogmiosUrl,
    onOpen: (url) => ogmiosTxLogger.info({ url }, "connected"),
  });

  // Dedicated socket for the mempool poller. Separate from `ogmiosTx`
  // because acquireMempool pins state on the connection and we don't
  // want it interleaving with submit/eval calls. Same physical ogmios
  // server; two cheap WebSockets is the standard pattern.
  const ogmiosMempoolLogger = rootLogger.child({ module: "ogmios-mempool" });
  const ogmiosMempool = new OgmiosTxClient({
    url: config.ogmiosUrl,
    onOpen: (url) => ogmiosMempoolLogger.info({ url }, "connected"),
  });
  const mempoolPoller = new MempoolPoller({
    client: ogmiosMempool,
    // Filter mempool refs to ones we actually care about (live mix-boxes
    // + live fee shards). On a busy chain this drops ~99% of mempool
    // traffic and keeps `/mempool/inputs` payloads tiny.
    relevantRefs: () => state.protocolRelevantUtxoKeys(),
    logger: rootLogger.child({ module: "mempool" }),
  });

  const server = await buildServer({
    state,
    runtime,
    config,
    dbsync,
    ogmiosTx,
    mempoolPoller,
    logger: rootLogger,
  });

  // Start chainsync first so requests at /health can already see "tip not yet"
  // rather than racing the connection.
  try {
    await runtime.start();
  } catch (err) {
    server.log.error({ err }, "ogmios start failed");
  }

  // Mempool poller starts independently. If ogmios is unreachable the
  // poller logs and silently retries on the next interval; the poll
  // failure surfaces in /mempool/inputs as `acquiredAtMs: 0` so clients
  // know to fall back to retry-only behaviour.
  mempoolPoller.start();

  await server.listen({ port: config.port, host: config.host });

  rootLogger.info(
    {
      version: BACKEND_VERSION,
      host: config.host,
      port: config.port,
      network: config.network,
    },
    "lovejoin backend listening",
  );

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      void shutdown(server, runtime, dbsync, ogmiosTx, ogmiosMempool, mempoolPoller);
    });
  }
}

async function shutdown(
  server: Awaited<ReturnType<typeof buildServer>>,
  runtime: IndexerRuntime,
  dbsync: PostgresDbSyncClient | null,
  ogmiosTx: OgmiosTxClient | null,
  ogmiosMempool: OgmiosTxClient | null,
  mempoolPoller: MempoolPoller | null,
): Promise<void> {
  try {
    await runtime.stop();
  } catch {
    /* ignore */
  }
  try {
    await mempoolPoller?.stop();
  } catch {
    /* ignore */
  }
  try {
    ogmiosTx?.close();
  } catch {
    /* ignore */
  }
  try {
    ogmiosMempool?.close();
  } catch {
    /* ignore */
  }
  try {
    await server.close();
  } catch {
    /* ignore */
  }
  if (dbsync) {
    try {
      await dbsync.close();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}

// Run only when invoked as the entrypoint (not when imported by tests).
const isEntrypoint =
  typeof process !== "undefined" &&
  typeof import.meta.url === "string" &&
  import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  // No `rootLogger` is reachable here — main() builds its own. Log the
  // bootstrap failure with a fresh pino instance so the structured
  // shape is preserved even on cold-fail.
  main().catch((err) => {
    buildLogger({ name: "lovejoin-backend@bootstrap" }).fatal({ err }, "backend failed to start");
    process.exit(1);
  });
}
