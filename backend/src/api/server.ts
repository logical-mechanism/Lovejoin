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
import type { DbSyncClient, HistoryClient } from "../db/dbsync.js";
import type { IndexerState } from "../indexer/state.js";
import type { IndexerRuntime } from "../indexer/runtime.js";
import type { OgmiosTxClient } from "../indexer/ogmios-tx.js";

export interface ApiServerDeps {
  state: IndexerState;
  runtime: IndexerRuntime | null;
  config: BackendConfig;
  /**
   * Primary db-sync client. Drives `/history/:address`,
   * `/utxos/:address`, `/tx/:hash`, `/tx/:hash/utxos`. When null those
   * routes return 503 (or, for /history specifically, fall through to
   * `historyFallback`).
   */
  dbsync: DbSyncClient | null;
  /**
   * Optional Blockfrost-backed fallback for `/history/:address` — used
   * when db-sync is unavailable (initial sync, brief outage). Only
   * implements the history surface (HistoryClient), not the wider
   * UTxO surface, because the rest of the routes have no graceful
   * fallback from chain-state queries.
   */
  historyFallback?: HistoryClient | null;
  /**
   * Mempool-side ogmios client used by `/submit` and `/evaluate`.
   * Optional — tests omit it; the routes 503 when absent so the wire
   * surface still exists and clients see a meaningful error.
   */
  ogmiosTx?: OgmiosTxClient | null;
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
    // Bech32 base addresses on Cardano are ~104–119 chars (preprod stake
    // base addresses go to 119), longer than Fastify's default 100-char
    // param cap. Without bumping this, /utxos/:address and
    // /history/:address silently 404 with the find-my-way fallback
    // instead of calling our handler. 256 leaves room for any future
    // address scheme without exposing a meaningful DoS surface.
    maxParamLength: 256,
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
  registerProtocolParams(fastify, deps);
  registerPool(fastify, deps);
  registerBox(fastify, deps);
  registerFee(fastify, deps);
  registerHistory(fastify, deps);
  registerSubmit(fastify, deps);
  registerEvaluate(fastify, deps);
  registerAddressUtxos(fastify, deps);
  registerTxQueries(fastify, deps);

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

function registerProtocolParams(fastify: FastifyInstance, deps: ApiServerDeps): void {
  // /protocol-params returns the live ledger protocol parameters from
  // ogmios's queryLedgerState. Distinct from /params (which is the
  // protocol's own static config — denominations, script addresses,
  // etc., from addresses.json). The SDK's tx builder needs *both*:
  // /params for "what does Lovejoin charge" and /protocol-params for
  // "what does the ledger charge in fees this epoch".
  //
  // Body is an ogmios v6 object — same shape the SDK already knows how
  // to translate via its mesh-bridge.
  fastify.get(
    "/protocol-params",
    async (_req, reply: FastifyReply) => {
      if (!deps.ogmiosTx) {
        reply.code(503);
        return {
          error: "protocol_params_unavailable",
          message: "ogmios tx client not configured",
        };
      }
      try {
        const params = await deps.ogmiosTx.protocolParameters();
        return params;
      } catch (err) {
        reply.code(502);
        return {
          error: "ogmios_error",
          message: (err as Error).message,
        };
      }
    },
  );
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
      const fallback = deps.historyFallback ?? null;
      if (!deps.dbsync && !fallback) {
        reply.code(503);
        return {
          error: "history_unavailable",
          message:
            "Neither DBSYNC_URL nor BLOCKFROST_PROJECT_ID is configured",
        };
      }
      const address = req.params.address;
      if (typeof address !== "string" || address.length < 10 || address.length > 200) {
        reply.code(400);
        return { error: "bad_request", message: "address malformed" };
      }
      const limit = clamp(Number(req.query.limit ?? "50"), 1, 500, 50);

      // Prefer db-sync (1 SQL query). On error or absence, fall through to
      // the Blockfrost fallback (N+1 HTTP calls). Both clients implement
      // the same `DbSyncClient` shape so the response stays identical.
      let rows;
      let source: "dbsync" | "blockfrost" | null = null;
      let dbsyncError: Error | null = null;
      if (deps.dbsync) {
        try {
          rows = await deps.dbsync.addressHistory(address, limit);
          source = "dbsync";
        } catch (err) {
          dbsyncError = err as Error;
          fastify.log?.warn?.(
            `/history dbsync failed: ${dbsyncError.message}` +
              (fallback ? "; falling back to Blockfrost" : "; no fallback configured"),
          );
        }
      }
      if (rows === undefined && fallback) {
        rows = await fallback.addressHistory(address, limit);
        source = "blockfrost";
      }
      if (rows === undefined) {
        reply.code(503);
        return {
          error: "history_unavailable",
          message: dbsyncError
            ? `dbsync error: ${dbsyncError.message}`
            : "history backend unreachable",
        };
      }

      return {
        address,
        source,
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

interface SubmitBody {
  cbor?: string;
}

function registerSubmit(fastify: FastifyInstance, deps: ApiServerDeps): void {
  fastify.post(
    "/submit",
    async (
      req: FastifyRequest<{ Body: SubmitBody }>,
      reply: FastifyReply,
    ) => {
      if (!deps.ogmiosTx) {
        reply.code(503);
        return { error: "submit_unavailable", message: "ogmios tx client not configured" };
      }
      const cbor = (req.body?.cbor ?? "").trim();
      if (!/^[0-9a-fA-F]+$/.test(cbor) || cbor.length === 0 || cbor.length % 2 !== 0) {
        reply.code(400);
        return { error: "bad_request", message: "body.cbor must be a non-empty even-length hex string" };
      }
      try {
        const txHash = await deps.ogmiosTx.submitTransaction(cbor);
        return { txHash };
      } catch (err) {
        // Bubble the ogmios error verbatim — the SDK + UI already know
        // how to render ledger rejection messages, and translating
        // here would lose detail.
        reply.code(400);
        return {
          error: "submit_failed",
          message: (err as Error).message,
        };
      }
    },
  );
}

function registerEvaluate(fastify: FastifyInstance, deps: ApiServerDeps): void {
  fastify.post(
    "/evaluate",
    async (
      req: FastifyRequest<{ Body: SubmitBody }>,
      reply: FastifyReply,
    ) => {
      if (!deps.ogmiosTx) {
        reply.code(503);
        return { error: "evaluate_unavailable", message: "ogmios tx client not configured" };
      }
      const cbor = (req.body?.cbor ?? "").trim();
      if (!/^[0-9a-fA-F]+$/.test(cbor) || cbor.length === 0 || cbor.length % 2 !== 0) {
        reply.code(400);
        return { error: "bad_request", message: "body.cbor must be a non-empty even-length hex string" };
      }
      try {
        const budgets = await deps.ogmiosTx.evaluateTransaction(cbor);
        return { redeemers: budgets };
      } catch (err) {
        reply.code(400);
        return {
          error: "evaluate_failed",
          message: (err as Error).message,
        };
      }
    },
  );
}

interface AddressParams {
  address: string;
}

function registerAddressUtxos(fastify: FastifyInstance, deps: ApiServerDeps): void {
  fastify.get(
    "/utxos/:address",
    async (
      req: FastifyRequest<{ Params: AddressParams }>,
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
      if (typeof address !== "string" || address.length < 4 || address.length > 200) {
        reply.code(400);
        return { error: "bad_request", message: "address malformed" };
      }
      try {
        const utxos = await deps.dbsync.addressUtxos(address);
        return {
          address,
          tip: deps.state.tip,
          utxos: utxos.map(serializeUtxo),
        };
      } catch (err) {
        reply.code(502);
        return { error: "dbsync_error", message: (err as Error).message };
      }
    },
  );
}

interface TxHashParams {
  txhash: string;
}

function registerTxQueries(fastify: FastifyInstance, deps: ApiServerDeps): void {
  // Confirmation summary — used by SDK awaitConfirmation. Returns 404
  // before the tx is on chain so callers can poll without a special
  // "still pending" code path.
  fastify.get(
    "/tx/:txhash",
    async (
      req: FastifyRequest<{ Params: TxHashParams }>,
      reply: FastifyReply,
    ) => {
      if (!deps.dbsync) {
        reply.code(503);
        return { error: "dbsync_unavailable", message: "DBSYNC_URL not configured" };
      }
      const txHash = req.params.txhash.toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(txHash)) {
        reply.code(400);
        return { error: "bad_request", message: "txhash must be 64 lowercase hex" };
      }
      try {
        const summary = await deps.dbsync.txSummary(txHash);
        if (!summary) {
          reply.code(404);
          return { error: "not_found", message: "tx not on chain (yet)" };
        }
        return summary;
      } catch (err) {
        reply.code(502);
        return { error: "dbsync_error", message: (err as Error).message };
      }
    },
  );

  // UTxOs produced by a specific tx. Resolves SDK getUtxoByRef.
  fastify.get(
    "/tx/:txhash/utxos",
    async (
      req: FastifyRequest<{ Params: TxHashParams }>,
      reply: FastifyReply,
    ) => {
      if (!deps.dbsync) {
        reply.code(503);
        return { error: "dbsync_unavailable", message: "DBSYNC_URL not configured" };
      }
      const txHash = req.params.txhash.toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(txHash)) {
        reply.code(400);
        return { error: "bad_request", message: "txhash must be 64 lowercase hex" };
      }
      try {
        const utxos = await deps.dbsync.txUtxos(txHash);
        if (utxos.length === 0) {
          // Empty could mean "tx not on chain" OR "tx on chain but
          // produced no outputs" (impossible in practice, but be
          // defensive). 404 keeps the contract uniform with /tx/:hash.
          reply.code(404);
          return { error: "not_found" };
        }
        return { txHash, utxos: utxos.map(serializeUtxo) };
      } catch (err) {
        reply.code(502);
        return { error: "dbsync_error", message: (err as Error).message };
      }
    },
  );
}

/**
 * Wire shape for a UTxO. Lovelace is a decimal string so the JSON
 * serializer doesn't lose precision on values that fit a JS bigint
 * but exceed Number.MAX_SAFE_INTEGER. Asset quantities follow the
 * same convention.
 */
function serializeUtxo(u: import("../db/dbsync.js").DbSyncUtxo): {
  txHash: string;
  outputIndex: number;
  address: string;
  lovelace: string;
  assets: Record<string, string>;
  inlineDatum: string | null;
  datumHash: string | null;
  referenceScriptCbor: string | null;
  referenceScriptHash: string | null;
} {
  const assets: Record<string, string> = {};
  for (const [unit, qty] of Object.entries(u.assets)) {
    assets[unit] = qty.toString();
  }
  return {
    txHash: u.txHash,
    outputIndex: u.outputIndex,
    address: u.address,
    lovelace: u.lovelace.toString(),
    assets,
    inlineDatum: u.inlineDatum,
    datumHash: u.datumHash,
    referenceScriptCbor: u.referenceScriptCbor,
    referenceScriptHash: u.referenceScriptHash,
  };
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
