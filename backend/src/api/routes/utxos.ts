// `/utxos/:address` — allowlisted to the protocol-managed addresses
// (mix-box + fee-contract, served from indexer state) plus the
// Seedelf wallet-script address (served from db-sync).
//
// Why allowlist: the only SDK callers (`fetchPool`, the fee-shard
// fetch, and the Seedelf scanner) ever ask for these three addresses.
// Forwarding arbitrary addresses to db-sync turned into a DoS surface
// — every random `/utxos/<busy-address>` triggered a full
// `WHERE address = $1 AND NOT EXISTS (...)` scan on home-side
// postgres, with the route timing out at ~12 s and the cloudflared
// tunnel returning 502.
//
// Why two backing stores: mix-box + fee-contract are tracked in the
// indexer's in-memory state (sub-millisecond reads). The Seedelf
// wallet contract is a third-party deployment we do NOT index, but
// the SDK's Seedelf scanner needs its UTxOs for register
// classification. Db-sync handles that path with the same dual-path
// live filter the prime uses; with the `consumed_by_tx_id` fast path
// enabled and a backfill, address scans complete in well under the
// 10 s public-API timeout.
//
// `inlineDatumHex` is captured verbatim during `applyForward` for the
// state-served paths so we don't re-encode `Constr 0 [bytes(48),
// bytes(48)]` here — that would invite TS↔Aiken parity drift. The
// db-sync path returns datums as encoded on chain, also without
// re-encoding.
//
// Spec: §"REST API".

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import type { DbSyncUtxo } from "../../db/dbsync.js";
import type { FeeShard, PoolEntry } from "../../indexer/types.js";
import { ROUTE_SCHEMAS } from "../openapi-schemas.js";
import { serializeUtxo } from "../serializer.js";
import type { RouteOptions } from "../types.js";

interface AddressParams {
  address: string;
}

const utxosRoutes: FastifyPluginAsync<RouteOptions> = async (app, opts) => {
  const { deps } = opts;

  app.get(
    "/utxos/:address",
    { schema: ROUTE_SCHEMAS.addressUtxos },
    async (req: FastifyRequest<{ Params: AddressParams }>, reply: FastifyReply) => {
      const address = req.params.address;
      const mixAddr = deps.config.derived.mixBoxAddress;
      const feeAddr = deps.config.derived.feeContractAddress;
      const seedelfAddr = deps.config.derived.seedelfWalletAddress;

      if (address === mixAddr) {
        const utxos = deps.state.pool_().map((entry) => poolEntryToUtxo(entry, mixAddr));
        return { address, tip: deps.state.tip, utxos: utxos.map(serializeUtxo) };
      }
      if (address === feeAddr) {
        const utxos = deps.state.feeSnapshot().shards.map((s) => feeShardToUtxo(s, feeAddr));
        return { address, tip: deps.state.tip, utxos: utxos.map(serializeUtxo) };
      }
      if (address === seedelfAddr) {
        // Seedelf isn't indexed — pull live UTxOs straight from db-sync.
        // Returns 503 when db-sync isn't configured (operator hasn't set
        // DBSYNC_URL), matching the /tx routes' fallback shape.
        if (!deps.dbsync) {
          reply.code(503);
          return {
            error: "dbsync_unavailable",
            message:
              "Seedelf wallet UTxOs require db-sync; configure DBSYNC_URL or use a Blockfrost fallback in the SDK",
          };
        }
        const rows = await deps.dbsync.utxosAt(seedelfAddr);
        return { address, tip: deps.state.tip, utxos: rows.map(serializeUtxo) };
      }
      reply.code(400);
      return {
        error: "address_not_protocol_managed",
        message:
          "/utxos/:address only serves the protocol-managed addresses (mix-box, fee-contract) and the Seedelf wallet contract",
      };
    },
  );
};

function poolEntryToUtxo(entry: PoolEntry, address: string): DbSyncUtxo {
  return {
    txHash: entry.txHash,
    outputIndex: entry.outputIndex,
    address,
    lovelace: entry.lovelace,
    assets: {},
    inlineDatum: entry.inlineDatumHex,
    datumHash: null,
    referenceScriptCbor: null,
    referenceScriptHash: null,
  };
}

function feeShardToUtxo(shard: FeeShard, address: string): DbSyncUtxo {
  return {
    txHash: shard.txHash,
    outputIndex: shard.outputIndex,
    address,
    lovelace: shard.lovelace,
    assets: {},
    inlineDatum: shard.inlineDatumHex,
    datumHash: null,
    referenceScriptCbor: null,
    referenceScriptHash: null,
  };
}

export default utxosRoutes;
