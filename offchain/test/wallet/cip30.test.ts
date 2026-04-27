// Unit tests for wallet/cip30.ts.
//
// We don't test the mesh wallet construction itself — that's mesh's job and
// the failure modes are loud (`MeshWallet` throws on bad input). What we
// validate here is the UTxO converters, since they sit on the boundary
// between mesh's tx-builder shape and the SDK's chain-provider shape and a
// silent off-by-one in either direction would cascade through every tx.

import { describe, expect, it } from "vitest";

import type { Utxo } from "../../src/chain/provider.js";
import {
  lovejoinUtxoToMesh,
  meshUtxoToLovejoin,
  networkIdFor,
} from "../../src/wallet/cip30.js";

describe("wallet/cip30 — networkIdFor", () => {
  it.each([
    ["preprod", 0],
    ["preview", 0],
    ["test", 0],
    ["mainnet", 1],
  ] as const)("maps %s to %d", (name, id) => {
    expect(networkIdFor(name)).toBe(id);
  });
});

describe("wallet/cip30 — meshUtxoToLovejoin", () => {
  it("aggregates lovelace and native assets", () => {
    const result = meshUtxoToLovejoin({
      input: { txHash: "ABCD".repeat(16), outputIndex: 3 },
      output: {
        address: "addr_test1qsomething",
        amount: [
          { unit: "lovelace", quantity: "5000000" },
          { unit: "policy1asset1", quantity: "1" },
          { unit: "policy1asset1", quantity: "2" }, // duplicates merge
        ],
      },
    });
    expect(result.ref.txId).toBe("abcd".repeat(16)); // lowercased
    expect(result.ref.outputIndex).toBe(3);
    expect(result.lovelace).toBe(5_000_000n);
    expect(result.assets).toEqual({ policy1asset1: 3n });
    expect(result.inlineDatum).toBeNull();
    expect(result.referenceScript).toBeNull();
  });

  it("preserves inline datum + reference script when present", () => {
    const result = meshUtxoToLovejoin({
      input: { txHash: "a".repeat(64), outputIndex: 0 },
      output: {
        address: "addr_test1q...",
        amount: [{ unit: "lovelace", quantity: "10000000" }],
        plutusData: "d87980",
        scriptRef: "abcd",
      },
    });
    expect(result.inlineDatum).toBe("d87980");
    expect(result.referenceScript).toBe("abcd");
  });

  it("treats UTxOs with zero lovelace correctly", () => {
    const result = meshUtxoToLovejoin({
      input: { txHash: "a".repeat(64), outputIndex: 0 },
      output: { address: "addr_test1q...", amount: [] },
    });
    expect(result.lovelace).toBe(0n);
    expect(result.assets).toEqual({});
  });
});

describe("wallet/cip30 — lovejoinUtxoToMesh", () => {
  it("emits lovelace first, then assets", () => {
    const u: Utxo = {
      ref: { txId: "a".repeat(64), outputIndex: 1 },
      address: "addr_test1q...",
      lovelace: 5_000_000n,
      assets: { policy1asset1: 7n, policy2asset2: 1n },
      inlineDatum: null,
      referenceScript: null,
    };
    const m = lovejoinUtxoToMesh(u);
    expect(m.input).toEqual({ txHash: "a".repeat(64), outputIndex: 1 });
    expect(m.output.amount[0]).toEqual({ unit: "lovelace", quantity: "5000000" });
    expect(m.output.amount).toContainEqual({ unit: "policy1asset1", quantity: "7" });
    expect(m.output.amount).toContainEqual({ unit: "policy2asset2", quantity: "1" });
    expect(m.output.plutusData).toBeUndefined();
    expect(m.output.scriptRef).toBeUndefined();
  });

  it("propagates plutusData + scriptRef when set", () => {
    const u: Utxo = {
      ref: { txId: "a".repeat(64), outputIndex: 0 },
      address: "addr_test1q...",
      lovelace: 1_000_000n,
      assets: {},
      inlineDatum: "d87980",
      referenceScript: "abcd",
    };
    const m = lovejoinUtxoToMesh(u);
    expect(m.output.plutusData).toBe("d87980");
    expect(m.output.scriptRef).toBe("abcd");
  });
});

describe("wallet/cip30 — round-trip", () => {
  it("mesh → lovejoin → mesh preserves the value bag", () => {
    const original = {
      input: { txHash: "a".repeat(64), outputIndex: 2 },
      output: {
        address: "addr_test1q...",
        amount: [
          { unit: "lovelace", quantity: "5000000" },
          { unit: "policy1asset1", quantity: "5" },
        ],
        plutusData: "d87980",
      },
    };
    const round = lovejoinUtxoToMesh(meshUtxoToLovejoin(original));
    expect(round.input).toEqual(original.input);
    expect(round.output.address).toEqual(original.output.address);
    expect(round.output.plutusData).toBe(original.output.plutusData);
    // amounts are equal as multisets (order doesn't have to match)
    expect(round.output.amount.length).toBe(original.output.amount.length);
    for (const a of original.output.amount) {
      expect(round.output.amount).toContainEqual(a);
    }
  });
});
