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
 * The chain's live Plutus cost models in mesh's custom-network shape
 * (`[V1, V2, V3]`), for `MeshTxBuilder.setNetwork(...)`.
 *
 * The script-integrity hash in every script tx covers the cost models of
 * the Plutus languages it runs. Left alone, mesh hashes the models pinned
 * inside its serializer, and those stopped matching the chain when Preprod
 * and mainnet moved to protocol version 11 (a 350-entry PlutusV3 model):
 * the ledger then rejects every script tx with ScriptIntegrityHashMismatch.
 * Returns null, keeping mesh's pinned models, when the provider reports no
 * complete set.
 */
export async function getMeshCostModels(provider: ChainProvider): Promise<number[][] | null> {
  const { costModels } = await provider.getProtocolParameters();
  const models = [costModels?.PlutusV1, costModels?.PlutusV2, costModels?.PlutusV3];
  if (models.some((m) => !Array.isArray(m) || m.length === 0)) {
    console.warn(
      "[lovejoin/params] provider reported no Plutus V1/V2/V3 cost models; " +
        "mesh will hash its pinned ones and the ledger may reject the script-integrity hash",
    );
    return null;
  }
  return models as number[][];
}
