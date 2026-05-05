// `/box/:txhash/:idx` — point lookup for a single mix-box by output ref.
//
// Spec: docs/spec/05-backend.md §"REST API".

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { ROUTE_SCHEMAS } from "../openapi-schemas.js";
import type { RouteOptions } from "../types.js";

interface BoxParams {
  txhash: string;
  idx: string;
}

const boxRoutes: FastifyPluginAsync<RouteOptions> = async (app, opts) => {
  const { deps } = opts;

  app.get(
    "/box/:txhash/:idx",
    { schema: ROUTE_SCHEMAS.box },
    async (req: FastifyRequest<{ Params: BoxParams }>, reply: FastifyReply) => {
      const txId = req.params.txhash.toLowerCase();
      const outputIndex = Number(req.params.idx);
      if (!/^[0-9a-f]{64}$/.test(txId) || !Number.isInteger(outputIndex) || outputIndex < 0) {
        reply.code(400);
        return {
          error: "bad_request",
          message: "txhash must be 64 lowercase hex; idx must be int",
        };
      }
      const entry = deps.state.poolGet({ txId, outputIndex });
      if (!entry) {
        reply.code(404);
        return { error: "not_found" };
      }
      return {
        txHash: entry.txHash,
        outputIndex: entry.outputIndex,
        a: entry.a,
        b: entry.b,
        generation: entry.generation,
        createdSlot: entry.slot,
      };
    },
  );
};

export default boxRoutes;
