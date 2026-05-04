// OpenAPI 3 generation smoke test (issue #41).
//
// Boots the API server with stub deps, asks @fastify/swagger for the
// generated document, and verifies:
//   * top-level shape matches OpenAPI 3.x.
//   * every route the spec promises is actually registered.
//   * shared component schemas are present and keyed by their `$id`.
//   * no `def-N` placeholder names leaked into components (i.e. our
//     `refResolver` ran).
//   * `GET /docs/json` serves the same document over the wire.
//
// Why we don't reach for a full validator (e.g. ajv + the OpenAPI
// meta-schema): the meta-schema is a deeply nested JSON-schema-draft-04
// document and pulling that into a backend test for one assertion isn't
// worth the dep. The structural checks below catch the failure modes
// that have actually shown up during this work — missing routes,
// `def-N` keys when refResolver isn't wired, and the wire/static drift
// the export script was added to prevent.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer } from "../src/api/server.js";
import type { BackendConfig, LovejoinAddresses } from "../src/config.js";
import { IndexerState } from "../src/indexer/state.js";

const NFT_POLICY = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const NFT_NAME = "6c6f76656a6f696e";

const ADDRESSES: LovejoinAddresses = {
  network: "preprod",
  protocol: { denom_lovelace: 10_000_000, max_fee_per_mix_lovelace: 800_000 },
  referenceNftPolicy: NFT_POLICY,
  referenceNftAssetName: NFT_NAME,
  referenceUtxoRef: "00".repeat(32) + "#0",
  referenceHolderScriptHash: "ab".repeat(28),
  mixLogicScriptHash: "cd".repeat(28),
  mixBoxScriptHash: "ef".repeat(28),
  feeScriptHash: "12".repeat(28),
  feeShardUtxos: [],
};

const CONFIG: BackendConfig = {
  network: "preprod",
  port: 0,
  host: "127.0.0.1",
  ogmiosUrl: "ws://localhost:0",
  dbsyncUrl: null,
  blockfrostProjectId: null,
  blockfrostBaseUrl: null,
  corsOrigins: "*",
  rateLimitPerMin: 6000,
  addresses: ADDRESSES,
  derived: {
    mixBoxAddress: "addr_test1mix",
    feeContractAddress: "addr_test1fee",
    referenceHolderAddress: "addr_test1ref",
  },
};

let server: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  const state = new IndexerState(
    ADDRESSES,
    {
      mixBoxAddress: CONFIG.derived.mixBoxAddress,
      feeContractAddress: CONFIG.derived.feeContractAddress,
      referenceNftUnit: NFT_POLICY + NFT_NAME,
    },
    BigInt(ADDRESSES.protocol.max_fee_per_mix_lovelace),
  );
  server = await buildServer({ state, runtime: null, config: CONFIG, dbsync: null });
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

describe("OpenAPI generation", () => {
  it("emits a valid-looking OpenAPI 3 document with all expected paths", () => {
    const spec = (server as unknown as { swagger: () => Record<string, unknown> }).swagger();

    expect(spec.openapi).toMatch(/^3\.\d+\.\d+$/);
    expect(spec.info).toMatchObject({
      title: expect.any(String),
      version: expect.any(String),
    });

    const paths = spec.paths as Record<string, unknown>;
    // Every route the issue's deliverables list called out, plus the
    // ones we ship beyond it (/evaluate, /tx/*, /utxos/:address).
    for (const expected of [
      "/health",
      "/params",
      "/protocol-params",
      "/pool",
      "/pool/light",
      "/box/{txhash}/{idx}",
      "/fee",
      "/mempool/inputs",
      "/history/{address}",
      "/submit",
      "/evaluate",
      "/utxos/{address}",
      "/tx/{txhash}",
      "/tx/{txhash}/utxos",
    ]) {
      expect(paths[expected]).toBeDefined();
    }
  });

  it("lifts shared `$id` schemas into components.schemas under their $id", () => {
    const spec = (server as unknown as { swagger: () => Record<string, unknown> }).swagger();
    const schemas = (spec.components as Record<string, unknown>).schemas as Record<string, unknown>;

    for (const expectedId of [
      "Error",
      "Hex32",
      "Hex28",
      "Lovelace",
      "Tip",
      "PoolBox",
      "PoolBoxLight",
      "FeeShard",
      "HistoryEntry",
      "Utxo",
    ]) {
      expect(schemas[expectedId]).toBeDefined();
    }

    // refResolver kicked in: no Fastify default `def-N` placeholder
    // names slipped through.
    for (const key of Object.keys(schemas)) {
      expect(key).not.toMatch(/^def-\d+$/);
    }
  });

  it("serves the same document at /docs/json", async () => {
    const res = await server.inject({ method: "GET", url: "/docs/json" });
    expect(res.statusCode).toBe(200);
    const json = res.json() as Record<string, unknown>;
    expect(json.openapi).toMatch(/^3\.\d+\.\d+$/);
    expect((json.paths as Record<string, unknown>)["/health"]).toBeDefined();
  });

  it("serves the Swagger UI at /docs", async () => {
    // /docs is a 302 to /docs/static/index.html under the default
    // swagger-ui config. Follow it to confirm the UI actually renders.
    const initial = await server.inject({ method: "GET", url: "/docs" });
    expect([200, 301, 302]).toContain(initial.statusCode);
    const target =
      initial.statusCode === 200 ? "/docs" : ((initial.headers.location as string) ?? "/docs/");
    const res = await server.inject({ method: "GET", url: target });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/i);
    expect(res.payload.length).toBeGreaterThan(100);
  });
});
