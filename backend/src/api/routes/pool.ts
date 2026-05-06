// `/pool` + `/pool/light` — paginated views of the live mix-box pool.
//
// `/pool` returns the full per-box record (datum + metadata); the
// `/pool/light` variant trims it down to the bare minimum the browser
// needs for an ownership scan, so a thousand-box page fits in a few
// dozen kilobytes.
//
// Spec: §"REST API".

import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import { ROUTE_SCHEMAS } from "../openapi-schemas.js";
import type { RouteOptions } from "../types.js";

const DEFAULT_PAGE_LIMIT = 500;
const MAX_PAGE_LIMIT = 1000;

interface PoolQuery {
  cursor?: string;
  limit?: string;
  light?: string;
}

const poolRoutes: FastifyPluginAsync<RouteOptions> = async (app, opts) => {
  const { deps } = opts;

  app.get(
    "/pool",
    { schema: ROUTE_SCHEMAS.pool },
    async (req: FastifyRequest<{ Querystring: PoolQuery }>) => {
      const { cursor, limit } = parsePagination(req.query);
      const { rows, nextCursor } = deps.state.poolPage(cursor, limit);
      return {
        tip: deps.state.tip,
        size: deps.state.poolSize(),
        cursor,
        nextCursor,
        boxes: rows.map((b) => ({
          txHash: b.txHash,
          outputIndex: b.outputIndex,
          a: b.a,
          b: b.b,
          generation: b.generation,
          createdSlot: b.slot,
        })),
      };
    },
  );

  // /pool/light — minimal payload for browser ownership-scan.
  app.get(
    "/pool/light",
    { schema: ROUTE_SCHEMAS.poolLight },
    async (req: FastifyRequest<{ Querystring: PoolQuery }>) => {
      const { cursor, limit } = parsePagination(req.query);
      const { rows, nextCursor } = deps.state.poolPage(cursor, limit);
      return {
        size: deps.state.poolSize(),
        nextCursor,
        boxes: rows.map((b) => ({
          txHash: b.txHash,
          outputIndex: b.outputIndex,
          a: b.a,
          b: b.b,
        })),
      };
    },
  );
};

function parsePagination(q: PoolQuery): { cursor: number; limit: number } {
  const cursor = clamp(Number(q.cursor ?? "0"), 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = clamp(
    Number(q.limit ?? String(DEFAULT_PAGE_LIMIT)),
    1,
    MAX_PAGE_LIMIT,
    DEFAULT_PAGE_LIMIT,
  );
  return { cursor, limit };
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export default poolRoutes;
