// Structured-logging test for the Fastify pino integration (issue #99).
//
// Asserts that:
//   1. `buildServer` emits NO per-request access log for a routine 2xx
//      request — `c3b4506` set `disableRequestLogging: true` so a UI
//      pool scan (~one request per box) no longer drowns the log.
//   2. A route-handler error path emits an `error`-level record carrying
//      the `raw` upstream message and a route-tagged `msg`.
//
// We pipe a custom pino instance into Fastify, capture every record
// into an in-memory array, then drive the server via `inject`. This is
// the same pattern Fastify itself uses for logger tests.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import { Writable } from "node:stream";

import { buildServer } from "../src/api/server.js";
import type { BackendConfig, LovejoinAddresses } from "../src/config.js";
import { IndexerState } from "../src/indexer/state.js";

const ADDRESSES: LovejoinAddresses = {
  network: "preprod",
  protocol: { denom_lovelace: 10_000_000, max_fee_per_mix_lovelace: 800_000 },
  referenceNftPolicy: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  referenceNftAssetName: "6c6f76656a6f696e",
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
  corsOrigins: "*",
  rateLimitPerMin: 6000,
  addresses: ADDRESSES,
  derived: {
    mixBoxAddress: "addr_test1mix",
    feeContractAddress: "addr_test1fee",
    referenceHolderAddress: "addr_test1ref",
  },
  bootstrapStartPoint: null,
};

interface LogRecord {
  level: number;
  msg?: string;
  raw?: unknown;
  req?: { method: string; url: string };
  res?: { statusCode: number };
  err?: unknown;
  [k: string]: unknown;
}

function makeCapturingLogger(records: LogRecord[]): pino.Logger {
  const stream = new Writable({
    write(chunk, _enc, cb) {
      const text = chunk.toString("utf8").trim();
      if (text.length > 0) {
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            records.push(JSON.parse(line) as LogRecord);
          } catch {
            // pino can emit non-JSON during early init in some setups;
            // tests only care about JSON records so silently skip.
          }
        }
      }
      cb();
    },
  });
  return pino({ level: "info" }, stream);
}

let state: IndexerState;
beforeAll(async () => {
  state = new IndexerState(
    ADDRESSES,
    {
      mixBoxAddress: "addr_test1mix",
      feeContractAddress: "addr_test1fee",
      referenceNftUnit: ADDRESSES.referenceNftPolicy + ADDRESSES.referenceNftAssetName,
    },
    BigInt(ADDRESSES.protocol.max_fee_per_mix_lovelace),
  );
});

afterAll(async () => {});

describe("backend pino logger (issue #99)", () => {
  it("emits no per-request access log for a routine 2xx request (disableRequestLogging)", async () => {
    const records: LogRecord[] = [];
    const logger = makeCapturingLogger(records);
    const server = await buildServer({
      state,
      runtime: null,
      config: CONFIG,
      dbsync: null,
      logger,
    });
    try {
      const res = await server.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    } finally {
      await server.close();
    }
    // `c3b4506` set `disableRequestLogging: true`: a single UI pool scan
    // fans out to ~one request per box and Fastify's routine 2xx access
    // lines drowned the log. A successful /health request must emit NO
    // per-request "incoming request" / "request completed" record — the
    // only records carrying a `req`/`res` shape are those access lines.
    const accessLog = records.find((r) => r.req || r.res);
    expect(accessLog, JSON.stringify(records, null, 2)).toBeUndefined();
    // Whatever the logger does emit stays structured: JSON objects with
    // a numeric level, never raw `[prefix]` text lines.
    for (const r of records) {
      expect(typeof r.level).toBe("number");
    }
  });

  it("logs route-handler errors with the raw upstream message preserved server-side, while the client sees the redacted body", async () => {
    const records: LogRecord[] = [];
    const logger = makeCapturingLogger(records);
    const failingOgmios = {
      // Force /submit's catch branch. The upstream message contains a
      // websocket URL we expect to see redacted in the response body
      // but kept verbatim in the logged record.
      submitTransaction: async () => {
        throw new Error("ogmios websocket closed at ws://10.1.2.3:1337");
      },
      evaluateTransaction: async () => [],
      reconnecting: () => ({
        inProgress: false,
        attempts: 0,
        lastErrorAt: 0,
        lastErrorMessage: "",
        exhausted: false,
      }),
      close: () => {},
    };
    const server = await buildServer({
      state,
      runtime: null,
      config: CONFIG,
      dbsync: null,
      ogmiosTx: failingOgmios as never,
      logger,
    });
    try {
      const res = await server.inject({
        method: "POST",
        url: "/submit",
        payload: { cbor: "84a4" },
      });
      expect(res.statusCode).toBe(400);
      // Client body: redacted. The IPv4 host is gone (replaced by
      // `***` by `redactUpstreamMessage`); the protocol scheme is
      // preserved so the rejection still reads as "websocket-related".
      const body = res.json() as { error: string; message: string };
      expect(body.error).toBe("submit_failed");
      expect(body.message).not.toContain("10.1.2.3");
      expect(body.message).toMatch(/ws:\/\/\*\*\*/);
    } finally {
      await server.close();
    }
    // Server-side log: the raw, unredacted message. Operators rely on
    // this for triage; redaction lives only on the wire.
    const errorLog = records.find(
      (r) => r.level >= 50 && typeof r.msg === "string" && r.msg.includes("/submit"),
    );
    expect(errorLog).toBeDefined();
    expect(errorLog?.raw).toContain("ws://10.1.2.3:1337");
  });
});
