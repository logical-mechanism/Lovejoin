// OpenAPI 3 schemas + per-route schema fragments for the public REST API.
//
// Why a sibling module: keeping these out of server.ts isolates the
// OpenAPI noise from the route-handler logic. The schemas here drive
// two things at once:
//
//   1. **Response validation.** Fastify's Ajv instance picks up each
//      `SHARED_SCHEMAS` entry via `fastify.addSchema()` (see server.ts).
//      Routes reference them with the Fastify-internal `$ref: "<id>#"`
//      form so Ajv resolves the target schema by `$id`.
//
//   2. **OpenAPI generation.** `@fastify/swagger` walks the same Ajv
//      registry and emits each schema under `components.schemas`,
//      rewriting `<id>#` refs to canonical `#/components/schemas/<id>`
//      in the generated OpenAPI 3 document.
//
// Conventions:
//   - lovelace amounts are decimal strings (the Fastify reply
//     serializer renders bigints as strings to keep precision; the
//     OpenAPI spec must match).
//   - hex32 = 64 lowercase hex chars (32-byte hash).
//   - hex28 = 56 lowercase hex chars (28-byte script / policy hash).
//   - error responses share the same `Error` schema across routes.

// We deliberately avoid importing types from `openapi-types` (the upstream
// type package shipped as a transitive dep by @fastify/swagger) — backend
// has no direct dep on it, and the schema fragments are JSON-schema-shaped
// objects that fastify accepts as plain `unknown` shapes anyway. The
// `JsonSchema` alias below is a lightweight stand-in.
type JsonSchema = Record<string, unknown>;
type RouteSchema = {
  summary?: string;
  description?: string;
  tags?: string[];
  params?: JsonSchema;
  querystring?: JsonSchema;
  body?: JsonSchema;
  response?: Record<string | number, JsonSchema | { $ref: string }>;
};

// ------------------------------------------------------------------
// OpenAPI top-level info block.
// ------------------------------------------------------------------

export const OPENAPI_INFO = {
  title: "Lovejoin Backend API",
  description:
    "Read-only chain-state API + tx submission/evaluation passthrough for the Lovejoin Sigmajoin protocol.\n\n" +
    "All routes return JSON. Lovelace amounts are encoded as decimal strings to preserve full bigint precision.\n\n" +
    "Authentication: none. Per-IP rate limit applied; tx routes (`/submit`, `/evaluate`) carry a tighter cap.",
  version: "0.4.0",
  license: { name: "MIT" },
} as const;

export const OPENAPI_TAGS = [
  { name: "health", description: "Liveness + indexer tip + chainsync state." },
  { name: "params", description: "Lovejoin protocol params + Cardano ledger params." },
  { name: "pool", description: "On-chain mix-box pool snapshot." },
  { name: "fee", description: "Sharded fee contract snapshot." },
  { name: "mempool", description: "Cardano-node mempool inputs (collision avoidance)." },
  { name: "tx", description: "Tx submission, evaluation, and resolution." },
  {
    name: "address",
    description:
      "Per-address UTxOs for the two protocol-managed addresses (mix-box, fee-contract), served from indexer state.",
  },
] as const;

// ------------------------------------------------------------------
// Shared schemas. Each carries an `$id` so Fastify's Ajv instance can
// resolve `<id>#` refs after `fastify.addSchema()` registers it.
// `@fastify/swagger` lifts every registered schema into the OpenAPI
// `components.schemas` block automatically.
// ------------------------------------------------------------------

