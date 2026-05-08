// Fee-shard donation tx builder.
//
// Spec: §3 (validate_replenish). That section
// lists the on-chain rules a Replenish tx must satisfy. Donation is a
// Replenish-only tx with no mix-box output: the caller's wallet
// contributes lovelace to a fee shard, the same shard datum (`()`) is
// preserved, and the output value strictly exceeds the input. No
// fee_shard_target is changed; a donation just makes the shared fee
// pool wealthier so future Mix txs can drain from it longer.
//
// This is structurally a deposit-without-the-mix-box, so the implementation
// mirrors `deposit.ts`: a pure `planDonateTx` that produces the plan and a
// mesh-driven `buildDonateTx` that wires it up against MeshTxBuilder.

import type { ChainProvider, Lovelace, Utxo, UtxoRef } from "../chain/provider.js";
import { type CollateralProvider, WalletProvider } from "./collateral.js";
import { mergeExternalCollateralWitness } from "./witness-merge.js";
import { getMeshProtocolParams, getMeshProvider } from "./mesh-bridge.js";
import { pickRandomFeeShard } from "./fee.js";
import { REPLENISH_REDEEMER_CBOR_HEX, UNIT_DATUM_CBOR_HEX } from "./deposit.js";
import { fetchProtocolParams, type LovejoinAddresses, parseUtxoRef } from "./params.js";
import { type RetryOptions, withInputCollisionRetry } from "./retry.js";
import { buildScriptAddress } from "./address.js";
import {
  type LovejoinNetworkId,
  type LovejoinWallet,
  networkIdFor,
  normalizeWalletUtxos,
} from "../wallet/cip30.js";

/**
 * Plan for a donation tx: pure data describing the inputs/outputs needed
 * to bump a single fee shard by `donationLovelace`. Produced by
 * `planDonateTx`; consumed by `buildDonateTx`.
 */
export interface DonatePlan {
  /** The fee shard being consumed. */
  feeShardInput: Utxo;
  /** The replenished fee shard output. */
  feeShardOutput: {
    addressBech32: string;
    lovelace: Lovelace;
    /** Plutus-Data CBOR hex of `()` (Constr 0 []). */
    inlineDatumHex: string;
  };
  /** Plutus-Data CBOR hex of the `Replenish` redeemer (Constr 1 []). */
  replenishRedeemerHex: string;
  /** Reference UTxO read at validation time (read-only via reference inputs). */
  referenceUtxoRef: UtxoRef;
  /** CIP-33 reference-script UTxO for the fee_contract validator. */
  feeContractRefScriptUtxoRef: UtxoRef;
}

export interface PlanDonateArgs {
  /** Lovelace contribution from the donor. Must be a positive integer. */
  donationLovelace: Lovelace;
  /** Fee shard to top up. */
  feeShard: Utxo;
  /** Bootstrap addresses.json. Provides script hashes + reference UTxO. */
  addresses: LovejoinAddresses;
  /** Network discriminator for bech32 address construction. */
  networkId: LovejoinNetworkId;
}

export function planDonateTx(args: PlanDonateArgs): DonatePlan {
  if (args.donationLovelace <= 0n) {
    throw new Error(`donationLovelace must be a positive integer, got ${args.donationLovelace}`);
  }
  const feeAddress = buildScriptAddress(args.addresses.feeScriptHash, args.networkId);
  return {
    feeShardInput: args.feeShard,
    feeShardOutput: {
      addressBech32: feeAddress,
      lovelace: args.feeShard.lovelace + args.donationLovelace,
      inlineDatumHex: UNIT_DATUM_CBOR_HEX,
    },
    replenishRedeemerHex: REPLENISH_REDEEMER_CBOR_HEX,
    referenceUtxoRef: parseUtxoRef(args.addresses.referenceUtxoRef),
    feeContractRefScriptUtxoRef: parseUtxoRef(args.addresses.referenceScriptUtxos.fee_contract),
  };
}

