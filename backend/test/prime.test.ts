// Cold-start / reprime orchestrator (issue #87).
//
// Drives `primeFromDbSync` against `StubDbSyncClient` so the seam
// between db-sync's UTxO shape and the indexer's `PrimeSnapshot` is
// exercised end-to-end without standing up postgres.

import { describe, expect, it } from "vitest";

import { encodeMixDatumDef } from "./helpers/datum.js";
import type { LovejoinAddresses } from "../src/config.js";
import { StubDbSyncClient, type DbSyncUtxo } from "../src/db/dbsync.js";
import { primeFromDbSync } from "../src/indexer/prime.js";
import { IndexerState, type AddressFilter } from "../src/indexer/state.js";

const MIX_ADDR = "addr_test1mix-prime";
const FEE_ADDR = "addr_test1fee-prime";
const REF_ADDR = "addr_test1ref-prime";
const NFT_POLICY = "deadbeef".repeat(7); // 56 hex (28 bytes)
const NFT_ASSET = "6c6f76656a6f696e";
const NFT_UNIT = NFT_POLICY + NFT_ASSET;

const FILTER: AddressFilter = {
  mixBoxAddress: MIX_ADDR,
  feeContractAddress: FEE_ADDR,
  referenceNftUnit: NFT_UNIT,
};

const ADDRESSES: LovejoinAddresses = {
  network: "preprod",
  protocol: { denom_lovelace: 10_000_000, max_fee_per_mix_lovelace: 800_000 },
  referenceNftPolicy: NFT_POLICY,
  referenceNftAssetName: NFT_ASSET,
  referenceUtxoRef: "00".repeat(32) + "#0",
  referenceHolderScriptHash: "ab".repeat(28),
  mixLogicScriptHash: "cd".repeat(28),
  mixBoxScriptHash: "ef".repeat(28),
  feeScriptHash: "12".repeat(28),
  feeShardUtxos: [],
};

const PRIME_PARAMS = {
  mixBoxAddress: MIX_ADDR,
  feeContractAddress: FEE_ADDR,
  referenceNftPolicyHex: NFT_POLICY,
  referenceNftAssetNameHex: NFT_ASSET,
};

function bytes48(seed: number): Uint8Array {
  const out = new Uint8Array(48);
  for (let i = 0; i < 48; i++) out[i] = (seed * 11 + i) & 0xff;
  return out;
}

function txHash(seed: string): string {
  let s = "";
  for (let i = 0; i < 32; i++)
    s += ((seed.charCodeAt(i % seed.length) + i) % 256).toString(16).padStart(2, "0");
  return s;
}

function mixUtxo(seedTx: string, idx: number, a: number, b: number): DbSyncUtxo {
  return {
    txHash: txHash(seedTx),
    outputIndex: idx,
    address: MIX_ADDR,
    lovelace: 10_000_000n,
    assets: {},
    inlineDatum: encodeMixDatumDef(bytes48(a), bytes48(b)),
    datumHash: null,
    referenceScriptCbor: null,
    referenceScriptHash: null,
  };
}

function feeUtxo(seedTx: string, idx: number, lovelace: bigint): DbSyncUtxo {
  return {
    txHash: txHash(seedTx),
    outputIndex: idx,
    address: FEE_ADDR,
    lovelace,
    assets: {},
    inlineDatum: "d87980", // unit datum
    datumHash: null,
    referenceScriptCbor: null,
    referenceScriptHash: null,
  };
}

function referenceUtxo(seedTx: string): DbSyncUtxo {
  return {
    txHash: txHash(seedTx),
    outputIndex: 0,
    address: REF_ADDR,
    lovelace: 5_000_000n,
    assets: { [NFT_UNIT]: 1n },
    inlineDatum: null,
    datumHash: null,
    referenceScriptCbor: null,
    referenceScriptHash: null,
  };
}

function makeState(): IndexerState {
  return new IndexerState(ADDRESSES, FILTER, BigInt(ADDRESSES.protocol.max_fee_per_mix_lovelace));
}

describe("primeFromDbSync (cold-start orchestrator, issue #87)", () => {
  it("translates a db-sync snapshot into indexer state and returns the tip", async () => {
    const tip = { slot: 5_000_000, blockHash: "ab".repeat(32), height: 200_000 };
    const dbsync = new StubDbSyncClient(
      {},
      {},
      {
        tip,
        mixBoxUtxos: [mixUtxo("m1", 0, 1, 2), mixUtxo("m2", 0, 3, 4), mixUtxo("m3", 0, 5, 6)],
        feeShardUtxos: [feeUtxo("f1", 0, 5_000_000n), feeUtxo("f2", 0, 3_000_000n)],
        referenceUtxo: referenceUtxo("r"),
      },
    );
    const state = makeState();
    const returnedTip = await primeFromDbSync({
      state,
      dbsync,
      params: PRIME_PARAMS,
    });
    expect(returnedTip).toEqual(tip);
    expect(state.tip).toEqual(tip);
    expect(state.poolSize()).toBe(3);
    expect(state.feeSnapshot().shards).toHaveLength(2);
    expect(state.feeSnapshot().totalLovelace).toBe(8_000_000n);
    expect(state.referenceUtxoRef()).toEqual({ txId: txHash("r"), outputIndex: 0 });
    expect(state.alarm()).toBeNull();
  });

  it("raises the reference-UTxO alarm when db-sync has no NFT carrier", async () => {
    const tip = { slot: 1, blockHash: "00".repeat(32), height: 1 };
    const dbsync = new StubDbSyncClient(
      {},
      {},
      {
        tip,
        mixBoxUtxos: [],
        feeShardUtxos: [],
        referenceUtxo: null,
      },
    );
    const state = makeState();
    const warnings: string[] = [];
    await primeFromDbSync({
      state,
      dbsync,
      params: PRIME_PARAMS,
      logger: { info: () => {}, warn: (m) => warnings.push(m) },
    });
    expect(state.alarm()).toMatch(/reference NFT not observable/);
    expect(warnings.some((w) => w.includes("reference NFT not observed"))).toBe(true);
  });

  it("propagates db-sync errors so the caller can decide between fallback and fatal", async () => {
    const broken = {
      async primeProtocolState() {
        throw new Error("dbsync down");
      },
      async txUtxos() {
        return [];
      },
      async txSummary() {
        return null;
      },
      async ping() {
        /* noop */
      },
      async close() {
        /* noop */
      },
    };
    await expect(
      primeFromDbSync({ state: makeState(), dbsync: broken, params: PRIME_PARAMS }),
    ).rejects.toThrow(/dbsync down/);
  });
});
