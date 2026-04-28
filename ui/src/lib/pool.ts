// Direct (no-backend) pool scan via the BlockfrostProvider.
//
// Used by the Pool screen when `config.backendUrl` is empty — keeps the UI
// useful for self-hosters who haven't stood up the M5 indexer. The trade-off
// is one Blockfrost call per refresh; rate limits are fine at the alpha
// scale.
//
// Builds the mix-box bech32 address from the addresses bundle (no need to
// pull mesh's CSL bindings here — the SDK exposes a pure-TS builder).

import {
  type BlockfrostProvider,
  type LovejoinAddresses,
  buildScriptAddress,
  fetchPool,
  fetchProtocolParams,
} from "@lovejoin/sdk";

export interface DirectPoolEntry {
  ref: { txId: string; outputIndex: number };
  a: Uint8Array;
  b: Uint8Array;
}

export async function fetchPoolDirect(args: {
  provider: BlockfrostProvider;
  addresses: LovejoinAddresses;
}): Promise<DirectPoolEntry[]> {
  const { provider, addresses } = args;
  const networkId: 0 | 1 = addresses.network === "mainnet" ? 1 : 0;
  const mixBoxAddressBech32 = buildScriptAddress(
    addresses.mixBoxScriptHash,
    networkId,
    addresses.dappStakeKeyHashHex ?? null,
  );
  const { params } = await fetchProtocolParams(addresses, provider);
  const entries = await fetchPool({
    provider,
    mixBoxAddressBech32,
    params,
  });
  return entries.map((e) => ({ ref: e.ref, a: e.a, b: e.b }));
}
