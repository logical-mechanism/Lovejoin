// Load test — `/pool` with 50k boxes must respond at p99 < 100ms.
//
// Spec exit criterion (M5 in milestones.json): "Load test exists and
// passes" via `pnpm --filter backend test -- load`. We seed the
// in-memory IndexerState with 50,000 valid mix-boxes and hit `/pool` a
// hundred times; the slowest 1% must finish in under 100ms each.
//
// We don't measure JSON-over-the-wire — Fastify's `inject` API runs the
// route handler in-process which is the same code path that would run
// behind the real HTTP server, minus socket I/O. Socket I/O is far
// less than 100ms locally so the budget is comfortable.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer } from "../src/api/server.js";
import type { BackendConfig, LovejoinAddresses } from "../src/config.js";
import { IndexerState } from "../src/indexer/state.js";
import type { ProducedUtxo } from "../src/indexer/types.js";
import { encodeMixDatumDef } from "./helpers/datum.js";

const POOL_SIZE = 50_000;
/** How many requests to send when measuring. Keep modest so the
 * overall test stays well under the vitest timeout. */
const REQUESTS = 100;
const PAGE_LIMIT = 500;
const P99_BUDGET_MS = 100;

const MIX_ADDR = "addr_test1mix";
const FEE_ADDR = "addr_test1fee";
const NFT_POLICY = "deadbeef".repeat(7);
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
  corsOrigins: "*",
  rateLimitPerMin: 60_000, // never trip during the load test
  addresses: ADDRESSES,
  derived: {
    mixBoxAddress: MIX_ADDR,
    feeContractAddress: FEE_ADDR,
    referenceHolderAddress: "addr_test1ref",
  },
};

let state: IndexerState;
let server: Awaited<ReturnType<typeof buildServer>>;

function bytes48(seed: number): Uint8Array {
  const out = new Uint8Array(48);
  for (let i = 0; i < 48; i++) out[i] = (seed * 7 + i) & 0xff;
  return out;
}

function txHashFor(seed: number): string {
  // Deterministic 64-char hex unique per seed: encode the seed as two
  // big-endian 4-byte chunks at fixed positions (covers up to 2^31
  // unique values comfortably; we're well under that).
  const seedHex = (seed >>> 0).toString(16).padStart(8, "0");
  return seedHex + "00".repeat(28);
}

function mixBoxOutput(seed: number): ProducedUtxo {
  return {
    ref: { txId: txHashFor(seed), outputIndex: 0 },
    address: MIX_ADDR,
    lovelace: 10_000_000n,
    inlineDatumHex: encodeMixDatumDef(bytes48(seed * 2 + 1), bytes48(seed * 2 + 2)),
    assets: {},
  };
}

beforeAll(async () => {
  state = new IndexerState(
    ADDRESSES,
    {
      mixBoxAddress: MIX_ADDR,
      feeContractAddress: FEE_ADDR,
      referenceNftUnit: NFT_POLICY + NFT_NAME,
    },
    BigInt(ADDRESSES.protocol.max_fee_per_mix_lovelace),
  );
  // 50 blocks of 1000 boxes each — keeps the rollback buffer light.
  const PER_BLOCK = 1000;
  for (let block = 0; block < POOL_SIZE / PER_BLOCK; block++) {
    const produced: ProducedUtxo[] = [];
    for (let i = 0; i < PER_BLOCK; i++) {
      produced.push(mixBoxOutput(block * PER_BLOCK + i));
    }
    state.applyForward({
      slot: block * 20,
      blockHash: txHashFor(block * 1000 + 99),
      height: block + 1,
      consumed: [],
      produced,
    });
  }
  expect(state.poolSize()).toBe(POOL_SIZE);
  server = await buildServer({ state, runtime: null, config: CONFIG, dbsync: null });
}, 60_000);

afterAll(async () => {
  await server.close();
});

describe("load: /pool with 50k boxes", () => {
  it(`p99 latency under ${P99_BUDGET_MS}ms across ${REQUESTS} requests`, async () => {
    const samples: number[] = [];
    // Walk through pages so each request loads a different cursor —
    // mirrors the realistic UI scan pattern.
    let cursor = 0;
    for (let i = 0; i < REQUESTS; i++) {
      const start = performance.now();
      const res = await server.inject({
        method: "GET",
        url: `/pool?limit=${PAGE_LIMIT}&cursor=${cursor}`,
      });
      const elapsed = performance.now() - start;
      samples.push(elapsed);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      cursor = body.nextCursor ?? 0;
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)];
    const p99 = samples[Math.floor(samples.length * 0.99)];
    const max = samples[samples.length - 1];

    console.log(
      `[/pool load] N=${POOL_SIZE} requests=${REQUESTS} pageLimit=${PAGE_LIMIT}: ` +
        `p50=${p50?.toFixed(2)}ms p99=${p99?.toFixed(2)}ms max=${max?.toFixed(2)}ms`,
    );
    expect(p99).toBeLessThan(P99_BUDGET_MS);
  }, 60_000);

  it(`/pool/light p99 under ${P99_BUDGET_MS}ms`, async () => {
    const samples: number[] = [];
    let cursor = 0;
    for (let i = 0; i < REQUESTS; i++) {
      const start = performance.now();
      const res = await server.inject({
        method: "GET",
        url: `/pool/light?limit=${PAGE_LIMIT}&cursor=${cursor}`,
      });
      const elapsed = performance.now() - start;
      samples.push(elapsed);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      cursor = body.nextCursor ?? 0;
    }
    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(samples.length * 0.99)];
    expect(p99).toBeLessThan(P99_BUDGET_MS);
  }, 60_000);
});