export interface BuildDonateArgs {
  network: "preprod" | "preview" | "test" | "mainnet";
  /** Lovelace contribution from the donor. */
  donationLovelace: Lovelace;
  /** User wallet. Supplies inputs, change, collateral, and signing. */
  wallet: LovejoinWallet;
  /** Chain provider. Reads reference UTxO + protocol params + submits. */
  provider: ChainProvider;
  /** Bootstrap addresses.json content. */
  addresses: LovejoinAddresses;
  /** Optional pre-picked fee shard. Default: pick uniformly at random. */
  feeShard?: Utxo;
  /**
   * Optional UTxO refs to exclude when picking a fee shard. Reserved
   * for mempool-aware shard selection: a future backend follow-up can
   * expose the set of refs that are already inputs to in-flight txs,
   * and the SDK skips them. Without this, the SDK picks uniformly
   * across all live shards regardless of mempool state.
   *
   * No UI surface populates this today; staged so the backend wiring
   * is the only thing left to add when we lift it from a hint to a
   * real check.
   */
  excludeFeeShardRefs?: ReadonlyArray<UtxoRef>;
  /** Optional collateral provider. Default: WalletProvider(wallet). */
  collateralProvider?: CollateralProvider;
  /** If true, sign but don't submit. Default: false. */
  signOnly?: boolean;
  /**
   * Retry behaviour on input collisions. The fee_contract has only 10
   * shards and they're hot under mix activity; a donation that picked
   * a shard that was just consumed by a Mix tx would otherwise fail
   * with `BadInputsUTxO` and require the user to re-sign manually.
   * When `retry.maxAttempts > 1`, the SDK re-picks a fresh shard,
   * rebuilds, and re-asks the wallet to sign on each retry.
   *
   * Default: no retry (1 attempt). UI typically passes `{ maxAttempts: 3 }`.
   */
  retry?: RetryOptions;
}

export interface DonateResult {
  /** Signed tx CBOR hex. */
  signedTxHex: string;
  /** Tx hash returned by the chain provider (empty when signOnly). */
  txId: string;
  /** The fee shard reference that was topped up. */
  feeShardRef: UtxoRef;
  /** Final lovelace value of the topped-up shard. */
  newShardLovelace: Lovelace;
}

/**
 * Build, sign, and (optionally) submit a fee-shard donation tx on Cardano.
 *
 * Output: a single fee shard with the same `()` inline datum and
 * `donationLovelace` more lovelace than the input shard. The on-chain
 * `validate_replenish` rule only insists that the new value strictly
 * exceeds the old one, so any positive contribution is accepted. mesh
 * handles fee + change against the donor's wallet.
 *
 * Unlike Mix, this tx has the donor's wallet on it. There is no
 * anonymity claim for donations, by design. The fee_contract still
 * blocks native assets in/out per Rule 6, so the tx is ada-only.
 */
