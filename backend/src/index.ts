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
import { PostgresDbSyncClient } from "./db/dbsync.js";
import { IndexerRuntime } from "./indexer/runtime.js";
import { IndexerState } from "./indexer/state.js";
import { MempoolPoller } from "./indexer/mempool.js";
import { OgmiosTxClient } from "./indexer/ogmios-tx.js";
import { buildServer } from "./api/server.js";

export const BACKEND_VERSION = "0.2.0";

export type LovejoinBackendConfig = {
  ogmiosUrl: string;
  dbsyncUrl: string | null;
  network: "preprod" | "mainnet" | "preview";
  port: number;
};

export async function main(): Promise<void> {
  const config = loadConfig();
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
  const dbsync = config.dbsyncUrl ? new PostgresDbSyncClient(config.dbsyncUrl) : null;

  // Skip-ahead intersection: a fresh backend starts walking from the
  // bootstrap tx's slot rather than chain origin. Without this, every
  // restart replays the full chain from genesis (≈3 years on preprod)
  // before any protocol-relevant block exists. See config.ts
  // resolveBootstrapStartPoint() for precedence.
  const startPoints = config.bootstrapStartPoint
    ? [
        {
          slot: config.bootstrapStartPoint.slot,
          id: config.bootstrapStartPoint.blockHash,
        } as const,
      ]
    : ["origin" as const];

  const runtime = new IndexerRuntime(state, {
    ogmiosUrl: config.ogmiosUrl,
    filter,
    startPoints,
    logger: simpleLogger(),
  });

  // Tx-submission ogmios client lives on its own WebSocket so chainsync
  // (which is parked on `nextBlock` waiting for the next block) doesn't
  // block tx submit/eval and vice versa. Lazily connects on first use.
  const ogmiosTx = new OgmiosTxClient({
    url: config.ogmiosUrl,
    onOpen: (url) => console.log(`[ogmios-tx] connected at ${url}`),
  });

  // Dedicated socket for the mempool poller. Separate from `ogmiosTx`
  // because acquireMempool pins state on the connection and we don't
  // want it interleaving with submit/eval calls. Same physical ogmios
  // server; two cheap WebSockets is the standard pattern.
  const ogmiosMempool = new OgmiosTxClient({
    url: config.ogmiosUrl,
    onOpen: (url) => console.log(`[ogmios-mempool] connected at ${url}`),
  });
  const mempoolPoller = new MempoolPoller({
    client: ogmiosMempool,
    // Filter mempool refs to ones we actually care about (live mix-boxes
    // + live fee shards). On a busy chain this drops ~99% of mempool
    // traffic and keeps `/mempool/inputs` payloads tiny.
    relevantRefs: () => state.protocolRelevantUtxoKeys(),
    logger: {
      info: (msg) => console.log(`[mempool] ${msg}`),
      warn: (msg) => console.warn(`[mempool] ${msg}`),
    },
  });

  const server = await buildServer({
    state,
    runtime,
    config,
    dbsync,
    ogmiosTx,
    mempoolPoller,
  });

  // Start chainsync first so requests at /health can already see "tip not yet"
  // rather than racing the connection.
  try {
    await runtime.start();
  } catch (err) {
    server.log?.error?.(`ogmios start failed: ${(err as Error).message}`);
  }

  // Mempool poller starts independently. If ogmios is unreachable the
  // poller logs and silently retries on the next interval; the poll
  // failure surfaces in /mempool/inputs as `acquiredAtMs: 0` so clients
  // know to fall back to retry-only behaviour.
  mempoolPoller.start();

  await server.listen({ port: config.port, host: config.host });

  console.log(
    `lovejoin backend ${BACKEND_VERSION} listening on http://${config.host}:${config.port} (network=${config.network})`,
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

function simpleLogger() {
  return {
    info: (msg: string) => console.log(`[indexer] ${msg}`),
    warn: (msg: string) => console.warn(`[indexer] ${msg}`),
    error: (msg: string) => console.error(`[indexer] ${msg}`),
  };
}

// Run only when invoked as the entrypoint (not when imported by tests).
const isEntrypoint =
  typeof process !== "undefined" &&
  typeof import.meta.url === "string" &&
  import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
