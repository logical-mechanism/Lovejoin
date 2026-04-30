// Fastify API integration test. Drives the server against an in-memory
// IndexerState so the route logic is exercised end-to-end (URL routing,
// pagination, JSON serialisation of bigints, alarm degradation,
// rate-limit registration) without needing ogmios or postgres.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer } from "../src/api/server.js";
import type { BackendConfig, LovejoinAddresses } from "../src/config.js";
import { StubDbSyncClient } from "../src/db/dbsync.js";
import { IndexerState } from "../src/indexer/state.js";
import type { ProducedUtxo } from "../src/indexer/types.js";
import { encodeMixDatumDef } from "./helpers/datum.js";

const MIX_ADDR = "addr_test1mix";
const FEE_ADDR = "addr_test1fee";
const NFT_POLICY = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const NFT_NAME = "6c6f76656a6f696e";
const NFT_UNIT = NFT_POLICY + NFT_NAME;

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
  rateLimitPerMin: 6000, // generous so test calls don't trip rate limit
  addresses: ADDRESSES,
  derived: {
    mixBoxAddress: MIX_ADDR,
    feeContractAddress: FEE_ADDR,
    referenceHolderAddress: "addr_test1ref",
  },
};

function bytes48(seed: number): Uint8Array {
  const out = new Uint8Array(48);
  for (let i = 0; i < 48; i++) out[i] = (seed * 7 + i) & 0xff;
  return out;
}

function txHash(seed: string): string {
  let s = "";
  for (let i = 0; i < 32; i++)
    s += ((seed.charCodeAt(i % seed.length) + i) % 256).toString(16).padStart(2, "0");
  return s;
}

function mixBoxOutput(txId: string, index: number, a: number, b: number): ProducedUtxo {
  return {
    ref: { txId, outputIndex: index },
    address: MIX_ADDR,
    lovelace: 10_000_000n,
    inlineDatumHex: encodeMixDatumDef(bytes48(a), bytes48(b)),
    assets: {},
  };
}

function feeOutput(txId: string, index: number, lovelace: bigint): ProducedUtxo {
  return {
    ref: { txId, outputIndex: index },
    address: FEE_ADDR,
    lovelace,
    inlineDatumHex: "d87980",
    assets: {},
  };
}

function referenceOutput(txId: string): ProducedUtxo {
  return {
    ref: { txId, outputIndex: 0 },
    address: "addr_test1ref",
    lovelace: 5_000_000n,
    inlineDatumHex: null,
    assets: { [NFT_UNIT]: 1n },
  };
}

let state: IndexerState;
let server: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  state = new IndexerState(
    ADDRESSES,
    {
      mixBoxAddress: MIX_ADDR,
      feeContractAddress: FEE_ADDR,
      referenceNftUnit: NFT_UNIT,
    },
    BigInt(ADDRESSES.protocol.max_fee_per_mix_lovelace),
  );
  const dbsync = new StubDbSyncClient({
    addr_test1bob: [
      {
        txHash: txHash("hist1"),
        blockHeight: 100,
        blockTime: "2026-04-25T12:00:00.000Z",
        lovelaceReceived: 10_000_000n,
      },
    ],
  });
  // Seed: 5 deposits, 2 fee shards, 1 reference UTxO.
  state.applyForward({
    slot: 100,
    blockHash: txHash("blk-100"),
    height: 1,
    consumed: [],
    produced: [
      mixBoxOutput(txHash("d1"), 0, 1, 2),
      mixBoxOutput(txHash("d2"), 0, 3, 4),
      mixBoxOutput(txHash("d3"), 0, 5, 6),
      feeOutput(txHash("f1"), 0, 5_000_000n),
      feeOutput(txHash("f2"), 0, 3_000_000n),
      referenceOutput(txHash("ref1")),
    ],
  });
  state.applyForward({
    slot: 110,
    blockHash: txHash("blk-110"),
    height: 2,
    consumed: [],
    produced: [
      mixBoxOutput(txHash("d4"), 0, 7, 8),
      mixBoxOutput(txHash("d5"), 0, 9, 10),
    ],
  });

  server = await buildServer({
    state,
    runtime: null,
    config: CONFIG,
    dbsync,
    nowMs: () => 200_000, // pinned so /health lagSeconds is deterministic
  });
});

