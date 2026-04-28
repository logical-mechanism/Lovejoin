// M4 integration test: a single Mix tx at the configured `max_n` on
// Preprod. This is the upper-bound smoke test — if max_n trips the
// per-tx script-cost budget, this test surfaces it before stress
// calibration runs.
//
// Spec exit criterion: docs/spec/09-milestones.md M4 — "Preprod
// integration test mix-at-max-n passes".

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

const MAX_N_DEFAULT = 6;

describe.skipIf(reason !== null)(`m4 — mix at max_n on ${NETWORK}`, () => {
  it("mixes max_n boxes in one tx", async () => {
    const provider = makeProvider();
    const wallet = await loadWallet();
    const addresses = loadAddresses();

    // Read max_n from the network config — the spec drives the calibration
    // sweep there. Fall back to MAX_N_DEFAULT if absent.
    const maxN = readMaxN(NETWORK) ?? MAX_N_DEFAULT;

    const boxes = await depositSeries({
      count: maxN,
      rounds: 5,
      wallet,
      provider,
      addresses,
    });

    const inputs: MixInput[] = boxes.map<MixInput>((b) => ({
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
    expect(result.plan.n).toBe(maxN);
    await provider.awaitConfirmation(result.txId, 10 * 60_000);
  }, 30 * 60_000);
});

function readMaxN(network: string): number | null {
  try {
    const cfg = JSON.parse(
      require("node:fs").readFileSync(
        require("node:path").resolve(`./config/network.${network}.json`),
        "utf8",
      ),
    ) as { max_n?: number };
    return typeof cfg.max_n === "number" ? cfg.max_n : null;
  } catch {
    return null;
  }
}

if (reason) {
  // eslint-disable-next-line no-console
  console.log(`[m4 mix-at-max-n] SKIP — ${reason}`);
}
