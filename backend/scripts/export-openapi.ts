// Dump the live OpenAPI 3 document the running server would serve at
// `/docs/json`, without standing up the network listener / DB / ogmios
// stack. Useful for:
//
//   - client codegen (`openapi-typescript`, `openapi-generator`, etc.)
//   - CI snapshots that catch silent contract drift
//   - shipping a static `openapi.json` next to release tags
//
// Run: `pnpm --filter @lovejoin/backend run docs:openapi [outfile]`
//      defaults to `backend/openapi.json`.
//
// The script is dep-free of any runtime config: `buildServer` accepts
// stub deps (null dbsync / ogmios / runtime / mempool) and `swagger()`
// only walks the registered route schemas, which the script writes out
// after a single in-process call. No port is bound.

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { LovejoinAddresses, BackendConfig } from "../src/config.js";
import { buildServer } from "../src/api/server.js";
import { IndexerState } from "../src/indexer/state.js";

// 56-hex placeholders so the in-memory state passes its own internal
// invariants. None of these reach the wire — we only call
// `fastify.swagger()` and write the result to disk.
const PLACEHOLDER: LovejoinAddresses = {
  network: "preprod",
  protocol: { denom_lovelace: 0, max_fee_per_mix_lovelace: 0 },
  referenceNftPolicy: "00".repeat(28),
  referenceNftAssetName: "",
  referenceUtxoRef: "00".repeat(32) + "#0",
  referenceHolderScriptHash: "00".repeat(28),
  mixLogicScriptHash: "00".repeat(28),
  mixBoxScriptHash: "00".repeat(28),
  feeScriptHash: "00".repeat(28),
  feeShardUtxos: [],
};

const CONFIG: BackendConfig = {
  network: "preprod",
  port: 0,
  host: "127.0.0.1",
  ogmiosUrl: "ws://localhost:0",
  dbsyncUrl: null,
  blockfrostProjectId: null,
  blockfrostBaseUrl: null,
  corsOrigins: "*",
  rateLimitPerMin: 60,
  addresses: PLACEHOLDER,
  derived: {
    mixBoxAddress: "addr_test1placeholder",
    feeContractAddress: "addr_test1placeholder",
    referenceHolderAddress: "addr_test1placeholder",
  },
};

async function main(): Promise<void> {
  const outArg = process.argv[2] ?? "openapi.json";
  const outPath = resolve(process.cwd(), outArg);
  const state = new IndexerState(
    CONFIG.addresses,
    {
      mixBoxAddress: CONFIG.derived.mixBoxAddress,
      feeContractAddress: CONFIG.derived.feeContractAddress,
      referenceNftUnit:
        CONFIG.addresses.referenceNftPolicy + CONFIG.addresses.referenceNftAssetName,
    },
    BigInt(CONFIG.addresses.protocol.max_fee_per_mix_lovelace),
  );
  const server = await buildServer({
    state,
    runtime: null,
    config: CONFIG,
    dbsync: null,
  });
  await server.ready();
  const spec = (server as unknown as { swagger: () => unknown }).swagger();
  await server.close();
  const json = JSON.stringify(spec, null, 2) + "\n";
  await writeFile(outPath, json, "utf8");
  process.stdout.write(`wrote ${outPath} (${json.length} bytes)\n`);
}

main().catch((err: unknown) => {
  const e = err as Error;
  process.stderr.write(`export-openapi failed: ${e.stack ?? e.message ?? String(err)}\n`);
  process.exit(1);
});