export async function buildDonateTx(args: BuildDonateArgs): Promise<DonateResult> {
  if (args.donationLovelace <= 0n) {
    throw new Error(`donationLovelace must be a positive integer, got ${args.donationLovelace}`);
  }
  const networkId = networkIdFor(args.network);

  // We don't need the params for tx construction (the on-chain Replenish
  // rule doesn't reference any of the on-chain ReferenceDatum fields), but
  // we still call this to fail loudly when addresses.json disagrees with
  // the chain. Same defense-in-depth as `buildDepositTx`.
  await fetchProtocolParams(args.addresses, args.provider);

  const feeAddress = buildScriptAddress(args.addresses.feeScriptHash, networkId);
  const collateral = args.collateralProvider ?? new WalletProvider(args.wallet);

  // Build + sign + submit, with retry on input collision. Retry semantics:
  //   * Attempt 1 honours `args.feeShard` (caller's pre-pick wins).
  //   * Attempts 2+ ignore `args.feeShard` and pick a fresh shard from
  //     chain. Reusing the caller's pre-pick on a retry would just hit the
  //     same BadInputsUTxO again. Each retry rebuilds the tx body so the
  //     wallet signs the new body.
  return withInputCollisionRetry(async (attempt) => {
    const feeShard =
      attempt === 1 && args.feeShard
        ? args.feeShard
        : await pickRandomFeeShard({
            provider: args.provider,
            feeScriptAddressBech32: feeAddress,
            ...(args.excludeFeeShardRefs && args.excludeFeeShardRefs.length > 0
              ? { excludeRefs: args.excludeFeeShardRefs }
              : {}),
          });

    const plan = planDonateTx({
      donationLovelace: args.donationLovelace,
      feeShard,
      addresses: args.addresses,
      networkId,
    });

    const preparedCollateral = await collateral.prepareCollateral({
      provider: args.provider,
      collateralAmountLovelace: 5_000_000n,
    });

    const { MeshTxBuilder } = await import("@meshsdk/core");
    const meshProvider = await getMeshProvider(args.provider);
    const meshParams = await getMeshProtocolParams(args.provider);
    const txBuilder = new MeshTxBuilder({
      fetcher: meshProvider as never,
      submitter: meshProvider as never,
      evaluator: meshProvider as never,
      params: meshParams as never,
      verbose: false,
    });
    txBuilder.txEvaluationMultiplier = 1;

    const walletUtxos = normalizeWalletUtxos(await args.wallet.getUtxos());
    const changeAddress = await args.wallet.getChangeAddress();

    txBuilder
      .readOnlyTxInReference(plan.referenceUtxoRef.txId, plan.referenceUtxoRef.outputIndex)
      .spendingPlutusScriptV3()
      .txIn(
        plan.feeShardInput.ref.txId,
        plan.feeShardInput.ref.outputIndex,
        [{ unit: "lovelace", quantity: plan.feeShardInput.lovelace.toString() }],
        plan.feeShardOutput.addressBech32,
      )
      .txInInlineDatumPresent()
      .txInRedeemerValue(plan.replenishRedeemerHex, "CBOR")
      .spendingTxInReference(
        plan.feeContractRefScriptUtxoRef.txId,
        plan.feeContractRefScriptUtxoRef.outputIndex,
        args.addresses.referenceScriptSizes?.fee_contract?.toString(),
        args.addresses.feeScriptHash,
      )
      .txOut(plan.feeShardOutput.addressBech32, [
        { unit: "lovelace", quantity: plan.feeShardOutput.lovelace.toString() },
      ])
      .txOutInlineDatumValue(plan.feeShardOutput.inlineDatumHex, "CBOR")
      .changeAddress(changeAddress)
      .selectUtxosFrom(walletUtxos);

    for (const utxo of preparedCollateral.inputs) {
      txBuilder.txInCollateral(
        utxo.ref.txId,
        utxo.ref.outputIndex,
        [{ unit: "lovelace", quantity: utxo.lovelace.toString() }],
        utxo.address,
      );
    }
    if (preparedCollateral.requiredSignerPkhHex) {
      txBuilder.requiredSignerHash(preparedCollateral.requiredSignerPkhHex);
    }

    const unsignedTx = await txBuilder.complete();
    const walletSignedTx = await args.wallet.signTx(unsignedTx);
    const signedTx = preparedCollateral.externallySigned
      ? await mergeExternalCollateralWitness(collateral, walletSignedTx)
      : walletSignedTx;

    if (args.signOnly) {
      return {
        signedTxHex: signedTx,
        txId: "",
        feeShardRef: plan.feeShardInput.ref,
        newShardLovelace: plan.feeShardOutput.lovelace,
      };
    }

    const txId = await args.provider.submitTx(signedTx);
    return {
      signedTxHex: signedTx,
      txId,
      feeShardRef: plan.feeShardInput.ref,
      newShardLovelace: plan.feeShardOutput.lovelace,
    };
  }, args.retry);
}
