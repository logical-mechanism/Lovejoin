// Unit tests for the M3.5 UI ↔ SDK bridge.
//
// These exercise the pure parts (config persistence, network → URL, fetch
// path) without spinning up the wallet or mesh — those need a browser.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CONFIG,
  blockfrostBaseUrl,
  loadAddresses,
  loadConfig,
  makeProvider,
  saveConfig,
} from "../src/lib/sdk.js";

beforeEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("blockfrostBaseUrl", () => {
  it("maps preprod / preview / mainnet to the right Blockfrost host", () => {
    expect(blockfrostBaseUrl("preprod")).toBe(
      "https://cardano-preprod.blockfrost.io/api/v0",
    );
    expect(blockfrostBaseUrl("preview")).toBe(
      "https://cardano-preview.blockfrost.io/api/v0",
    );
    expect(blockfrostBaseUrl("mainnet")).toBe(
      "https://cardano-mainnet.blockfrost.io/api/v0",
    );
  });
});

describe("loadConfig / saveConfig", () => {
  it("returns the default config when nothing is stored", () => {
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it("persists and reloads a config across calls", () => {
    saveConfig({ network: "preprod", blockfrostProjectId: "preprodAbc123" });
    expect(loadConfig()).toEqual({
      network: "preprod",
      blockfrostProjectId: "preprodAbc123",
    });
  });

  it("falls back to default when the stored value is malformed JSON", () => {
    window.localStorage.setItem("lovejoin.config.v1", "{not json");
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it("falls back to the default network when an unknown one is stored", () => {
    window.localStorage.setItem(
      "lovejoin.config.v1",
      JSON.stringify({ network: "ferrum-2099", blockfrostProjectId: "x" }),
    );
    expect(loadConfig().network).toBe("preprod");
  });
});

describe("makeProvider", () => {
  it("throws a clear error when project id is missing", () => {
    expect(() =>
      makeProvider({ network: "preprod", blockfrostProjectId: "   " }),
    ).toThrow(/project ID required/i);
  });

  it("constructs a BlockfrostProvider when configured", () => {
    const provider = makeProvider({
      network: "preprod",
      blockfrostProjectId: "preprodFoo",
    });
    expect(provider).toBeDefined();
    // The provider exposes the chain interface — we don't assert specific
    // methods here because that ties the test to the SDK's surface; the SDK
    // owns its own contract tests.
  });
});

describe("loadAddresses", () => {
  it("fetches the per-network addresses file from the public dir", async () => {
    const fakeAddresses = {
      network: "preprod",
      protocol: { denom_lovelace: 1, max_fee_per_mix_lovelace: 1, fee_shard_target: 1 },
      referenceNftPolicy: "a".repeat(56),
      referenceNftAssetName: "x",
      referenceUtxoRef: `${"f".repeat(64)}#0`,
      referenceHolderScriptHash: "b".repeat(56),
      mixLogicScriptHash: "c".repeat(56),
      mixBoxScriptHash: "d".repeat(56),
      feeScriptHash: "e".repeat(56),
      feeShardUtxos: [],
      referenceScriptUtxos: {
        mix_box: `${"1".repeat(64)}#0`,
        mix_logic: `${"2".repeat(64)}#0`,
        fee_contract: `${"3".repeat(64)}#0`,
      },
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => fakeAddresses,
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const addresses = await loadAddresses("preprod");
    expect(addresses).toEqual(fakeAddresses);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0] as unknown as [unknown, unknown];
    const url = String(firstCall[0] ?? "");
    expect(url).toMatch(/addresses\.preprod\.json$/);
  });

  it("throws a useful error when the file is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({}),
      } as unknown as Response)),
    );
    await expect(loadAddresses("preprod")).rejects.toThrow(/HTTP 404/);
  });
});
