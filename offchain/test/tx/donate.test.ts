// Unit tests for tx/donate.ts.
//
// We focus on the pure planning surface (`planDonateTx`). The mesh-driven
// `buildDonateTx` is exercised by the Preprod integration test, same
// posture as `deposit.test.ts`.

import { describe, expect, it } from "vitest";

import { planDonateTx } from "../../src/tx/donate.js";
import {
  REPLENISH_REDEEMER_CBOR_HEX,
  UNIT_DATUM_CBOR_HEX,
} from "../../src/tx/deposit.js";
import type { LovejoinAddresses } from "../../src/tx/params.js";
import type { Utxo } from "../../src/chain/provider.js";
import { buildEnterpriseScriptAddress } from "../../src/tx/address.js";

const ADDRESSES: LovejoinAddresses = {
  network: "preprod",
  protocol: { denom_lovelace: 10_000_000, max_fee_per_mix_lovelace: 800_000 },
  referenceNftPolicy: "310d0d4ff25e73a4a0442eac873e68810e11c824aa0e858acc56f1df",
  referenceNftAssetName: "6c6f76656a6f696e",
  referenceUtxoRef:
    "b809b4e363067886174b57fd04101eb2e59f654220b6c11530c77b75f25ec945#0",
  referenceHolderScriptHash: "b58b5869a956266f5a55265829963064cabfeac4dab3c28f46dbc1cc",
  mixLogicScriptHash: "ca2d95fe9fe368e8ad1c89e2009a5ad292ff016e353144ea0ef829ff",
  mixBoxScriptHash: "ba176a7604f3e062a7ed315780801495ed0ffb0191c6f8e7d88362e2",
  feeScriptHash: "5efd8fdd7e4d35b04de427337220dcb30352136d739055b305dd2d66",
  feeShardUtxos: [
    "34a117d9699e8537529aa093943cdeda6f525fd167a74e6f1bd9229ef805a080#0",
  ],
  referenceScriptUtxos: {
    mix_box: "b51692abb805409936944691abd324f2dcdd025749b9094dbd49939588c7e27f#0",
    mix_logic: "d65e2a074a45c6f24b42fe60924d8e35cb26412985d98480a4e96b5b89a2a727#0",
    fee_contract: "5d9a9e2c26aeffcddb0d0f6e4cc07b62df546a8615bd5bd2aca673561e3600b6#0",
  },
};

function feeShard(lovelace = 5_000_000n): Utxo {
  return {
    ref: {
      txId: "34a117d9699e8537529aa093943cdeda6f525fd167a74e6f1bd9229ef805a080",
      outputIndex: 0,
    },
    address: buildEnterpriseScriptAddress(ADDRESSES.feeScriptHash, 0),
    lovelace,
    assets: {},
    inlineDatum: UNIT_DATUM_CBOR_HEX,
    referenceScript: null,
  };
}

describe("tx/donate planDonateTx", () => {
  it("produces a Replenish output with strictly more lovelace than the input", () => {
    const input = feeShard(7_000_000n);
    const plan = planDonateTx({
      donationLovelace: 2_500_000n,
      feeShard: input,
      addresses: ADDRESSES,
      networkId: 0,
    });

    expect(plan.replenishRedeemerHex).toBe(REPLENISH_REDEEMER_CBOR_HEX);
    expect(plan.feeShardOutput.inlineDatumHex).toBe(UNIT_DATUM_CBOR_HEX);
    expect(plan.feeShardOutput.lovelace).toBe(input.lovelace + 2_500_000n);
    expect(plan.feeShardOutput.lovelace > input.lovelace).toBe(true);
  });

  it("emits the fee output at the enterprise (unstaked) fee_contract address", () => {
    const plan = planDonateTx({
      donationLovelace: 1_000_000n,
      feeShard: feeShard(),
      addresses: ADDRESSES,
      networkId: 0,
    });
    expect(plan.feeShardOutput.addressBech32).toBe(
      buildEnterpriseScriptAddress(ADDRESSES.feeScriptHash, 0),
    );
  });

  it("threads through the reference UTxO and fee_contract reference script", () => {
    const plan = planDonateTx({
      donationLovelace: 1_000_000n,
      feeShard: feeShard(),
      addresses: ADDRESSES,
      networkId: 0,
    });
    expect(plan.referenceUtxoRef.txId).toBe(
      "b809b4e363067886174b57fd04101eb2e59f654220b6c11530c77b75f25ec945",
    );
    expect(plan.feeContractRefScriptUtxoRef.txId).toBe(
      "5d9a9e2c26aeffcddb0d0f6e4cc07b62df546a8615bd5bd2aca673561e3600b6",
    );
  });

  it("rejects non-positive donations", () => {
    expect(() =>
      planDonateTx({
        donationLovelace: 0n,
        feeShard: feeShard(),
        addresses: ADDRESSES,
        networkId: 0,
      }),
    ).toThrow(/positive/);
    expect(() =>
      planDonateTx({
        donationLovelace: -1n,
        feeShard: feeShard(),
        addresses: ADDRESSES,
        networkId: 0,
      }),
    ).toThrow(/positive/);
  });
});
