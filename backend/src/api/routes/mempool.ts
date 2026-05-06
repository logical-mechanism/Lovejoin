// `/mempool/inputs` — the union of every input ref in the cardano-node's
// current mempool. UI clients pass these as `excludeRefs` when picking a
// fee shard or pool box, eliminating most BadInputsUTxO collisions.
//
// Returns an empty snapshot when the poller is absent (tests, or
// misconfigured deploy) or when the first poll hasn't completed yet
// (`acquiredAtMs === 0`). Clients treat the empty case as "fall through
// to the retry path."
//
// Spec: §"REST API".

import type { FastifyPluginAsync } from "fastify";

import { ROUTE_SCHEMAS } from "../openapi-schemas.js";
import type { RouteOptions } from "../types.js";

const mempoolRoutes: FastifyPluginAsync<RouteOptions> = async (app, opts) => {
  const { deps } = opts;

  app.get("/mempool/inputs", { schema: ROUTE_SCHEMAS.mempool }, async () => {
    const snap = deps.mempoolPoller?.snapshot() ?? null;
    if (!snap) {
      return {
        slot: 0,
        acquiredAtMs: 0,
        ageMs: 0,
        txCount: 0,
        inputs: [] as Array<{ txHash: string; outputIndex: number }>,
      };
    }
    const now = (deps.nowMs ?? Date.now)();
    const inputs: Array<{ txHash: string; outputIndex: number }> = [];
    for (const key of snap.inputs) {
      const hash = key.indexOf("#");
      if (hash <= 0) continue;
      const outputIndex = Number(key.slice(hash + 1));
      if (!Number.isInteger(outputIndex) || outputIndex < 0) continue;
      inputs.push({ txHash: key.slice(0, hash), outputIndex });
    }
    return {
      slot: snap.slot,
      acquiredAtMs: snap.acquiredAtMs,
      ageMs: snap.acquiredAtMs > 0 ? Math.max(0, now - snap.acquiredAtMs) : 0,
      txCount: snap.txCount,
      inputs,
    };
  });
};

export default mempoolRoutes;
