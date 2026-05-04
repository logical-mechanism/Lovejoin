// Fastify API server. All routes return JSON; rate-limited per IP per
// the spec's "no auth, fastify rate limit per IP" requirement.
//
// Spec: docs/spec/05-backend.md §"REST API".

import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import { validateBech32AddressForNetwork } from "../address.js";
import type { BackendConfig } from "../config.js";
import type { DbSyncClient, HistoryClient } from "../db/dbsync.js";
import type { IndexerState } from "../indexer/state.js";
import type { IndexerRuntime } from "../indexer/runtime.js";
import type { OgmiosTxClient } from "../indexer/ogmios-tx.js";
import type { MempoolPoller } from "../indexer/mempool.js";
import {
  OPENAPI_INFO,
  OPENAPI_TAGS,
  ROUTE_SCHEMAS,
  SHARED_OPENAPI_SCHEMAS,
} from "./openapi-schemas.js";

// Per-route override for /submit and /evaluate: tighter than the global
// limit, since they touch the node mempool and are the most expensive
// endpoints (security review v1, finding H2). 60/minute matches the
// upper bound of how often a sane client would resubmit.
const TX_ROUTE_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const;
// Cardano transactions are bounded by `max_tx_size` (≤16 KiB on
// mainnet/preprod). Hex-encoded that doubles to ≤32 KiB; 64 KiB leaves
// headroom for any future protocol-param bump without inviting 1 MiB
// junk uploads at the global default (security review v1, finding H2).
const TX_ROUTE_BODY_LIMIT = 64 * 1024;
// `/submit` and `/evaluate` operate on hex CBOR strings; cap the
// payload length explicitly so a malformed request can't burn cycles
// in `Buffer.from(hex)` before we reject it.
const TX_HEX_MAX_LENGTH = TX_ROUTE_BODY_LIMIT;

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
  /**
   * Mempool poller backing `/mempool/inputs`. Optional — when absent
   * the route returns an empty snapshot so clients can keep working
   * without mempool-aware picking.
   */
  mempoolPoller?: MempoolPoller | null;
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
    // Trust the immediate proxy so `request.ip` reflects the real client
    // IP from `X-Forwarded-For` rather than the LB's internal IP. Without
    // this, `@fastify/rate-limit` keys every request behind DO App
    // Platform / Cloudflare on the same proxy address and the per-IP
    // ceiling collapses to a single global counter (security review v1,
    // finding H1). `true` accepts the first hop; tighten to a CIDR list
    // if we ever sit behind multiple proxies.
    trustProxy: true,
  });
  fastify.setReplySerializer((payload) => JSON.stringify(payload, PRESERVE_BIGINT_REPLACER));
  // Map Fastify schema validation errors (introduced when route schemas
  // gained body / params / querystring shapes for OpenAPI docs) onto the
  // existing `{ error, message }` envelope every other 400 in this API
  // already uses. Without this Fastify returns
  // `{ statusCode: 400, error: "Bad Request", message: ... }` which
  // would silently break clients that key off `error === "bad_request"`.
  fastify.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err.validation) {
      reply.code(400);
      return {
        error: "bad_request",
        message: err.message,
      };
    }
    throw err;
  });
  // Add baseline security headers on every JSON response. Helmet would
  // do the same with more knobs; we keep the dependency footprint flat
  // and apply only the headers that matter for a JSON API behind a
  // browser UI on a separate origin.
  fastify.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    return payload;
  });
  await fastify.register(cors, {
    // `corsOrigins === "*"` reflects any origin — only used in tests +
    // local dev. In production set CORS_ORIGINS to the explicit list of
    // UI origins (e.g. https://lovejo.in,https://preprod.lovejo.in).
    origin: deps.config.corsOrigins === "*" ? true : deps.config.corsOrigins,
  });
  await fastify.register(rateLimit, {
    max: deps.config.rateLimitPerMin,
    timeWindow: "1 minute",
    // `keyGenerator` defaults to `req.ip`; with `trustProxy: true` above
    // that resolves to the first X-Forwarded-For hop. We set it
    // explicitly so a future Fastify-default change can't silently
    // re-introduce H1.
    keyGenerator: (req) => req.ip,
  });

  // OpenAPI 3 docs (issue #41). The schema is generated from the
  // per-route fastify schemas attached below; `/docs` serves the
  // Swagger UI in dev/preprod, `/docs/json` returns the raw OpenAPI
  // 3 document used by the `docs:openapi` export script for client
  // codegen.
  //
  // Shared schemas land in Fastify's Ajv instance via addSchema() so
  // both response validation and the @fastify/swagger output resolve
  // them. The plugin lifts every registered schema into
  // `components.schemas` and rewrites Fastify-style `<id>#` refs to
  // canonical OpenAPI `#/components/schemas/<id>` form.
  for (const schema of SHARED_OPENAPI_SCHEMAS) {
    fastify.addSchema(schema);
  }
  await fastify.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: OPENAPI_INFO,
      tags: [...OPENAPI_TAGS],
    },
    // Preserve `$id` as the OpenAPI component-schema key. Without this
    // hook @fastify/swagger emits `def-0`, `def-1`, ... and shoves the
    // `$id` into a `title` field, which makes the spec hard to read
    // and unusable for codegen tools that key off component names.
    refResolver: {
      buildLocalReference: (json) => {
        const id = (json as { $id?: string }).$id;
        return typeof id === "string" && id.length > 0 ? id : "Unknown";
      },
    },
  });
  await fastify.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: true },
    staticCSP: true,
  });

  registerHealth(fastify, deps);
  registerParams(fastify, deps);
  registerProtocolParams(fastify, deps);
  registerPool(fastify, deps);
  registerBox(fastify, deps);
  registerFee(fastify, deps);
  registerMempool(fastify, deps);
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
  fastify.get("/health", { schema: ROUTE_SCHEMAS.health }, async (_req, reply: FastifyReply) => {
    const tip = deps.state.tip;
    const chainTip = deps.runtime?.chainTip() ?? null;
    // Lag is measured in *slots*, not seconds — slots on Cardano are
    // slots-since-Shelley-genesis, not seconds-since-epoch, so wall
    // clock can't be the reference point. Conway slot length is 1s on
    // Preprod / Mainnet so the slot lag is the same number you'd see
    // in seconds anyway; we keep the field name `lagSeconds` for
    // backward compat with the spec but populate it from
    // `chainTip.slot - indexerTip.slot`.
    const lagSeconds = tip && chainTip ? Math.max(0, chainTip.slot - tip.slot) : null;
    const fatalError = deps.runtime?.fatalError() ?? null;
    // Surface unhealthy as HTTP 503 only when the indexer runtime has a
    // *fatal* error — i.e., the chainsync loop is permanently gone
    // (after the runtime exhausted its in-process reconnect attempts).
    // While the runtime is actively reconnecting `fatalError()` stays
    // null and we keep returning 200 so DO doesn't recycle the
    // container during a recoverable transient: cached state still
    // serves /params, /pool, /box/*, /fee. The reconnect status is
    // surfaced separately via `chainsyncReconnect` for operator
    // visibility.
    //
    // We deliberately do NOT 503 on `state.alarm()` either — that's a
    // real on-chain anomaly a restart cannot fix, so /params already
    // 503s but /health stays 200 to keep the container alive for
    // operator inspection.
    if (fatalError) {
      reply.code(503);
    }
    const reconnect = deps.runtime?.reconnecting() ?? null;
    // Redact host/URL fragments from runtime + reconnect error
    // messages so /health doesn't leak ogmios endpoints to a public
    // caller (security review v1, finding H3).
    const redactedReconnect = reconnect
      ? { ...reconnect, lastErrorMessage: redactUpstreamMessage(reconnect.lastErrorMessage) }
      : null;
    return {
      ok: deps.state.alarm() === null && fatalError === null,
      tip,
      chainTip,
      lagSeconds,
      referenceUtxoOk: deps.state.snapshot().referenceUtxoOk,
      runtimeRunning: deps.runtime?.isRunning() ?? null,
      runtimeError: fatalError ? redactUpstreamMessage(fatalError.message) : null,
      chainsyncReconnect: redactedReconnect,
    };
  });
}

