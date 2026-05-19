// Helper to extract a mesh-shaped provider from our `ChainProvider`.
//
// Background: mesh's `MeshTxBuilder` needs a real `IFetcher` + `ISubmitter`
// (the bag of `fetchUTxOs`, `fetchProtocolParameters`, ... methods).
// Our `ChainProvider` is a deliberately narrow Lovejoin interface, so it
// doesn't satisfy mesh's surface. `BlockfrostProvider` carries a lazy
// mesh sibling via `meshProvider()`; this helper finds it without forcing
// every caller to know which concrete class is in play.
//
// Why a helper instead of widening `ChainProvider`: keeping the chain
// interface narrow lets us write provider tests under a mocked fetch
// without dragging in mesh. Only the tx-build path actually needs the
// mesh-shaped sibling, so the cost is paid at exactly that boundary.

import type { ChainProvider } from "../chain/provider.js";
import {
  BlockfrostProvider,
  type MeshFetcherSubmitter,
  type MeshProtocolParameters,
} from "../chain/blockfrost.js";

/**
 * Resolve the mesh-shaped fetcher+submitter from a chain provider. For
 * `BlockfrostProvider` this is the lazy mesh sibling; for any other
 * implementation (M5's self-hosted provider, test fakes) the caller can
 * implement a `meshProvider()` method that returns the same shape.
 */
export async function getMeshProvider(provider: ChainProvider): Promise<MeshFetcherSubmitter> {
  if (provider instanceof BlockfrostProvider) {
    return provider.meshProvider();
  }
  const maybe = provider as unknown as {
    meshProvider?: () => Promise<MeshFetcherSubmitter>;
  };
  if (typeof maybe.meshProvider === "function") {
    return maybe.meshProvider();
  }
  throw new Error(
    "Provider does not expose a mesh-compatible fetcher. Use BlockfrostProvider " +
      "or implement `meshProvider()` on your custom ChainProvider.",
  );
}

/**
 * Fetch the on-chain protocol parameters and return them in mesh's shape,
 * suitable for `new MeshTxBuilder({ params })`.
 *
 * mesh's `MeshTxBuilder` does NOT call `fetchProtocolParameters` itself —
 * it always uses `DEFAULT_PROTOCOL_PARAMETERS` from `@meshsdk/common`
 * unless you hand it real ones via the constructor. The mesh defaults
 * include `minFeeRefScriptCostPerByte: 15` but with no live tx-size
 * binding; passing real params is what makes mesh's fee math include
 * the Conway reference-script-cost component.
 *
 * Combined with our override on `BlockfrostProvider.meshProvider()`'s
 * `fetchProtocolParameters` (which patches the missing
 * `minFeeRefScriptCostPerByte` field through from the raw Blockfrost
 * response), this gives MeshTxBuilder accurate Conway-era fee math.
 */
export async function getMeshProtocolParams(
  provider: ChainProvider,
): Promise<MeshProtocolParameters> {
  const mesh = await getMeshProvider(provider);
  return mesh.fetchProtocolParameters();
}

/**
 * Resolve the live Plutus cost models in the shape `MeshTxBuilder.setNetwork`
 * accepts as a custom script-integrity-hash basis.
 *
 * Why this exists: mesh 1.8.14's Wasm serializer (`@meshsdk/core-csl`)
 * hashes a tx's `script_data_hash` against cost models BUNDLED inside the
 * Wasm — mesh's `Protocol` type carries no `costModels` field, so
 * `new MeshTxBuilder({ params })` cannot supply them. After a Cardano
 * governance action changes the cost models, the bundled set goes stale
 * and the ledger rejects every Plutus tx with error 3113 ("provided
 * script integrity hash doesn't match the computed one").
 *
 * `MeshTxBuilder.setNetwork()` accepts a `number[][]` instead of a
 * network-name string; core-csl's `networkToObj` wraps it as
 * `{ custom }` and the Wasm uses those cost models verbatim. The array
 * is indexed by Plutus language version minus one (V1 → 0, V2 → 1,
 * V3 → 2), so every version the deployment uses must be supplied in
 * order with no gaps.
 *
 * Returns `null` when the provider doesn't surface all three cost
 * models; the caller then falls back to the network-name string (mesh's
 * bundled defaults), which is correct as long as the chain's cost models
 * match what the installed mesh version shipped with.
 */
export async function getMeshCostModels(provider: ChainProvider): Promise<number[][] | null> {
  const params = await provider.getProtocolParameters();
  return costModelsToMeshArray(params.costModels);
}

/**
 * Pure conversion of a `{ PlutusV1, PlutusV2, PlutusV3 }` cost-model
 * record into the `[v1, v2, v3]` array `setNetwork` expects. Exported
 * for unit tests. Returns `null` if any version is missing or empty —
 * a partial array would misalign the version → index mapping and
 * silently corrupt the script-integrity hash.
 */
export function costModelsToMeshArray(
  costModels: Record<string, number[]> | undefined | null,
): number[][] | null {
  if (!costModels) return null;
  const v1 = costModels.PlutusV1;
  const v2 = costModels.PlutusV2;
  const v3 = costModels.PlutusV3;
  if (!v1?.length || !v2?.length || !v3?.length) return null;
  return [v1, v2, v3];
}
