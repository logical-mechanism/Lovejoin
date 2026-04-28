// Re-exports for the M4 stress-test runners. The runners depend on
// the @lovejoin/sdk's M4 surface (buildMixTx, fetchPool,
// pickRandomNTuple) plus a couple of helpers that only the runners
// need (Blockfrost evaluator HTTP call, calibration wallet loader).

import { resolve } from "node:path";

import {
  type ChainProvider,
  buildDepositTx,
  createCliMeshWallet,
  createMnemonicMeshWallet,
  type LovejoinAddresses,
  type LovejoinWallet,
  networkIdFor,
} from "@lovejoin/sdk";

export {
  type LovejoinAddresses,
  buildMixTx,
  buildScriptAddress,
  fetchPool,
  fetchProtocolParams,
  pickRandomNTuple,
  type MixInput,
} from "@lovejoin/sdk";

export interface CalibrationWalletOpts {
  network: string;
}

export async function loadCalibrationWallet(
  opts: CalibrationWalletOpts,
): Promise<LovejoinWallet> {
  const networkId = networkIdFor(opts.network);
  if (process.env.LOVEJOIN_PAYMENT_SKEY) {
    return createCliMeshWallet({
      networkId,
      payment: process.env.LOVEJOIN_PAYMENT_SKEY,
      ...(process.env.LOVEJOIN_STAKE_SKEY
        ? { stake: process.env.LOVEJOIN_STAKE_SKEY }
        : {}),
    });
  }
  if (process.env.LOVEJOIN_MNEMONIC) {
    const words = process.env.LOVEJOIN_MNEMONIC.split(/[\s,]+/).filter(
      (w) => w.length > 0,
    );
    return createMnemonicMeshWallet({ networkId, mnemonic: words });
  }
  throw new Error(
    "calibration wallet: set LOVEJOIN_PAYMENT_SKEY or LOVEJOIN_MNEMONIC",
  );
}

/**
 * Deposit a series of N mix-boxes back-to-back. Used to seed the pool
 * for max-n-calibration when the existing pool is too small.
 */
export async function depositSeriesForCalibration(args: {
  count: number;
  rounds: number;
  wallet: LovejoinWallet;
  provider: ChainProvider;
  addresses: LovejoinAddresses;
  network: string;
}): Promise<string[]> {
  const txIds: string[] = [];
  for (let i = 0; i < args.count; i++) {
    const r = await buildDepositTx({
      network: args.network as "preprod" | "preview" | "mainnet",
      rounds: args.rounds,
      wallet: args.wallet,
      provider: args.provider,
      addresses: args.addresses,
    });
    await args.provider.awaitConfirmation(r.txId, 5 * 60_000);
    txIds.push(r.txId);
  }
  return txIds;
}

/**
 * POST a CBOR-hex tx body to Blockfrost's `/utils/txs/evaluate` endpoint and
 * sum the returned per-redeemer exec units. Used by max-n-calibration to get
 * tight CPU/mem totals without actually submitting the tx.
 */
export async function evaluateUnsignedTx(args: {
  provider: ChainProvider;
  cborHex: string;
}): Promise<{ cpu: bigint; mem: bigint }> {
  // The provider's hidden mesh sibling exposes evaluateTx; reuse that.
  const meshProvider = await (
    args.provider as unknown as {
      meshProvider?: () => Promise<{
        evaluateTx(cbor: string): Promise<unknown>;
      }>;
    }
  ).meshProvider!();
  const raw = await meshProvider.evaluateTx(args.cborHex);
  if (!Array.isArray(raw)) {
    throw new Error(`evaluateUnsignedTx: expected array, got ${typeof raw}`);
  }
  let cpu = 0n;
  let mem = 0n;
  for (const a of raw as Array<{ budget?: { mem?: number; steps?: number } }>) {
    if (a.budget) {
      if (typeof a.budget.steps === "number") cpu += BigInt(a.budget.steps);
      if (typeof a.budget.mem === "number") mem += BigInt(a.budget.mem);
    }
  }
  return { cpu, mem };
}

void resolve;
