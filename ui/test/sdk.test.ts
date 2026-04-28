// Unit tests for the UI ↔ SDK bridge.
//
// These exercise the pure parts (env defaults, advanced-mode override
// gating, network → URL, fetch path) without spinning up the wallet or
// mesh — those need a browser.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  blockfrostBaseUrl,
  clearConfigOverrides,
  envDefaults,
  isAdvancedMode,
  loadAddresses,
  loadConfig,
  makeProvider,
  saveConfig,
} from "../src/lib/sdk.js";

beforeEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
  // Strip ?advanced=1 between tests so each one starts in production mode.
  window.history.replaceState({}, "", "/");
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

describe("envDefaults", () => {
  it("returns env-driven defaults that the test harness boots with", () => {
    const d = envDefaults();
    expect(["preprod", "preview", "mainnet"]).toContain(d.network);
    // The test env doesn't set a project id; the resulting provider will
    // be null until VITE_BLOCKFROST_PROJECT_ID is set at build time.
    expect(typeof d.blockfrostProjectId).toBe("string");
  });
});

describe("isAdvancedMode", () => {
  it("is false by default", () => {
    expect(isAdvancedMode()).toBe(false);
  });
  it("flips to true when ?advanced=1 is in the URL", () => {
    window.history.replaceState({}, "", "/?advanced=1");
    expect(isAdvancedMode()).toBe(true);
  });
});

describe("loadConfig / saveConfig", () => {
  it("returns env defaults when no override + production mode", () => {
    expect(loadConfig()).toEqual(envDefaults());
  });

  it("ignores localStorage overrides outside ?advanced=1", () => {
    saveConfig({
      network: "mainnet",
      blockfrostProjectId: "shouldNotLeak",
      backendUrl: "https://nope",
      collateralProviderEndpoint: "https://nope",
    });
    expect(loadConfig()).toEqual(envDefaults());
  });

  it("honours localStorage overrides under ?advanced=1", () => {
    window.history.replaceState({}, "", "/?advanced=1");
    saveConfig({
      network: "preprod",
      blockfrostProjectId: "preprodAbc123",
      backendUrl: "",
      collateralProviderEndpoint: "https://giveme.my",
    });
    expect(loadConfig()).toEqual({
      network: "preprod",
      blockfrostProjectId: "preprodAbc123",
      backendUrl: "",
      collateralProviderEndpoint: "https://giveme.my",
    });
  });

  it("falls back to env defaults when stored JSON is malformed", () => {
    window.history.replaceState({}, "", "/?advanced=1");
    window.localStorage.setItem("lovejoin.config.v1", "{not json");
    expect(loadConfig()).toEqual(envDefaults());
  });

  it("clearConfigOverrides removes the persisted entry", () => {
    saveConfig({
      network: "preprod",
      blockfrostProjectId: "x",
      backendUrl: "",
      collateralProviderEndpoint: "https://giveme.my",
    });
    expect(window.localStorage.getItem("lovejoin.config.v1")).not.toBeNull();
    clearConfigOverrides();
    expect(window.localStorage.getItem("lovejoin.config.v1")).toBeNull();
  });
});

describe("makeProvider", () => {
  it("returns null when project id is missing", () => {
    expect(
      makeProvider({
        network: "preprod",
        blockfrostProjectId: "   ",
        backendUrl: "",
        collateralProviderEndpoint: "https://giveme.my",
      }),
    ).toBeNull();
  });

  it("constructs a BlockfrostProvider when configured", () => {
    const provider = makeProvider({
      network: "preprod",
      blockfrostProjectId: "preprodFoo",
      backendUrl: "",
      collateralProviderEndpoint: "https://giveme.my",
    });
    expect(provider).not.toBeNull();
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
