import { describe, expect, it } from "vitest";

import type { ChainProvider, NetworkProtocolParameters } from "../../src/chain/provider.js";
import { getMeshCostModels } from "../../src/tx/mesh-bridge.js";

function providerWith(costModels: Record<string, number[]>): ChainProvider {
  return {
    getProtocolParameters: async () => ({ costModels }) as NetworkProtocolParameters,
  } as unknown as ChainProvider;
}

describe("getMeshCostModels", () => {
  it("returns the live models in mesh's [V1, V2, V3] order", async () => {
    const models = await getMeshCostModels(
      providerWith({ PlutusV3: [3, 3], PlutusV1: [1], PlutusV2: [2, 2] }),
    );
    expect(models).toEqual([[1], [2, 2], [3, 3]]);
  });

  it("returns null (keep mesh's pinned models) when a language is missing", async () => {
    await expect(getMeshCostModels(providerWith({ PlutusV1: [1], PlutusV2: [2] }))).resolves.toBe(
      null,
    );
    await expect(
      getMeshCostModels(providerWith({ PlutusV1: [1], PlutusV2: [2], PlutusV3: [] })),
    ).resolves.toBe(null);
  });
});
