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
  protocol: { denom_lovelace: 10_000_000, max_fee_per_mix_lovelace: 800_000, fee_shard_target: 10 },
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
  it("returns ok=true with tip + lag", async () => {
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.tip.slot).toBe(110);
    expect(body.referenceUtxoOk).toBe(true);
    expect(body.lagSeconds).toBe(200 - 110);
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
    expect(body.feeShardTarget).toBe(10);
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

describe("API: /history/:address", () => {
  it("returns the stub history", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/history/addr_test1bob?limit=10",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.address).toBe("addr_test1bob");
    expect(body.history).toHaveLength(1);
    expect(body.history[0].lovelaceReceived).toBe("10000000");
  });
});
