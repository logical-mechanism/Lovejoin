// Fastify API server. All routes return JSON; rate-limited per IP per
// the spec's "no auth, fastify rate limit per IP" requirement.
//
// Spec: docs/spec/05-backend.md §"REST API".

import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import type { BackendConfig } from "../config.js";
import type { DbSyncClient } from "../db/dbsync.js";
import type { IndexerState } from "../indexer/state.js";
import type { IndexerRuntime } from "../indexer/runtime.js";

export interface ApiServerDeps {
  state: IndexerState;
  runtime: IndexerRuntime | null;
  config: BackendConfig;
  dbsync: DbSyncClient | null;
  /** When set, used as the "now" for `lagSeconds`; tests pin it. */
  nowMs?: () => number;
}

const DEFAULT_PAGE_LIMIT = 500;
const MAX_PAGE_LIMIT = 1000;

const PRESERVE_BIGINT_REPLACER = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

export async function buildServer(deps: ApiServerDeps): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: false,
    // Render bigints as strings so JSON.stringify doesn't throw on them.
    // Fastify's default reply serializer goes through JSON.stringify; the
    // replacer here keeps the wire format consistent with the spec
    // (lovelace as decimal strings).
    serializerOpts: { rounding: "ceil" },
  });
  fastify.setReplySerializer((payload) =>
    JSON.stringify(payload, PRESERVE_BIGINT_REPLACER),
  );
  await fastify.register(cors, {
    origin: deps.config.corsOrigins === "*" ? true : deps.config.corsOrigins,
  });
  await fastify.register(rateLimit, {
    max: deps.config.rateLimitPerMin,
    timeWindow: "1 minute",
  });

  registerHealth(fastify, deps);
  registerParams(fastify, deps);
  registerPool(fastify, deps);
  registerBox(fastify, deps);
  registerFee(fastify, deps);
  registerHistory(fastify, deps);

  return fastify;
}

// ------------------------------------------------------------------
// Routes
// ------------------------------------------------------------------

function registerHealth(fastify: FastifyInstance, deps: ApiServerDeps): void {
  fastify.get("/health", async () => {
    const tip = deps.state.tip;
    const chainTip = deps.runtime?.chainTip() ?? null;
    // Lag is measured in *slots*, not seconds — slots on Cardano are
    // slots-since-Shelley-genesis, not seconds-since-epoch, so wall
    // clock can't be the reference point. Conway slot length is 1s on
    // Preprod / Mainnet so the slot lag is the same number you'd see
    // in seconds anyway; we keep the field name `lagSeconds` for
    // backward compat with the spec but populate it from
    // `chainTip.slot - indexerTip.slot`.
    const lagSeconds =
      tip && chainTip ? Math.max(0, chainTip.slot - tip.slot) : null;
    return {
      ok: deps.state.alarm() === null,
      tip,
      chainTip,
      lagSeconds,
      referenceUtxoOk: deps.state.snapshot().referenceUtxoOk,
      runtimeRunning: deps.runtime?.isRunning() ?? null,
      runtimeError: deps.runtime?.fatalError()?.message ?? null,
    };
  });
}

function registerParams(fastify: FastifyInstance, deps: ApiServerDeps): void {
  fastify.get("/params", async (_req, reply) => {
    const ref = deps.state.referenceUtxoRef();
    if (deps.state.alarm()) {
      reply.code(503);
      return {
        error: "reference_utxo_alarm",
        message: deps.state.alarm(),
      };
    }
    const a = deps.config.addresses;
    return {
      network: a.network,
      denomLovelace: BigInt(a.protocol.denom_lovelace),
      maxFeePerMix: BigInt(a.protocol.max_fee_per_mix_lovelace),
      defaultMixRounds: 30,
      minMixRounds: 5,
      feeShardTarget: a.protocol.fee_shard_target,
      mixScriptAddress: deps.config.derived.mixBoxAddress,
      feeScriptAddress: deps.config.derived.feeContractAddress,
      referenceUtxo: ref
        ? { txHash: ref.txId, outputIndex: ref.outputIndex }
        : { txHash: a.referenceUtxoRef.split("#")[0], outputIndex: 0 },
      referenceNft: {
        policyId: a.referenceNftPolicy,
        assetName: a.referenceNftAssetName,
      },
    };
  });
}

interface PoolQuery {
  cursor?: string;
  limit?: string;
  light?: string;
}

function registerPool(fastify: FastifyInstance, deps: ApiServerDeps): void {
  fastify.get("/pool", async (req: FastifyRequest<{ Querystring: PoolQuery }>) => {
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
  });

  // /pool/light — minimal payload for browser ownership-scan.
  fastify.get(
    "/pool/light",
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
}

interface BoxParams {
  txhash: string;
  idx: string;
}

function registerBox(fastify: FastifyInstance, deps: ApiServerDeps): void {
  fastify.get(
    "/box/:txhash/:idx",
    async (req: FastifyRequest<{ Params: BoxParams }>, reply: FastifyReply) => {
      const txId = req.params.txhash.toLowerCase();
      const outputIndex = Number(req.params.idx);
      if (!/^[0-9a-f]{64}$/.test(txId) || !Number.isInteger(outputIndex) || outputIndex < 0) {
        reply.code(400);
        return { error: "bad_request", message: "txhash must be 64 lowercase hex; idx must be int" };
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
}

function registerFee(fastify: FastifyInstance, deps: ApiServerDeps): void {
  fastify.get("/fee", async () => {
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
}

interface HistoryParams {
  address: string;
}
interface HistoryQuery {
  limit?: string;
}

function registerHistory(fastify: FastifyInstance, deps: ApiServerDeps): void {
  fastify.get(
    "/history/:address",
    async (
      req: FastifyRequest<{ Params: HistoryParams; Querystring: HistoryQuery }>,
      reply: FastifyReply,
    ) => {
      if (!deps.dbsync) {
        reply.code(503);
        return {
          error: "dbsync_unavailable",
          message: "DBSYNC_URL not configured",
        };
      }
      const address = req.params.address;
      if (typeof address !== "string" || address.length < 10 || address.length > 200) {
        reply.code(400);
        return { error: "bad_request", message: "address malformed" };
      }
      const limit = clamp(
        Number(req.query.limit ?? "50"),
        1,
        500,
        50,
      );
      const rows = await deps.dbsync.addressHistory(address, limit);
      return {
        address,
        history: rows.map((h) => ({
          txHash: h.txHash,
          blockHeight: h.blockHeight,
          blockTime: h.blockTime,
          lovelaceReceived: h.lovelaceReceived,
        })),
      };
    },
  );
}

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
