// M4 integration test: a single Mix tx at N=2 on Preprod.
//
// Spec exit criterion: docs/spec/09-milestones.md M4 — "Preprod
// integration test mix-n2 passes".
//
// Method: deposit two mix-boxes, fetch the pool, pick our two boxes,
// run buildMixTx at N=2, await confirmation. The wallet supplies
// collateral via the WalletProvider (M5 will swap to giveme.my).

import { describe, expect, it } from "vitest";

import {
  buildMixTx,
  depositSeries,
  loadAddresses,
  loadWallet,
  makeProvider,
  NETWORK,
  skipReason,
  type MixInput,
} from "./_lib.js";

const reason = skipReason();

describe.skipIf(reason !== null)(`m4 — mix N=2 on ${NETWORK}`, () => {
  it("mixes two deposited boxes at N=2", async () => {
    const provider = makeProvider();
    const wallet = await loadWallet();
    const addresses = loadAddresses();

    // Deposit two boxes, await both confirmations.
    const deposited = await depositSeries({
      count: 2,
      rounds: 5,
      wallet,
      provider,
      addresses,
    });
    expect(deposited).toHaveLength(2);

    const inputs: MixInput[] = deposited.map<MixInput>((b) => ({
      ref: { txId: b.txId, outputIndex: b.outputIndex },
      a: b.a,
      b: b.b,
      utxo: {
        ref: { txId: b.txId, outputIndex: b.outputIndex },
        address: "",
        lovelace: BigInt(addresses.protocol.denom_lovelace),
        assets: {},
        inlineDatum: null,
        referenceScript: null,
      },
    }));

    const result = await buildMixTx({
      network: NETWORK as "preprod" | "preview" | "mainnet",
      inputs,
      wallet,
      provider,
      addresses,
    });

    expect(result.txId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.plan.n).toBe(2);
    await provider.awaitConfirmation(result.txId, 5 * 60_000);
  });
});

if (reason) {
   
  console.log(`[m4 mix-n2] SKIP — ${reason}`);
}
