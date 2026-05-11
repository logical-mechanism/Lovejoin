// Shared helpers for the M4 integration tests on Preprod.
//
// Spec: M4 — "Mix tx with n = max_n succeeds",
// "Mix tx with n = 2 succeeds", "Mix when fee shard has just enough;
// rejects when below MAX_FEE_PER_MIX", "full-lifecycle".
//
// The tests follow the same skip-when-unconfigured pattern the M3
// deposit-withdraw test uses: green CI without Preprod credentials, real
// chain interaction when the env is set up.

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import {
  BackendChainProvider,
  BlockfrostProvider,
  buildDepositTx,
  buildMixTx,
  buildWithdrawTx,
  type ChainProvider,
  createCliMeshWallet,
  createMnemonicMeshWallet,
  fetchPool,
  fetchProtocolParams,
  buildScriptAddress,
  type LovejoinAddresses,
  type LovejoinWallet,
  type MixInput,
  type PoolEntry,
  networkIdFor,
  ownsBox,
  type Scalar,
} from "@lovejoin/sdk";

export type Network = "preprod" | "preview" | "test" | "mainnet";

export const NETWORK = (process.env.LOVEJOIN_NETWORK ?? "preprod") as Network;
export const PROJECT_ID = process.env.BLOCKFROST_PROJECT_ID_PREPROD;
export const PAYMENT_SKEY = process.env.LOVEJOIN_PAYMENT_SKEY;
export const STAKE_SKEY = process.env.LOVEJOIN_STAKE_SKEY;
export const MNEMONIC = process.env.LOVEJOIN_MNEMONIC;
export const ADDRESSES_PATH =
  process.env.LOVEJOIN_ADDRESSES ?? `./artifacts/${NETWORK}/addresses.json`;
/**
 * When set, integration tests construct a BackendChainProvider against
 * this URL with the Blockfrost provider as the fallback. Use it to
 * exercise the self-hosted backend's `/evaluate` (and other) routes
 * end-to-end on the same test suite — e.g.
 * `LOVEJOIN_BACKEND_URL=http://localhost:3001 pnpm test`.
 */
export const BACKEND_URL = process.env.LOVEJOIN_BACKEND_URL;

export const HAS_PROJECT_ID = !!PROJECT_ID;
export const HAS_WALLET = !!(PAYMENT_SKEY || MNEMONIC);

export function skipReason(): string | null {
  if (!HAS_PROJECT_ID) return "BLOCKFROST_PROJECT_ID_PREPROD not set";
  if (!HAS_WALLET) return "LOVEJOIN_PAYMENT_SKEY / LOVEJOIN_MNEMONIC not set";
  return null;
}

export function blockfrostBaseUrl(): string {
  if (NETWORK === "mainnet") return "https://cardano-mainnet.blockfrost.io/api/v0";
  if (NETWORK === "preview") return "https://cardano-preview.blockfrost.io/api/v0";
  return "https://cardano-preprod.blockfrost.io/api/v0";
}

/**
 * Construct the chain provider the integration tests use.
 *
 * Default: BlockfrostProvider directly.
 *
 * When `LOVEJOIN_BACKEND_URL` is set: BackendChainProvider against that
 * URL, with the Blockfrost provider as the fallback. The same test
 * suite then exercises the backend's `/submit` + `/evaluate` (including
 * `additionalUtxoSet` forwarding for chainFrom) without changing test
 * code. Drop the env var to revert to a Blockfrost-only run.
 */
export function makeProvider(): ChainProvider {
  const blockfrost = new BlockfrostProvider({
    baseUrl: blockfrostBaseUrl(),
    projectId: PROJECT_ID!,
  });
  if (!BACKEND_URL) return blockfrost;
  console.log(`[integration-tests] using BackendChainProvider at ${BACKEND_URL}`);
  return new BackendChainProvider({
    baseUrl: BACKEND_URL,
    fallback: blockfrost,
  });
}

export async function loadWallet(): Promise<LovejoinWallet> {
  const networkId = networkIdFor(NETWORK);
  if (PAYMENT_SKEY) {
    return createCliMeshWallet({
      networkId,
      payment: PAYMENT_SKEY,
      ...(STAKE_SKEY ? { stake: STAKE_SKEY } : {}),
    });
  }
  if (MNEMONIC) {
    const words = MNEMONIC.split(/[\s,]+/).filter((w) => w.length > 0);
    return createMnemonicMeshWallet({ networkId, mnemonic: words });
  }
  throw new Error("no wallet credentials");
}

export function loadAddresses(): LovejoinAddresses {
  return JSON.parse(readFileSync(resolvePath(ADDRESSES_PATH), "utf8")) as LovejoinAddresses;
}

/**
 * Deposit `count` mix-boxes back-to-back, awaiting confirmation between
 * each so they all live in the pool when the test runs the mix. Returns
 * the recorded ownership material — caller can pick subsets to mix or
 * withdraw later.
 */
export async function depositSeries(args: {
  count: number;
  rounds: number;
  wallet: LovejoinWallet;
  provider: ChainProvider;
  addresses: LovejoinAddresses;
}): Promise<
  Array<{
    txId: string;
    outputIndex: 0;
    secret: Scalar;
    a: Uint8Array;
    b: Uint8Array;
  }>
> {
  const out: Array<{
    txId: string;
    outputIndex: 0;
    secret: Scalar;
    a: Uint8Array;
    b: Uint8Array;
  }> = [];
  for (let i = 0; i < args.count; i++) {
    const r = await buildDepositTx({
      network: NETWORK as "preprod" | "preview" | "mainnet",
      rounds: args.rounds,
      wallet: args.wallet,
      provider: args.provider,
      addresses: args.addresses,
    });
    await args.provider.awaitConfirmation(r.txId, 5 * 60_000);
    out.push({
      txId: r.txId,
      outputIndex: r.mixBoxOutputIndex,
      secret: BigInt(`0x${r.owner.secretHex}`),
      a: hexToBytes(r.owner.aHex),
      b: hexToBytes(r.owner.publicPointHex),
    });
  }
  return out;
}

/**
 * Resolve the mix-script address for the configured network — used to
 * fetch the pool view when the test wants to verify post-mix invariants.
 */
export async function mixBoxAddressBech32(addresses: LovejoinAddresses): Promise<string> {
  return buildScriptAddress(addresses.mixBoxScriptHash, networkIdFor(NETWORK));
}

export { buildDepositTx, buildMixTx, buildWithdrawTx, fetchPool, fetchProtocolParams, ownsBox };
export type { LovejoinAddresses, MixInput, PoolEntry };

export function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (cleaned.length % 2 !== 0) throw new Error("hex string must have even length");
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