const SHARED_SCHEMAS = [
  {
    $id: "Error",
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "string",
        description:
          "Machine-readable error code (e.g. `bad_request`, `not_found`, `submit_failed`).",
      },
      message: { type: "string", description: "Human-readable, redacted message." },
    },
  },
  {
    $id: "Hex32",
    type: "string",
    pattern: "^[0-9a-f]{64}$",
    description: "Lowercase hex, 32 bytes (e.g. tx hash).",
  },
  {
    $id: "Hex28",
    type: "string",
    pattern: "^[0-9a-f]{56}$",
    description: "Lowercase hex, 28 bytes (e.g. script / policy hash).",
  },
  {
    $id: "HexBytes",
    type: "string",
    pattern: "^[0-9a-f]+$",
    description: "Lowercase hex string (variable length).",
  },
  {
    $id: "Lovelace",
    type: "string",
    pattern: "^[0-9]+$",
    description: "Lovelace amount as a decimal string.",
  },
  {
    $id: "Tip",
    type: "object",
    nullable: true,
    properties: {
      slot: { type: "integer" },
      blockHash: { $ref: "Hex32#" },
    },
    required: ["slot", "blockHash"],
  },
  {
    $id: "UtxoRef",
    type: "object",
    required: ["txHash", "outputIndex"],
    properties: {
      txHash: { $ref: "Hex32#" },
      outputIndex: { type: "integer", minimum: 0 },
    },
  },
  {
    $id: "PoolBox",
    type: "object",
    required: ["txHash", "outputIndex", "a", "b"],
    properties: {
      txHash: { $ref: "Hex32#" },
      outputIndex: { type: "integer", minimum: 0 },
      a: {
        type: "string",
        pattern: "^[0-9a-f]{96}$",
        description: "Compressed G1 element (48 bytes hex).",
      },
      b: {
        type: "string",
        pattern: "^[0-9a-f]{96}$",
        description: "Compressed G1 element (48 bytes hex).",
      },
      generation: {
        type: "integer",
        minimum: 0,
        description: "Mix-round counter (0 = freshly deposited; +1 per Mix tx).",
      },
      createdSlot: { type: "integer", description: "Slot the box was last produced at." },
    },
  },
  {
    $id: "PoolBoxLight",
    type: "object",
    required: ["txHash", "outputIndex", "a", "b"],
    properties: {
      txHash: { $ref: "Hex32#" },
      outputIndex: { type: "integer", minimum: 0 },
      a: { type: "string", pattern: "^[0-9a-f]{96}$" },
      b: { type: "string", pattern: "^[0-9a-f]{96}$" },
    },
  },
  {
    $id: "FeeShard",
    type: "object",
    required: ["txHash", "outputIndex", "lovelace"],
    properties: {
      txHash: { $ref: "Hex32#" },
      outputIndex: { type: "integer", minimum: 0 },
      lovelace: { $ref: "Lovelace#" },
    },
  },
  {
    $id: "Utxo",
    type: "object",
    required: [
      "txHash",
      "outputIndex",
      "address",
      "lovelace",
      "assets",
      "inlineDatum",
      "datumHash",
      "referenceScriptCbor",
      "referenceScriptHash",
    ],
    properties: {
      txHash: { $ref: "Hex32#" },
      outputIndex: { type: "integer", minimum: 0 },
      address: { type: "string", description: "Bech32 Cardano address." },
      lovelace: { $ref: "Lovelace#" },
      assets: {
        type: "object",
        additionalProperties: {
          type: "string",
          description: "Quantity as decimal string.",
        },
        description: "Native assets keyed by `<policy_id><asset_name_hex>`.",
      },
      inlineDatum: {
        type: "string",
        nullable: true,
        description: "CBOR hex of inline datum, or null.",
      },
      datumHash: { type: "string", nullable: true },
      referenceScriptCbor: { type: "string", nullable: true },
      referenceScriptHash: { type: "string", nullable: true },
    },
  },
] as const satisfies ReadonlyArray<JsonSchema & { $id: string }>;

export const SHARED_OPENAPI_SCHEMAS: ReadonlyArray<JsonSchema & { $id: string }> = SHARED_SCHEMAS;

// ------------------------------------------------------------------
// Per-route schema fragments. Server.ts attaches these via
// `{ schema: ROUTE_SCHEMAS.health, ... }` so swagger generates the
// spec from a single source.
// ------------------------------------------------------------------

const ERROR_REF = { $ref: "Error#" };

