// Unit tests for chain/ogmios-utxo.ts.
//
// The Ogmios `additionalUtxo` shape is fed verbatim into the upstream
// evaluator (giveme.my via additional_utxos, Blockfrost via
// additionalUtxoSet, the self-hosted backend via additionalUtxo on the
// ogmios JSON-RPC). Any off-by-one would fail the chained-Mix
// evaluation before submit. The first cut of this module emitted a
// `[txin, txout]` 2-tuple per the issue spec but Ogmios v6 rejected
// with "parsing TxIn failed, expected Object, but encountered Array"
// — the schema actually wants a flat object combining ref + output
// fields. These tests pin the corrected shape.

import { describe, expect, it } from "vitest";

import type { Utxo } from "../../src/chain/provider.js";
import {
  lovejoinUtxoToOgmiosAdditional,
  meshUtxoToOgmiosAdditional,
} from "../../src/chain/ogmios-utxo.js";

describe("chain/ogmios-utxo — meshUtxoToOgmiosAdditional", () => {
  it("emits a flat object with ref + output fields and ada.lovelace", () => {
    const entry = meshUtxoToOgmiosAdditional({
      input: { txHash: "ABCD".repeat(16), outputIndex: 3 },
      output: {
        address: "addr_test1qsomething",
        amount: [{ unit: "lovelace", quantity: "5000000" }],
      },
    });
    // Tx id lowercased; Ogmios is case-insensitive but most upstream
    // tooling canonicalises to lower so we match.
    expect(entry.transaction).toEqual({ id: "abcd".repeat(16) });
    expect(entry.index).toBe(3);
    expect(entry.address).toBe("addr_test1qsomething");
    expect(entry.value.ada.lovelace).toBe(5_000_000n);
    // Inline-datum / script not present → fields omitted.
    expect(entry.datum).toBeUndefined();
    expect(entry.script).toBeUndefined();
    // Regression guard: the entry MUST NOT be a 2-tuple array — Ogmios
    // rejects that with "parsing TxIn failed, expected Object,
    // encountered Array".
    expect(Array.isArray(entry)).toBe(false);
  });

  it("groups native assets by policyId in the nested-map shape", () => {
    const policyA = "11".repeat(28); // 56 hex chars
    const policyB = "22".repeat(28);
    const entry = meshUtxoToOgmiosAdditional({
      input: { txHash: "a".repeat(64), outputIndex: 0 },
      output: {
        address: "addr_test1q...",
        amount: [
          { unit: "lovelace", quantity: "2000000" },
          { unit: policyA + "414243", quantity: "1" }, // assetName = "ABC"
          { unit: policyA + "414243", quantity: "2" }, // duplicate merges
          { unit: policyA + "313233", quantity: "5" }, // assetName = "123"
          { unit: policyB + "", quantity: "7" }, // empty asset name
        ],
      },
    });
    expect(entry.value.ada.lovelace).toBe(2_000_000n);
    expect(entry.value[policyA]).toEqual({
      "414243": 3n,
      "313233": 5n,
    });
    expect(entry.value[policyB]).toEqual({ "": 7n });
  });

  it("forwards inline datum + reference script when present", () => {
    const entry = meshUtxoToOgmiosAdditional({
      input: { txHash: "b".repeat(64), outputIndex: 1 },
      output: {
        address: "addr_test1q...",
        amount: [{ unit: "lovelace", quantity: "10000000" }],
        plutusData: "d87980",
        scriptRef: "abcdef",
      },
    });
    expect(entry.datum).toBe("d87980");
    expect(entry.script).toBe("abcdef");
  });

  it("forces ada.lovelace to exist even when the UTxO has no lovelace", () => {
    // Ogmios requires `value.ada.lovelace` to exist; otherwise the
    // upstream evaluator throws "invalid value, missing ada". Zero is
    // the legal floor.
    const entry = meshUtxoToOgmiosAdditional({
      input: { txHash: "c".repeat(64), outputIndex: 0 },
      output: {
        address: "addr_test1q...",
        amount: [{ unit: "11".repeat(28) + "00", quantity: "1" }],
      },
    });
    expect(entry.value.ada).toEqual({ lovelace: 0n });
  });

  it("throws on a malformed asset unit (under 56 hex chars)", () => {
    expect(() =>
      meshUtxoToOgmiosAdditional({
        input: { txHash: "a".repeat(64), outputIndex: 0 },
        output: {
          address: "addr_test1q...",
          amount: [{ unit: "tooshort", quantity: "1" }],
        },
      }),
    ).toThrow(/malformed asset unit/);
  });
});

describe("chain/ogmios-utxo — lovejoinUtxoToOgmiosAdditional", () => {
  it("matches the mesh helper's output on the ada-only path", () => {
    // A "round-trip from a known mesh UTxO matches a hand-built Ogmios
    // fixture" — issue #127 verification bullet.
    const meshUtxo = {
      input: { txHash: "f".repeat(64), outputIndex: 0 },
      output: {
        address: "addr_test1qfoobar",
        amount: [{ unit: "lovelace", quantity: "10000000" }],
        plutusData: "d87980",
      },
    };
    const lovejoinUtxo: Utxo = {
      ref: { txId: "f".repeat(64), outputIndex: 0 },
      address: "addr_test1qfoobar",
      lovelace: 10_000_000n,
      assets: {},
      inlineDatum: "d87980",
      referenceScript: null,
    };
    const fromMesh = meshUtxoToOgmiosAdditional(meshUtxo);
    const fromLovejoin = lovejoinUtxoToOgmiosAdditional(lovejoinUtxo);
    // Both should serialise to the same Ogmios payload (modulo bigint
    // identity in TS).
    expect(JSON.stringify(fromMesh, bigintReplacer)).toBe(
      JSON.stringify(fromLovejoin, bigintReplacer),
    );
    // Cross-check the hand-built fixture (flat object — NOT a 2-tuple).
    const expected = {
      transaction: { id: "f".repeat(64) },
      index: 0,
      address: "addr_test1qfoobar",
      value: { ada: { lovelace: 10000000 } },
      datum: "d87980",
    };
    expect(JSON.parse(JSON.stringify(fromMesh, bigintReplacer))).toEqual(expected);
  });

  it("groups assets identically to the mesh helper", () => {
    const policy = "ab".repeat(28);
    const asset = "deadbeef";
    const lovejoinUtxo: Utxo = {
      ref: { txId: "1".repeat(64), outputIndex: 2 },
      address: "addr_test1qassets",
      lovelace: 1_500_000n,
      assets: { [policy + asset]: 42n },
      inlineDatum: null,
      referenceScript: null,
    };
    const entry = lovejoinUtxoToOgmiosAdditional(lovejoinUtxo);
    expect(entry.value.ada.lovelace).toBe(1_500_000n);
    expect(entry.value[policy]).toEqual({ [asset]: 42n });
  });
});

/** JSON.stringify replacer that turns bigints into numbers for fixture comparison. */
function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? Number(v) : v;
}
