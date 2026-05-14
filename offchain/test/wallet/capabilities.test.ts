// Capability-allowlist behaviour for wallet-funded fan-out (issue #147).

import { describe, expect, it } from "vitest";

import {
  getWalletCapabilities,
  walletSupportsChainedFanout,
  WALLET_CAPABILITIES,
} from "../../src/wallet/capabilities.js";

describe("walletSupportsChainedFanout", () => {
  it("returns true for known chained-tx-capable wallets (eternl, lace)", () => {
    expect(walletSupportsChainedFanout("eternl")).toBe(true);
    expect(walletSupportsChainedFanout("lace")).toBe(true);
  });

  it("matches case-insensitively so a wallet exposing custom casing still resolves", () => {
    expect(walletSupportsChainedFanout("Eternl")).toBe(true);
    expect(walletSupportsChainedFanout("ETERNL")).toBe(true);
    expect(walletSupportsChainedFanout("LACE")).toBe(true);
  });

  it("default-denies unknown wallets so a never-tested wallet cannot opt itself in", () => {
    // Wallets not on the allowlist must return false even when they may
    // happen to support chained-tx signing in practice. The allowlist
    // is empirical — adding a wallet requires a manual test pass, not
    // a datasheet claim.
    expect(walletSupportsChainedFanout("nami")).toBe(false);
    expect(walletSupportsChainedFanout("flint")).toBe(false);
    expect(walletSupportsChainedFanout("yoroi")).toBe(false);
    expect(walletSupportsChainedFanout("typhon")).toBe(false);
    expect(walletSupportsChainedFanout("nufi")).toBe(false);
    expect(walletSupportsChainedFanout("madeupwallet")).toBe(false);
  });

  it("returns false for null / undefined / empty walletId so disconnect-state callers don't false-positive", () => {
    expect(walletSupportsChainedFanout(null)).toBe(false);
    expect(walletSupportsChainedFanout(undefined)).toBe(false);
    expect(walletSupportsChainedFanout("")).toBe(false);
  });
});

describe("getWalletCapabilities", () => {
  it("returns the capability record for known wallets", () => {
    expect(getWalletCapabilities("eternl")).toEqual({ chainedTxFanout: true });
    expect(getWalletCapabilities("lace")).toEqual({ chainedTxFanout: true });
  });

  it("returns null for unknown / empty wallet ids so callers can branch on default-deny", () => {
    expect(getWalletCapabilities("nami")).toBeNull();
    expect(getWalletCapabilities(null)).toBeNull();
    expect(getWalletCapabilities(undefined)).toBeNull();
    expect(getWalletCapabilities("")).toBeNull();
  });

  it("the allowlist constant exposes only lower-case keys (matches the lookup contract)", () => {
    for (const key of Object.keys(WALLET_CAPABILITIES)) {
      expect(key).toBe(key.toLowerCase());
    }
  });
});
