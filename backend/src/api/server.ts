// Fastify API server. All routes return JSON; rate-limited per IP per
// the spec's "no auth, fastify rate limit per IP" requirement.
//
// The route handlers themselves live under `routes/`; this file is
// bootstrap + cross-cutting concerns (logger, error envelope,
// security headers, CORS, rate limit, OpenAPI) and a fan-out of
// `app.register()` calls into the per-resource plugins.
//
// Spec: docs/spec/05-backend.md §"REST API".

import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from "fastify";

import { buildLogger } from "../logger.js";
import { OPENAPI_INFO, OPENAPI_TAGS, SHARED_OPENAPI_SCHEMAS } from "./openapi-schemas.js";
import boxRoutes from "./routes/box.js";
import feeRoutes from "./routes/fee.js";
import healthRoutes from "./routes/health.js";
import mempoolRoutes from "./routes/mempool.js";
import paramsRoutes from "./routes/params.js";
import poolRoutes from "./routes/pool.js";
import txMutationRoutes, { txQueryRoutes } from "./routes/txs.js";
import utxosRoutes from "./routes/utxos.js";
import { PRESERVE_BIGINT_REPLACER } from "./serializer.js";
import type { ApiServerDeps } from "./types.js";

export type { ApiServerDeps } from "./types.js";

export async function buildServer(deps: ApiServerDeps): Promise<FastifyInstance> {
  const logger = deps.logger ?? buildLogger();
  // Cast back to the default `FastifyInstance` (with `FastifyBaseLogger`).
  // Without this, passing a concrete pino instance lets TypeScript
  // infer `Logger = pino.Logger`, which then makes every helper
  // (`registerHealth`, etc.) typed against the wider pino surface and
  // clashes with Fastify's `FastifyBaseLogger` default — pino's
  // `BaseLogger` carries `msgPrefix` while Fastify's does not.
  const fastify = Fastify({
    // Cast widens pino.Logger to FastifyBaseLogger so Fastify's generic
    // inference defaults to `Logger = FastifyBaseLogger` and the
    // route-helper signatures stay compatible. Pino's Logger is a
    // structural superset of FastifyBaseLogger, so the cast is sound.
    loggerInstance: logger as FastifyBaseLogger,
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

  // OpenAPI 3 docs (issue #41). Schemas + swagger registration live at
  // the root scope rather than inside a sub-plugin: `addSchema` is
  // encapsulated to the calling plugin's scope, and `app.register()`
  // creates a fresh child scope, so a sibling route plugin would
  // otherwise fail to resolve `Error#`. Registering here makes shared
  // schemas + the swagger transformer visible to every later
  // `register(routesPlugin, { deps })` below.
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

  // Registration order matches the original `server.ts` so the
  // committed OpenAPI document (keyed off path-registration order)
  // diffs clean. `utxosRoutes` is intentionally sandwiched between
  // the tx-mutation routes (POST /submit, /evaluate) and the
  // tx-query routes (GET /tx/...) for the same reason.
  await fastify.register(healthRoutes, { deps });
  await fastify.register(paramsRoutes, { deps });
  await fastify.register(poolRoutes, { deps });
  await fastify.register(boxRoutes, { deps });
  await fastify.register(feeRoutes, { deps });
  await fastify.register(mempoolRoutes, { deps });
  await fastify.register(txMutationRoutes, { deps });
  await fastify.register(utxosRoutes, { deps });
  await fastify.register(txQueryRoutes, { deps });

  return fastify;
}
