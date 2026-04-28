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
import { buildServer } from "./api/server.js";

export const BACKEND_VERSION = "0.1.0";

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
  const dbsync = config.dbsyncUrl
    ? new PostgresDbSyncClient(config.dbsyncUrl)
    : null;

  const runtime = new IndexerRuntime(state, {
    ogmiosUrl: config.ogmiosUrl,
    filter,
    logger: simpleLogger(),
  });

  const server = await buildServer({ state, runtime, config, dbsync });

  // Start chainsync first so requests at /health can already see "tip not yet"
  // rather than racing the connection.
  try {
    await runtime.start();
  } catch (err) {
    server.log?.error?.(`ogmios start failed: ${(err as Error).message}`);
  }

  await server.listen({ port: config.port, host: config.host });
  // eslint-disable-next-line no-console
  console.log(
    `lovejoin backend ${BACKEND_VERSION} listening on http://${config.host}:${config.port} (network=${config.network})`,
  );

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      void shutdown(server, runtime, dbsync);
    });
  }
}

async function shutdown(
  server: Awaited<ReturnType<typeof buildServer>>,
  runtime: IndexerRuntime,
  dbsync: PostgresDbSyncClient | null,
): Promise<void> {
  try {
    await runtime.stop();
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
