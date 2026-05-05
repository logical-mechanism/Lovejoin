// OpenAPI 3 docs (issue #41). The schema is generated from the
// per-route Fastify schemas attached on each route plugin; `/docs`
// serves the Swagger UI, `/docs/json` returns the raw OpenAPI 3
// document used by the `docs:openapi` export script for client
// codegen.
//
// Wrapped with `fastify-plugin` so this plugin does NOT create its
// own encapsulation context: the shared `addSchema` calls and the
// `swagger` / `swaggerUi` registrations inside need to be visible
// to sibling route plugins (otherwise their `Error#` refs fail to
// resolve at registration time, and `app.swagger()` is undefined on
// the root instance). `@fastify/swagger` itself is fp-wrapped for
// the same reason.

import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

import { OPENAPI_INFO, OPENAPI_TAGS, SHARED_OPENAPI_SCHEMAS } from "../openapi-schemas.js";

const openapiPlugin: FastifyPluginAsync = async (app) => {
  for (const schema of SHARED_OPENAPI_SCHEMAS) {
    app.addSchema(schema);
  }
  await app.register(swagger, {
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
  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: true },
    staticCSP: true,
  });
};

export default fp(openapiPlugin, { name: "lovejoin-openapi" });
