// Unit tests for tx/mesh-bridge.ts `costModelsToMeshArray`.
//
// The helper converts a `{ PlutusV1, PlutusV2, PlutusV3 }` cost-model
// record into the `[v1, v2, v3]` array `MeshTxBuilder.setNetwork` accepts
// as a custom script-integrity-hash basis. The version → index mapping
// (V1→0, V2→1, V3→2) must hold, and a partial record must yield `null`
// rather than a gap-misaligned array.

import { describe, expect, it } from "vitest";

import { costModelsToMeshArray } from "../../src/tx/mesh-bridge.js";

describe("tx/mesh-bridge — costModelsToMeshArray", () => {
  it("maps PlutusV1/V2/V3 to indices 0/1/2 in order", () => {
    const v1 = [1, 2, 3];
    const v2 = [4, 5, 6];
    const v3 = [7, 8, 9];
    const out = costModelsToMeshArray({ PlutusV1: v1, PlutusV2: v2, PlutusV3: v3 });
    expect(out).toEqual([v1, v2, v3]);
  });

  it("returns null when a version is missing", () => {
    expect(costModelsToMeshArray({ PlutusV1: [1], PlutusV2: [2] })).toBeNull();
    expect(costModelsToMeshArray({ PlutusV3: [3] })).toBeNull();
  });

  it("returns null when a version's array is empty", () => {
    expect(costModelsToMeshArray({ PlutusV1: [1], PlutusV2: [2], PlutusV3: [] })).toBeNull();
  });

  it("returns null for missing / nullish input", () => {
    expect(costModelsToMeshArray(undefined)).toBeNull();
    expect(costModelsToMeshArray(null)).toBeNull();
    expect(costModelsToMeshArray({})).toBeNull();
  });

  it("preserves the cost-model arrays verbatim (no copy, no reorder)", () => {
    // A realistic-length V3 array — the helper must pass it through
    // untouched so the on-chain language-view bytes match exactly.
    const v3 = Array.from({ length: 251 }, (_, i) => i * 7);
    const out = costModelsToMeshArray({
      PlutusV1: [100788, 420],
      PlutusV2: [100788, 420],
      PlutusV3: v3,
    });
    expect(out).not.toBeNull();
    expect(out![2]).toBe(v3);
    expect(out![2]).toHaveLength(251);
  });
});
