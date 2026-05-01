// M4 integration test: Mix txs respect the fee-shard exhaustion rule.
//
// Spec: docs/spec/09-milestones.md M4 — "Preprod integration test
// fee-exhaustion passes". Per docs/spec/03-contracts.md §3, a Mix tx
// can only succeed when `fee_in - fee_out == tx.fee` and `tx.fee ≤
// max_fee_per_mix_lovelace`. Construct a fee shard with insufficient
// funds and verify submission fails (or the local plan refuses to
// build). The test is a SDK-side rejection check — we don't need to
// actually submit the malformed tx to chain.

import { describe, expect, it } from "vitest";

import { fetchProtocolParams, loadAddresses, makeProvider, NETWORK, skipReason } from "./_lib.js";
import { planMixTx, generateOwnerSecret } from "@lovejoin/sdk";
import {
  G1_COMPRESSED_BYTES,
  generator,
  pointToBytes,
  scalarMul,
  encodeMixDatum,
} from "@lovejoin/sdk";
import { networkIdFor } from "@lovejoin/sdk";

const reason = skipReason();

describe.skipIf(reason !== null)(`m4 — fee exhaustion on ${NETWORK}`, () => {
  it("planMixTx refuses a fee shard below max_fee_per_mix", async () => {
    const provider = makeProvider();
    const addresses = loadAddresses();
    const { params } = await fetchProtocolParams(addresses, provider);

    // Build two synthetic mix-box inputs locally — we don't need them
    // on chain because the planner runs purely off the data.
    const inputs = [synthInput("aa", 7n, 11n), synthInput("bb", 13n, 17n)];

    // A fee shard with too little lovelace.
    const tooSmallShard = {
      ref: {
        txId: "00".repeat(32),
        outputIndex: 0,
      },
      address: "addr_test1xxx",
      lovelace: 100n, // way below max_fee_per_mix
      assets: {},
      inlineDatum: "d87980",
      referenceScript: null,
    };

    expect(() =>
      planMixTx({
        inputs,
        params,
        addresses,
        feeShard: tooSmallShard,
        networkId: networkIdFor(NETWORK),
      }),
    ).toThrow(/too little|fee/);
  });

  it("planMixTx refuses tx fee above max_fee_per_mix", async () => {
    const provider = makeProvider();
    const addresses = loadAddresses();
    const { params } = await fetchProtocolParams(addresses, provider);

    const inputs = [synthInput("aa", 7n, 11n), synthInput("bb", 13n, 17n)];
    const shard = {
      ref: { txId: "00".repeat(32), outputIndex: 0 },
      address: "addr_test1xxx",
      lovelace: 100_000_000n,
      assets: {},
      inlineDatum: "d87980",
      referenceScript: null,
    };

    expect(() =>
      planMixTx({
        inputs,
        params,
        addresses,
        feeShard: shard,
        networkId: networkIdFor(NETWORK),
        txFeeLovelace: params.maxFeePerMixLovelace + 1n,
      }),
    ).toThrow(/exceeds max_fee_per_mix/);
  });
});

function synthInput(prefix: string, secret: bigint, dScalar: bigint) {
  const txId = (prefix + "00".repeat(31)).slice(0, 64);
  const aPoint = scalarMul(dScalar, generator());
  const bPoint = scalarMul(secret, aPoint);
  const a = pointToBytes(aPoint);
  const b = pointToBytes(bPoint);
  return {
    ref: { txId, outputIndex: 0 },
    a,
    b,
    utxo: {
      ref: { txId, outputIndex: 0 },
      address: "addr_test1xxx",
      lovelace: 10_000_000n,
      assets: {},
      inlineDatum: encodeMixDatum({ a, b }),
      referenceScript: null,
    },
  };
}

void generateOwnerSecret;
void G1_COMPRESSED_BYTES;

if (reason) {
  console.log(`[m4 fee-exhaustion] SKIP — ${reason}`);
}
