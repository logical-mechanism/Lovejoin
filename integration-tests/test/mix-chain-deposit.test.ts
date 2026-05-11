// Integration test: chained Mix on an in-flight Deposit (issue #127).
//
// Method:
//   1. Pre-condition — ensure there's at least one confirmed mix-box in the
//      pool. Deposit + await confirmation if the pool is empty.
//   2. Submit a Deposit and immediately CAPTURE its mix-box output without
//      awaiting confirmation. This becomes the "in-flight parent" the
//      Mix tx chains off.
//   3. Build a Mix at N=2 with one input = the unconfirmed Deposit's
//      mix-box, the other = a confirmed pool entry. Pass `chainFrom`
//      with the unconfirmed mix-box UTxO so every evaluator on the
//      build path (local mesh, giveme.my upstream) sees the in-flight
//      output.
//   4. Submit, await Mix confirmation. The chain accepts the Mix once
//      the parent Deposit lands in the same or earlier block.
//
// What this proves:
//   * `BuildMixArgs.chainFrom` plumbs `additionalUtxos` end-to-end.
//   * `BlockfrostProvider.evaluateTxWithAdditionalUtxos` (or the backend
//     provider's equivalent) returns refined exec units for a tx that
//     references in-flight inputs.
//   * `GivemeMyProvider.signTxBody` forwards `additional_utxos` so the
//     host's evaluator agrees.
//
// Failure modes this test catches:
//   * Default evaluator routing (the CBOR-body `/utils/txs/evaluate?version=6`
//     endpoint) doesn't see the in-flight UTxO and aborts with "unknown
//     input" before signing.
//   * giveme.my v1.1.x clients omit `additional_utxos` and the host
//     evaluator returns the same "unknown input" rejection.
//   * `additionalUtxoSet` serialisation drops the inline datum so the
//     evaluator rejects with "missing datum".

import { describe, expect, it } from "vitest";

import {
  buildDepositTx,
  buildMixTx,
  fetchPool,
  fetchProtocolParams,
  loadAddresses,
  loadWallet,
  makeProvider,
  mixBoxAddressBech32,
  NETWORK,
  skipReason,
  type MixInput,
} from "./_lib.js";
import { depositSeries, hexToBytes } from "./_lib.js";
import { encodeMixDatum, type Utxo } from "@lovejoin/sdk";

const reason = skipReason();

describe.skipIf(reason !== null)(`m4 — chained Mix on in-flight Deposit (${NETWORK})`, () => {
  it(
    "mixes an unconfirmed deposit's mix-box via chainFrom",
    async () => {
      const provider = makeProvider();
      const wallet = await loadWallet();
      const addresses = loadAddresses();
      const mixAddress = await mixBoxAddressBech32(addresses);

      // 1. Pre-condition: at least one confirmed pool entry exists. The
      // simplest path is to seed one ourselves — keeps the test
      // hermetic across runs where the pool may have been drained.
      const seeded = await depositSeries({ count: 1, rounds: 5, wallet, provider, addresses });
      expect(seeded).toHaveLength(1);
      const confirmedSeed = seeded[0]!;

      // 2. Submit a Deposit and DO NOT await confirmation.
      const parent = await buildDepositTx({
        network: NETWORK as "preprod" | "preview" | "mainnet",
        rounds: 5,
        wallet,
        provider,
        addresses,
      });
      console.log(`[chain-test] parent deposit submitted: ${parent.txId} (unconfirmed)`);

      // 3. Construct the in-flight mix-box UTxO. Output index is always 0
      // for Lovejoin deposits; inline datum encodes the owner's (a, b).
      const denom = BigInt(addresses.protocol.denom_lovelace);
      const parentMixBoxUtxo: Utxo = {
        ref: { txId: parent.txId, outputIndex: parent.mixBoxOutputIndex },
        address: mixAddress,
        lovelace: denom,
        assets: {},
        inlineDatum: encodeMixDatum({
          a: hexToBytes(parent.owner.aHex),
          b: hexToBytes(parent.owner.publicPointHex),
        }),
        referenceScript: null,
      };

      // 4. Fetch the confirmed seed entry from the pool so we have the
      // canonical address + lovelace + inlineDatum. (The seed deposit's
      // owner material is what we keep; the pool walk just confirms it
      // landed and gives us the on-chain UTxO record.)
      const { params } = await fetchProtocolParams(addresses, provider);
      const pool = await fetchPool({
        provider,
        mixBoxAddressBech32: mixAddress,
        params,
      });
      const confirmedEntry = pool.find(
        (e) => e.ref.txId === confirmedSeed.txId && e.ref.outputIndex === confirmedSeed.outputIndex,
      );
      if (!confirmedEntry) {
        throw new Error(
          `[chain-test] seeded mix-box ${confirmedSeed.txId}#${confirmedSeed.outputIndex} not in pool — indexer drift?`,
        );
      }

      const inputs: MixInput[] = [
        {
          ref: parentMixBoxUtxo.ref,
          a: hexToBytes(parent.owner.aHex),
          b: hexToBytes(parent.owner.publicPointHex),
          utxo: parentMixBoxUtxo,
        },
        {
          ref: confirmedEntry.ref,
          a: confirmedSeed.a,
          b: confirmedSeed.b,
          utxo: {
            ref: confirmedEntry.ref,
            address: mixAddress,
            lovelace: denom,
            assets: {},
            inlineDatum: encodeMixDatum({ a: confirmedSeed.a, b: confirmedSeed.b }),
            referenceScript: null,
          },
        },
      ];

      // 5. Build + submit Mix with chainFrom = the in-flight mix-box.
      const mixResult = await buildMixTx({
        network: NETWORK as "preprod" | "preview" | "mainnet",
        inputs,
        wallet,
        provider,
        addresses,
        chainFrom: {
          utxos: [parentMixBoxUtxo],
          chainDepth: 1,
        },
        retry: { maxAttempts: 3 },
      });

      expect(mixResult.txId).toMatch(/^[0-9a-f]{64}$/);
      expect(mixResult.plan.n).toBe(2);
      console.log(`[chain-test] mix submitted: ${mixResult.txId}`);

      // 6. The parent Deposit must land before (or in the same block
      // as) the Mix. With Cardano's tx-aggregation rules a chained pair
      // typically lands together, but we wait for both with a generous
      // timeout to absorb a slow propagation.
      await provider.awaitConfirmation(parent.txId, 5 * 60_000);
      await provider.awaitConfirmation(mixResult.txId, 5 * 60_000);
    },
    10 * 60_000,
  );
});

if (reason) {
  console.log(`[m4 mix-chain-deposit] SKIP — ${reason}`);
}