afterAll(async () => {
  await server.close();
});

describe("API: /health", () => {
  it("returns ok=true with tip; lag is null when there's no chainTip", async () => {
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.tip.slot).toBe(110);
    expect(body.referenceUtxoOk).toBe(true);
    // No runtime is passed in this test (we drive state directly), so
    // the runtime's chainTip() is null and lag is undeterminable.
    expect(body.lagSeconds).toBeNull();
    expect(body.chainTip).toBeNull();
  });

  it("returns 503 when the indexer runtime has a fatal error so DO restarts the container", async () => {
    // Synthetic runtime stub: only fatalError() needs to be truthy for
    // the unhealthy branch. chainTip() / isRunning() round out the
    // shape the route reads.
    const fatal = new Error("ogmios connection lost");
    const errored = await buildServer({
      state,
      runtime: {
        chainTip: () => null,
        isRunning: () => false,
        fatalError: () => fatal,
        // Untyped extras: the route doesn't read them but the type
        // wants the full shape. Cast through any to keep the test
        // narrow.
      } as unknown as Parameters<typeof buildServer>[0]["runtime"],
      config: CONFIG,
      dbsync: null,
    });
    try {
      const res = await errored.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.ok).toBe(false);
      expect(body.runtimeError).toBe("ogmios connection lost");
    } finally {
      await errored.close();
    }
  });
});

