// `/health` — liveness + indexer-state summary.
//
// Spec: docs/spec/05-backend.md §"REST API".

import type { FastifyPluginAsync, FastifyReply } from "fastify";

import { ROUTE_SCHEMAS } from "../openapi-schemas.js";
import { redactUpstreamMessage } from "../redact.js";
import type { RouteOptions } from "../types.js";

const healthRoutes: FastifyPluginAsync<RouteOptions> = async (app, opts) => {
  const { deps } = opts;

  app.get("/health", { schema: ROUTE_SCHEMAS.health }, async (_req, reply: FastifyReply) => {
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
    const mempoolReconnect = deps.ogmiosTx?.reconnecting() ?? null;
    const redactedMempoolReconnect = mempoolReconnect
      ? {
          ...mempoolReconnect,
          lastErrorMessage: redactUpstreamMessage(mempoolReconnect.lastErrorMessage),
        }
      : null;
    // Origin tells operators whether the cold-start prime took
    // (`source: "primed"`) or the legacy walk-forward path was used
    // (`source: "replayed"`). On deploy the value is the proxy for
    // "did the fast path engage". `reprimeCount > 0` after a
    // `primed` deploy means an in-process deep-rollback recovery
    // fired since process start.
    const origin = deps.runtime?.origin() ?? null;
    const redactedOrigin = origin
      ? {
          ...origin,
          lastErrorMessage: origin.lastErrorMessage
            ? redactUpstreamMessage(origin.lastErrorMessage)
            : "",
        }
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
      mempoolReconnect: redactedMempoolReconnect,
      indexerOrigin: redactedOrigin,
    };
  });
};

export default healthRoutes;
