// `/utxos/:address` — allowlisted to the two protocol-managed
// addresses (mix-box + fee-contract) and served from indexer state.
//
// Why allowlist: the only SDK callers (`fetchPool` and the fee-shard
// fetch) ever ask for these two addresses. Forwarding arbitrary
// addresses to db-sync turned into a DoS surface — every random
// `/utxos/<busy-address>` triggered a full `WHERE address = $1 AND
// NOT EXISTS (...)` scan on home-side postgres, with the route
// timing out at ~12s and the cloudflared tunnel returning 502.
//
// Why state: the indexer already tracks live pool entries + fee
// shards in memory; serving them from `state.pool_()` /
// `state.feeSnapshot()` is sub-millisecond and removes db-sync from
// the critical path entirely. `inlineDatumHex` is captured verbatim
// during `applyForward` so we don't re-encode `Constr 0 [bytes(48),
// bytes(48)]` here — that would invite TS↔Aiken parity drift.
//
// Spec: docs/spec/05-backend.md §"REST API".

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

      if (address === mixAddr) {
        const utxos = deps.state.pool_().map((entry) => poolEntryToUtxo(entry, mixAddr));
        return { address, tip: deps.state.tip, utxos: utxos.map(serializeUtxo) };
      }
      if (address === feeAddr) {
        const utxos = deps.state.feeSnapshot().shards.map((s) => feeShardToUtxo(s, feeAddr));
        return { address, tip: deps.state.tip, utxos: utxos.map(serializeUtxo) };
      }
      reply.code(400);
      return {
        error: "address_not_protocol_managed",
        message:
          "/utxos/:address only serves the two protocol-managed addresses (mix-box, fee-contract)",
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
