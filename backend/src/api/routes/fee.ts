// `/fee` — snapshot of the sharded fee contract: total lovelace,
// per-shard balances, and the deployment-derived `maxFeePerMix` cap.
//
// Spec: §"REST API".

import type { FastifyPluginAsync } from "fastify";

import { ROUTE_SCHEMAS } from "../openapi-schemas.js";
import type { RouteOptions } from "../types.js";

const feeRoutes: FastifyPluginAsync<RouteOptions> = async (app, opts) => {
  const { deps } = opts;

  app.get("/fee", { schema: ROUTE_SCHEMAS.fee }, async () => {
    const snap = deps.state.feeSnapshot();
    return {
      totalLovelace: snap.totalLovelace,
      shardCount: snap.shards.length,
      shards: snap.shards.map((s) => ({
        txHash: s.txHash,
        outputIndex: s.outputIndex,
        lovelace: s.lovelace,
      })),
      maxFeePerMix: BigInt(deps.config.addresses.protocol.max_fee_per_mix_lovelace),
      estimatedMixesAvailable: snap.estimatedMixesAvailable,
    };
  });
};

export default feeRoutes;