// Named-key map so each access (`ROUTE_SCHEMAS.health`) returns `RouteSchema`
// — not `RouteSchema | undefined` — under `noUncheckedIndexedAccess`. The
// `satisfies` clause type-checks the structure while preserving literal
// property names on the return type.
export const ROUTE_SCHEMAS = {
  health: {
    summary: "Indexer + chainsync health",
    description:
      "Returns indexer tip vs chain tip, runtime status, reference-UTxO health, chainsync reconnect state, and indexer origin (whether state was bulk-primed from db-sync at cold start or replayed forward from chainsync).\n\n" +
      "HTTP 503 only when the runtime has hit a *fatal* error (chainsync gone after exhausting reconnects). Transient reconnect attempts keep returning 200 so the cached `/params`, `/pool`, `/box/*`, `/fee` surfaces stay live.",
    tags: ["health"],
  },

  params: {
    summary: "Lovejoin protocol params",
    description:
      "Static protocol identifiers + denominations read from the on-chain reference UTxO. Distinct from `/protocol-params` (Cardano ledger params).",
    tags: ["params"],
  },

  protocolParams: {
    summary: "Cardano ledger protocol params",
    description:
      "Live ogmios `queryLedgerState` snapshot of the current Cardano protocol parameters (fee coefficients, max tx size, ex-units budgets, cost models). Used by SDK fee calculation. Body is the ogmios v6 protocol-parameters object passed through verbatim.",
    tags: ["params"],
    response: {
      502: ERROR_REF,
      503: ERROR_REF,
    },
  },

  pool: {
    summary: "Mix-box pool snapshot",
    description:
      "Paginated list of all live mix-boxes at the `mix_box` validator address.\n\n" +
      "Query parameters:\n" +
      "- `cursor` (integer, default 0) — page offset.\n" +
      "- `limit` (integer, 1..1000, default 500) — page size.\n\n" +
      "Querystring intentionally lacks a Fastify schema: this route is the perf-critical hot path " +
      "(50k-box load test, p99 < 100ms) and Ajv compile time per request adds up. The handler " +
      "clamps both fields defensively, so nothing slips through.",
    tags: ["pool"],
  },

  poolLight: {
    summary: "Mix-box pool snapshot (minimal)",
    description:
      "Same pagination as `/pool`, but each box only carries `(txHash, outputIndex, a, b)` — enough for browser-side ownership scan, half the bytes on the wire.\n\n" +
      "Query parameters: same `cursor` + `limit` as `/pool`. Schema-less for the same hot-path reason.",
    tags: ["pool"],
  },

  box: {
    summary: "Single mix-box by reference",
    description:
      "Lookup a single mix-box by `(txhash, idx)`. Returns 404 if the box is not in the live pool (consumed, never produced, or not yet indexed).",
    tags: ["pool"],
    params: {
      type: "object",
      required: ["txhash", "idx"],
      properties: {
        txhash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        idx: { type: "string", pattern: "^[0-9]+$" },
      },
    },
    response: {
      200: { $ref: "PoolBox#" },
      400: ERROR_REF,
      404: ERROR_REF,
    },
  },

  fee: {
    summary: "Fee shard snapshot",
    description:
      "Live snapshot of the 10-shard fee contract. SDK + UI pick a shard uniformly at random for concurrency. `estimatedMixesAvailable` is a coarse `totalLovelace / maxFeePerMix` projection.",
    tags: ["fee"],
  },

  mempool: {
    summary: "Cardano-node mempool inputs",
    description:
      "Union of every input ref currently in the cardano-node mempool. SDK passes these as `excludeRefs` when picking a fee shard or pool box, eliminating most BadInputsUTxO collisions.\n\n" +
      "Returns an empty snapshot when the mempool poller is unconfigured or the first poll hasn't completed.",
    tags: ["mempool"],
  },

  submit: {
    summary: "Submit a signed tx",
    description:
      "Forwards a hex-encoded CBOR transaction to ogmios for submission. Returns the resulting tx hash on success. On ledger rejection the upstream message is forwarded back to the client (with infrastructure topology redacted).\n\n" +
      "Body must be a non-empty even-length hex string within the 64 KiB cap.",
    tags: ["tx"],
    body: {
      type: "object",
      required: ["cbor"],
      properties: {
        cbor: {
          type: "string",
          pattern: "^[0-9a-fA-F]+$",
          description: "Hex-encoded CBOR transaction.",
        },
      },
    },
    response: {
      400: ERROR_REF,
      503: ERROR_REF,
    },
  },

  evaluate: {
    summary: "Evaluate a tx (script ex-units)",
    description:
      "Forwards the tx to ogmios `EvaluateTransaction`. Returns per-redeemer ex-units. Used by the SDK during Mix tx construction so the actual costs are folded into the fee. Optional `additionalUtxoSet` carries `[txin, txout]` pairs spliced into the evaluator's view of the chain (Ogmios v6 `additionalUtxo`) so callers can evaluate a tx that references the unconfirmed outputs of an in-flight parent.",
    tags: ["tx"],
    body: {
      type: "object",
      required: ["cbor"],
      properties: {
        cbor: { type: "string", pattern: "^[0-9a-fA-F]+$" },
        additionalUtxoSet: {
          type: "array",
          description:
            "Optional in-flight `[txin, txout]` pairs in Ogmios v6 shape; forwarded verbatim to ogmios as `evaluateTransaction.additionalUtxo`. Missing or empty is fine.",
          items: { type: "array" },
        },
      },
    },
    response: {
      400: ERROR_REF,
      503: ERROR_REF,
    },
  },

  addressUtxos: {
    summary: "UTxOs at a protocol-managed address",
    description:
      "Live UTxOs at the mix-box or fee-contract address, served from in-memory indexer state. Any other address returns 400 `address_not_protocol_managed` — the route is allowlisted to the two SDK call sites (`fetchPool` and the fee-shard fetch).",
    tags: ["address"],
    params: {
      type: "object",
      required: ["address"],
      properties: { address: { type: "string" } },
    },
    response: {
      400: ERROR_REF,
    },
  },

  txSummary: {
    summary: "Tx confirmation summary",
    description:
      "Returns block height, block hash, and slot for the given tx hash. 404 before the tx is on-chain (used by the SDK `awaitConfirmation` polling loop).",
    tags: ["tx"],
    params: {
      type: "object",
      required: ["txhash"],
      properties: { txhash: { type: "string", pattern: "^[0-9a-f]{64}$" } },
    },
    response: {
      400: ERROR_REF,
      404: ERROR_REF,
      502: ERROR_REF,
      503: ERROR_REF,
    },
  },

  txUtxos: {
    summary: "UTxOs produced by a tx",
    description: "Outputs of the given tx. 404 when the tx is not on-chain.",
    tags: ["tx"],
    params: {
      type: "object",
      required: ["txhash"],
      properties: { txhash: { type: "string", pattern: "^[0-9a-f]{64}$" } },
    },
    response: {
      400: ERROR_REF,
      404: ERROR_REF,
      502: ERROR_REF,
      503: ERROR_REF,
    },
  },
} satisfies Record<string, RouteSchema>;