describe("API: /params", () => {
  it("returns the protocol params from the cached reference UTxO", async () => {
    const res = await server.inject({ method: "GET", url: "/params" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.network).toBe("preprod");
    expect(body.denomLovelace).toBe("10000000");
    expect(body.maxFeePerMix).toBe("800000");
    expect(body.mixScriptAddress).toBe(MIX_ADDR);
    expect(body.feeScriptAddress).toBe(FEE_ADDR);
    expect(body.referenceNft.policyId).toBe(NFT_POLICY);
  });

  it("degrades to 503 when the reference UTxO alarm is set", async () => {
    state.applyForward({
      slot: 120,
      blockHash: txHash("blk-120"),
      height: 3,
      consumed: [{ txId: txHash("ref1"), outputIndex: 0 }],
      produced: [],
    });
    const res = await server.inject({ method: "GET", url: "/params" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error).toBe("reference_utxo_alarm");
    // restore for subsequent tests
    state.applyForward({
      slot: 130,
      blockHash: txHash("blk-130"),
      height: 4,
      consumed: [],
      produced: [referenceOutput(txHash("ref2"))],
    });
  });
});

describe("API: /pool", () => {
  it("paginates", async () => {
    const r1 = await server.inject({ method: "GET", url: "/pool?limit=2&cursor=0" });
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json();
    expect(b1.size).toBe(5);
    expect(b1.boxes).toHaveLength(2);
    expect(b1.nextCursor).toBe(2);

    const r2 = await server.inject({ method: "GET", url: `/pool?limit=2&cursor=${b1.nextCursor}` });
    const b2 = r2.json();
    expect(b2.boxes).toHaveLength(2);
    expect(b2.nextCursor).toBe(4);

    const r3 = await server.inject({ method: "GET", url: `/pool?limit=2&cursor=${b2.nextCursor}` });
    const b3 = r3.json();
    expect(b3.boxes).toHaveLength(1);
    expect(b3.nextCursor).toBeNull();
  });

  it("light variant omits generation + slot", async () => {
    const res = await server.inject({ method: "GET", url: "/pool/light?limit=1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.boxes[0]).toEqual(
      expect.objectContaining({ txHash: expect.any(String), a: expect.any(String) }),
    );
    expect(body.boxes[0].generation).toBeUndefined();
    expect(body.boxes[0].createdSlot).toBeUndefined();
  });
});

describe("API: /box/:txhash/:idx", () => {
  it("404s on unknown box", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/box/${"00".repeat(32)}/0`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects bad hex", async () => {
    const res = await server.inject({ method: "GET", url: "/box/notaHash/0" });
    expect(res.statusCode).toBe(400);
  });

  it("returns box details", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/box/${txHash("d1")}/0`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.txHash).toBe(txHash("d1"));
    expect(body.outputIndex).toBe(0);
    expect(body.generation).toBe(0);
    expect(body.a).toMatch(/^[0-9a-f]{96}$/);
  });
});

describe("API: /fee", () => {
  it("returns shards + total + estimated", async () => {
    const res = await server.inject({ method: "GET", url: "/fee" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.shardCount).toBe(2);
    expect(body.totalLovelace).toBe("8000000");
    expect(body.estimatedMixesAvailable).toBe(Math.floor(8_000_000 / 800_000));
    expect(body.maxFeePerMix).toBe("800000");
    expect(body.shards).toHaveLength(2);
    expect(body.shards[0].lovelace).toBeTypeOf("string");
  });
});

describe("API: /mempool/inputs", () => {
  it("returns an empty snapshot when no poller is wired", async () => {
    const res = await server.inject({ method: "GET", url: "/mempool/inputs" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.acquiredAtMs).toBe(0);
    expect(body.txCount).toBe(0);
    expect(body.inputs).toEqual([]);
  });

  it("surfaces the snapshot when a poller is wired", async () => {
    const stubPoller = {
      snapshot: () => ({
        slot: 12345,
        acquiredAtMs: 100_000,
        inputs: new Set([
          `${"aa".repeat(32)}#0`,
          `${"bb".repeat(32)}#3`,
        ]),
        txCount: 2,
      }),
    };
    const local = await buildServer({
      state,
      runtime: null,
      config: CONFIG,
      dbsync: new StubDbSyncClient({}),
      mempoolPoller: stubPoller as never,
      nowMs: () => 102_500,
    });
    try {
      const res = await local.inject({ method: "GET", url: "/mempool/inputs" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.slot).toBe(12345);
      expect(body.acquiredAtMs).toBe(100_000);
      expect(body.ageMs).toBe(2500);
      expect(body.txCount).toBe(2);
      expect(body.inputs).toHaveLength(2);
      const refs = body.inputs.map((r: { txHash: string; outputIndex: number }) =>
        `${r.txHash}#${r.outputIndex}`,
      );
      expect(refs).toContain(`${"aa".repeat(32)}#0`);
      expect(refs).toContain(`${"bb".repeat(32)}#3`);
    } finally {
      await local.close();
    }
  });
});

describe("API: /history/:address", () => {
  it("returns the stub history with source=dbsync", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/history/addr_test1bob?limit=10",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.address).toBe("addr_test1bob");
    expect(body.source).toBe("dbsync");
    expect(body.history).toHaveLength(1);
    expect(body.history[0].lovelaceReceived).toBe("10000000");
  });
});

describe("API: /history fallback to Blockfrost", () => {
  it("uses the fallback when db-sync is null", async () => {
    const fallback = new StubDbSyncClient({
      addr_test1bob: [
        {
          txHash: txHash("bf1"),
          blockHeight: 200,
          blockTime: "2026-04-26T08:00:00.000Z",
          lovelaceReceived: 4_500_000n,
        },
      ],
    });
    const fallbackOnlyServer = await buildServer({
      state,
      runtime: null,
      config: CONFIG,
      dbsync: null,
      historyFallback: fallback,
    });
    const res = await fallbackOnlyServer.inject({
      method: "GET",
      url: "/history/addr_test1bob?limit=5",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe("blockfrost");
    expect(body.history[0].lovelaceReceived).toBe("4500000");
    await fallbackOnlyServer.close();
  });

  it("falls back to Blockfrost when db-sync throws", async () => {
    const throwingDbsync = {
      async addressHistory() {
        throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
      },
      async ping() {},
      async close() {},
    };
    const fallback = new StubDbSyncClient({
      addr_test1bob: [
        {
          txHash: txHash("bf2"),
          blockHeight: 201,
          blockTime: "2026-04-26T09:00:00.000Z",
          lovelaceReceived: 1_000_000n,
        },
      ],
    });
    const failoverServer = await buildServer({
      state,
      runtime: null,
      config: CONFIG,
      dbsync: throwingDbsync,
      historyFallback: fallback,
    });
    const res = await failoverServer.inject({
      method: "GET",
      url: "/history/addr_test1bob?limit=5",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe("blockfrost");
    expect(body.history[0].lovelaceReceived).toBe("1000000");
    await failoverServer.close();
  });

  it("returns 503 when neither source is configured", async () => {
    const noBackendsServer = await buildServer({
      state,
      runtime: null,
      config: CONFIG,
      dbsync: null,
    });
    const res = await noBackendsServer.inject({
      method: "GET",
      url: "/history/addr_test1bob?limit=5",
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("history_unavailable");
    await noBackendsServer.close();
  });
});

describe("API: /submit + /evaluate", () => {
  it("/submit relays cbor to ogmios and returns the txid", async () => {
    const stub = {
      submitTransaction: async (cbor: string) => {
        expect(cbor).toBe("84a4");
        return "ab".repeat(32);
      },
      evaluateTransaction: async () => [],
      close: () => {},
    };
    const s = await buildServer({
      state,
      runtime: null,
      config: CONFIG,
      dbsync: null,
      ogmiosTx: stub as never,
    });
    const res = await s.inject({
      method: "POST",
      url: "/submit",
      payload: { cbor: "84a4" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ txHash: "ab".repeat(32) });
    await s.close();
  });

  it("/submit returns 400 with the ogmios error message when ogmios rejects", async () => {
    const stub = {
      submitTransaction: async () => {
        throw new Error("ogmios JSON-RPC error 3122: ScriptExecutionFailure");
      },
      evaluateTransaction: async () => [],
      close: () => {},
    };
    const s = await buildServer({
      state,
      runtime: null,
      config: CONFIG,
      dbsync: null,
      ogmiosTx: stub as never,
    });
    const res = await s.inject({
      method: "POST",
      url: "/submit",
      payload: { cbor: "deadbeef" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("submit_failed");
    expect(res.json().message).toContain("ScriptExecutionFailure");
    await s.close();
  });

  it("/submit returns 400 on malformed cbor", async () => {
    const stub = {
      submitTransaction: async () => "00".repeat(32),
      evaluateTransaction: async () => [],
      close: () => {},
    };
    const s = await buildServer({
      state,
      runtime: null,
      config: CONFIG,
      dbsync: null,
      ogmiosTx: stub as never,
    });
    const res = await s.inject({
      method: "POST",
      url: "/submit",
      payload: { cbor: "not-hex" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("bad_request");
    await s.close();
  });

  it("/evaluate passes through the redeemer-budget array verbatim", async () => {
    const budgets = [
      { validator: { purpose: "spend", index: 0 }, budget: { memory: 1234, cpu: 56789 } },
    ];
    const stub = {
      submitTransaction: async () => "00".repeat(32),
      evaluateTransaction: async (cbor: string) => {
        expect(cbor).toBe("84a4");
        return budgets;
      },
      close: () => {},
    };
    const s = await buildServer({
      state,
      runtime: null,
      config: CONFIG,
      dbsync: null,
      ogmiosTx: stub as never,
    });
    const res = await s.inject({
      method: "POST",
      url: "/evaluate",
      payload: { cbor: "84a4" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ redeemers: budgets });
    await s.close();
  });

  it("/submit returns 503 when no ogmiosTx is configured", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/submit",
      payload: { cbor: "84a4" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("submit_unavailable");
  });
});
