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
} from "../chain/blockfrost.js";

/**
 * Resolve the mesh-shaped fetcher+submitter from a chain provider. For
 * `BlockfrostProvider` this is the lazy mesh sibling; for any other
 * implementation (M5's self-hosted provider, test fakes) the caller can
 * implement a `meshProvider()` method that returns the same shape.
 */
export async function getMeshProvider(
  provider: ChainProvider,
): Promise<MeshFetcherSubmitter> {
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
