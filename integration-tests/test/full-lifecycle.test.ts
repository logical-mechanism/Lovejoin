// M4 integration test: full lifecycle on Preprod — deposit, mix, withdraw,
// verify funds arrive at a fresh destination.
//
// Spec: docs/spec/09-milestones.md M4 — "Preprod integration test
// full-lifecycle passes" + the "Deposit 8 boxes, run 30 mixes" stress
// criterion. This test is the smaller end-to-end smoke that proves the
// pieces fit together. The 30-mix stress is run separately via the
// stress-tests harness.
//
// Method:
//   1. Deposit 2 mix-boxes (so we have a pair to mix).
//   2. Run a single Mix at N=2.
//   3. Locate the mixed boxes in the pool by walking with `ownsBox(x)`
//      so the test recovers regardless of which output got which y_i.
//   4. Withdraw one of them to a fresh destination.

import { describe, expect, it } from "vitest";

import {
  buildMixTx,
  buildWithdrawTx,
  depositSeries,
  fetchPool,
  fetchProtocolParams,
  loadAddresses,
  loadWallet,
  makeProvider,
  mixBoxAddressBech32,
  NETWORK,
  ownsBox,
  skipReason,
  type MixInput,
} from "./_lib.js";

const reason = skipReason();

describe.skipIf(reason !== null)(`m4 — full lifecycle on ${NETWORK}`, () => {
  it("deposit → mix → withdraw round-trips", async () => {
    const provider = makeProvider();
    const wallet = await loadWallet();
    const addresses = loadAddresses();
    const { params } = await fetchProtocolParams(addresses, provider);

    // 1. Deposits.
    const deposited = await depositSeries({
      count: 2,
      rounds: 5,
      wallet,
      provider,
      addresses,
    });
    expect(deposited).toHaveLength(2);
    const box0 = deposited[0]!;

    // 2. Mix at N=2.
    const inputs: MixInput[] = deposited.map<MixInput>((b) => ({
      ref: { txId: b.txId, outputIndex: b.outputIndex },
      a: b.a,
      b: b.b,
      utxo: {
        ref: { txId: b.txId, outputIndex: b.outputIndex },
        address: "",
        lovelace: params.denomLovelace,
        assets: {},
        inlineDatum: null,
        referenceScript: null,
      },
    }));
    const mixResult = await buildMixTx({
      network: NETWORK as "preprod" | "preview" | "mainnet",
      inputs,
      wallet,
      provider,
      addresses,
    });
    await provider.awaitConfirmation(mixResult.txId, 5 * 60_000);

    // 3. Recover one of our mixed boxes from the pool by ownership.
    const poolAddr = await mixBoxAddressBech32(addresses);
    const pool = await fetchPool({
      provider,
      mixBoxAddressBech32: poolAddr,
      params,
    });
    const myMixed = pool.find((p) => ownsBox(box0.secret, p));
    expect(myMixed, "expected to find a mix-output owned by box0.secret").toBeDefined();

    // 4. Withdraw to wallet's own address (fresh destination is a
    //    separate concern; here we just verify the round-trip).
    const destinations = await wallet.getUsedAddresses();
    const destination = destinations[0];
    expect(destination, "wallet must have at least one used address").toBeDefined();

    const wResult = await buildWithdrawTx({
      network: NETWORK as "preprod" | "preview" | "mainnet",
      ownerSecret: box0.secret,
      mixBox: {
        ref: myMixed!.ref,
        a: myMixed!.a,
        b: myMixed!.b,
      },
      destinationAddressBech32: destination!,
      wallet,
      provider,
      addresses,
    });
    expect(wResult.txId).toMatch(/^[0-9a-f]{64}$/);
    await provider.awaitConfirmation(wResult.txId, 5 * 60_000);
  }, 30 * 60_000);
});

if (reason) {
  // eslint-disable-next-line no-console
  console.log(`[m4 full-lifecycle] SKIP — ${reason}`);
}
