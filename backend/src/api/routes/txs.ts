// Transaction-related routes, exported as two plugins:
//
//   - default: `txMutationRoutes` registers POST `/submit` + POST
//     `/evaluate` (ogmios mempool path).
//   - named: `txQueryRoutes` registers GET `/tx/:hash` + GET
//     `/tx/:hash/utxos` (db-sync path).
//
// Two plugins so server.ts can register the address-allowlisted
// `/utxos/:address` between them — the original `server.ts`
// registered the routes in that order and the committed
// `openapi.json` is keyed off the resulting path order.
//
// Spec: docs/spec/05-backend.md §"REST API".

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { ROUTE_SCHEMAS } from "../openapi-schemas.js";
import { redactUpstreamMessage } from "../redact.js";
import { serializeUtxo } from "../serializer.js";
import type { RouteOptions } from "../types.js";

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

interface SubmitBody {
  cbor?: string;
}

interface TxHashParams {
  txhash: string;
}

function isValidTxHex(cbor: string): boolean {
  return (
    /^[0-9a-fA-F]+$/.test(cbor) &&
    cbor.length > 0 &&
    cbor.length <= TX_HEX_MAX_LENGTH &&
    cbor.length % 2 === 0
  );
}

const txMutationRoutes: FastifyPluginAsync<RouteOptions> = async (app, opts) => {
  const { deps } = opts;

  app.post(
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
      if (deps.ogmiosTx.reconnecting().exhausted) {
        // Reconnect circuit is open after `maxReconnectAttempts` failures.
        // Fail-fast rather than driving more reconnect traffic per request.
        reply.code(503);
        return {
          error: "submit_unavailable",
          message: "ogmios upstream unavailable; reconnect attempts exhausted",
        };
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
        req.log.error({ err, raw }, "/submit: ogmios error");
        reply.code(400);
        return {
          error: "submit_failed",
          message: redactUpstreamMessage(raw),
        };
      }
    },
  );

  app.post(
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
      if (deps.ogmiosTx.reconnecting().exhausted) {
        reply.code(503);
        return {
          error: "evaluate_unavailable",
          message: "ogmios upstream unavailable; reconnect attempts exhausted",
        };
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
        req.log.error({ err, raw }, "/evaluate: ogmios error");
        reply.code(400);
        return {
          error: "evaluate_failed",
          message: redactUpstreamMessage(raw),
        };
      }
    },
  );
};

export const txQueryRoutes: FastifyPluginAsync<RouteOptions> = async (app, opts) => {
  const { deps } = opts;

  // Confirmation summary — used by SDK awaitConfirmation. Returns 404
  // before the tx is on chain so callers can poll without a special
  // "still pending" code path.
  app.get(
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
        req.log.error({ err, raw, url: req.url }, "dbsync: txSummary failed");
        reply.code(502);
        return { error: "dbsync_error", message: "internal database error" };
      }
    },
  );

  // UTxOs produced by a specific tx. Resolves SDK getUtxoByRef.
  app.get(
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
        req.log.error({ err, raw, url: req.url }, "dbsync: txUtxos failed");
        reply.code(502);
        return { error: "dbsync_error", message: "internal database error" };
      }
    },
  );
};

export default txMutationRoutes;