function registerParams(fastify: FastifyInstance, deps: ApiServerDeps): void {
  fastify.get("/params", { schema: ROUTE_SCHEMAS.params }, async (_req, reply) => {
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
    { schema: ROUTE_SCHEMAS.protocolParams },
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
        const raw = (err as Error).message ?? "ogmios error";
        console.error(`[/protocol-params] ogmios error: ${raw}`);
        reply.code(502);
        return {
          error: "ogmios_error",
          message: redactUpstreamMessage(raw),
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
  fastify.get(
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
  fastify.get(
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
}

interface BoxParams {
  txhash: string;
  idx: string;
}

function registerBox(fastify: FastifyInstance, deps: ApiServerDeps): void {
  fastify.get(
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
}

function registerFee(fastify: FastifyInstance, deps: ApiServerDeps): void {
  fastify.get("/fee", { schema: ROUTE_SCHEMAS.fee }, async () => {
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

/**
 * `/mempool/inputs` — the union of every input ref in the cardano-node's
 * current mempool. UI clients pass these as `excludeRefs` when picking a
 * fee shard or pool box, eliminating most BadInputsUTxO collisions.
 *
 * Returns an empty snapshot when the poller is absent (tests, or
 * misconfigured deploy) or when the first poll hasn't completed yet
 * (`acquiredAtMs === 0`). Clients treat the empty case as "fall through
 * to the retry path."
 */
function registerMempool(fastify: FastifyInstance, deps: ApiServerDeps): void {
  fastify.get("/mempool/inputs", { schema: ROUTE_SCHEMAS.mempool }, async () => {
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
    { schema: ROUTE_SCHEMAS.history },
    async (
      req: FastifyRequest<{ Params: HistoryParams; Querystring: HistoryQuery }>,
      reply: FastifyReply,
    ) => {
      const fallback = deps.historyFallback ?? null;
      if (!deps.dbsync && !fallback) {
        reply.code(503);
        return {
          error: "history_unavailable",
          message: "Neither DBSYNC_URL nor BLOCKFROST_PROJECT_ID is configured",
        };
      }
      const address = req.params.address;
      const addrErr = validateBech32AddressForNetwork(address, deps.config.network);
      if (addrErr !== null) {
        reply.code(400);
        return { error: "bad_request", message: `address malformed: ${addrErr}` };
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
          // Log full error server-side (operator visibility); never
          // forward it to the client (it carries pg connection
          // strings and host metadata) — security review v1, H3.
          console.error(
            `[/history] dbsync failed: ${dbsyncError.message}` +
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
          message: "history backend unreachable",
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
    {
      bodyLimit: TX_ROUTE_BODY_LIMIT,
      config: { rateLimit: TX_ROUTE_RATE_LIMIT },
      schema: ROUTE_SCHEMAS.submit,
    },
    async (req: FastifyRequest<{ Body: SubmitBody }>, reply: FastifyReply) => {
      if (!deps.ogmiosTx) {
        reply.code(503);
        return { error: "submit_unavailable", message: "ogmios tx client not configured" };
      }
      const cbor = (req.body?.cbor ?? "").trim();
      if (!isValidTxHex(cbor)) {
        reply.code(400);
        return {
          error: "bad_request",
          message: "body.cbor must be a non-empty even-length hex string within size cap",
        };
      }
      try {
        const txHash = await deps.ogmiosTx.submitTransaction(cbor);
        return { txHash };
      } catch (err) {
        // Bubble the ogmios error to the client so the SDK + UI can
        // render ledger rejection messages. We redact host/credential
        // patterns first so a transport-layer failure in front of
        // ogmios (websocket close, Cloudflare Access) doesn't leak
        // infrastructure topology to the caller (security review v1,
        // finding H3). Full message is logged server-side.
        const raw = (err as Error).message ?? "submit failed";
        console.error(`[/submit] ogmios error: ${raw}`);
        reply.code(400);
        return {
          error: "submit_failed",
          message: redactUpstreamMessage(raw),
        };
      }
    },
  );
}

function registerEvaluate(fastify: FastifyInstance, deps: ApiServerDeps): void {
  fastify.post(
    "/evaluate",
    {
      bodyLimit: TX_ROUTE_BODY_LIMIT,
      config: { rateLimit: TX_ROUTE_RATE_LIMIT },
      schema: ROUTE_SCHEMAS.evaluate,
    },
    async (req: FastifyRequest<{ Body: SubmitBody }>, reply: FastifyReply) => {
      if (!deps.ogmiosTx) {
        reply.code(503);
        return { error: "evaluate_unavailable", message: "ogmios tx client not configured" };
      }
      const cbor = (req.body?.cbor ?? "").trim();
      if (!isValidTxHex(cbor)) {
        reply.code(400);
        return {
          error: "bad_request",
          message: "body.cbor must be a non-empty even-length hex string within size cap",
        };
      }
      try {
        const budgets = await deps.ogmiosTx.evaluateTransaction(cbor);
        return { redeemers: budgets };
      } catch (err) {
        const raw = (err as Error).message ?? "evaluate failed";
        console.error(`[/evaluate] ogmios error: ${raw}`);
        reply.code(400);
        return {
          error: "evaluate_failed",
          message: redactUpstreamMessage(raw),
        };
      }
    },
  );
}

function isValidTxHex(cbor: string): boolean {
  return (
    /^[0-9a-fA-F]+$/.test(cbor) &&
    cbor.length > 0 &&
    cbor.length <= TX_HEX_MAX_LENGTH &&
    cbor.length % 2 === 0
  );
}

interface AddressParams {
  address: string;
}

function registerAddressUtxos(fastify: FastifyInstance, deps: ApiServerDeps): void {
  fastify.get(
    "/utxos/:address",
    { schema: ROUTE_SCHEMAS.addressUtxos },
    async (req: FastifyRequest<{ Params: AddressParams }>, reply: FastifyReply) => {
      if (!deps.dbsync) {
        reply.code(503);
        return {
          error: "dbsync_unavailable",
          message: "DBSYNC_URL not configured",
        };
      }
      const address = req.params.address;
      const addrErr = validateBech32AddressForNetwork(address, deps.config.network);
      if (addrErr !== null) {
        reply.code(400);
        return { error: "bad_request", message: `address malformed: ${addrErr}` };
      }
      try {
        const utxos = await deps.dbsync.addressUtxos(address);
        return {
          address,
          tip: deps.state.tip,
          utxos: utxos.map(serializeUtxo),
        };
      } catch (err) {
        const raw = (err as Error).message ?? "dbsync error";
        console.error(`[dbsync] ${req.url}: ${raw}`);
        reply.code(502);
        return { error: "dbsync_error", message: "internal database error" };
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
    { schema: ROUTE_SCHEMAS.txSummary },
    async (req: FastifyRequest<{ Params: TxHashParams }>, reply: FastifyReply) => {
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
        const raw = (err as Error).message ?? "dbsync error";
        console.error(`[dbsync] ${req.url}: ${raw}`);
        reply.code(502);
        return { error: "dbsync_error", message: "internal database error" };
      }
    },
  );

  // UTxOs produced by a specific tx. Resolves SDK getUtxoByRef.
  fastify.get(
    "/tx/:txhash/utxos",
    { schema: ROUTE_SCHEMAS.txUtxos },
    async (req: FastifyRequest<{ Params: TxHashParams }>, reply: FastifyReply) => {
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
        const raw = (err as Error).message ?? "dbsync error";
        console.error(`[dbsync] ${req.url}: ${raw}`);
        reply.code(502);
        return { error: "dbsync_error", message: "internal database error" };
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

/**
 * Redact infrastructure topology from an upstream error message before
 * returning it to the client. Strips: postgres connection strings,
 * Blockfrost project ids, IPv4 addresses with optional ports, and bare
 * URLs. Caps the result at 256 chars so a chatty upstream stack trace
 * can't be used as an amplifier for log spam (security review v1,
 * finding H3). Operators get the full message via console.error;
 * clients get a redacted, length-bounded summary.
 */
export function redactUpstreamMessage(raw: string | undefined | null): string {
  if (!raw) return "upstream error";
  let s = String(raw);
  s = s.replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, "postgres://***");
  s = s.replace(/\bproject_id[=:]\s*[a-z0-9]{20,}/gi, "project_id=***");
  s = s.replace(/\bpreprod[a-z0-9]{20,}\b/gi, "preprod***");
  s = s.replace(/\bmainnet[a-z0-9]{20,}\b/gi, "mainnet***");
  s = s.replace(/\bpreview[a-z0-9]{20,}\b/gi, "preview***");
  s = s.replace(/(https?|wss?):\/\/[^\s"'`]+/gi, "$1://***");
  s = s.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?/g, "***");
  if (s.length > 256) s = s.slice(0, 253) + "...";
  return s;
}
