// Wallet-funding consolidation pre-tx for the batch fan-out path.
//
// ## The bug this fixes
//
// Wallet-funded batch fan-out (`planFanoutTxs`) builds every Mix tx up
// front in `buildOnly` mode, threading the wallet's change UTxO from
// each leaf into the next so the whole tree forms one in-flight chain.
// If the wallet starts with MORE THAN ONE spendable UTxO, mesh's coin
// selection picks a different one per leaf — and once the rolling set
// holds several candidates, two sibling leaves can select the SAME
// wallet UTxO. They double-spend it: the first to reach a node's
// mempool wins, the rest are rejected on chain with `BadInputsUTxO`
// (ogmios JSON-RPC error 3117). A 21-leaf run lands ~5 txs and drops
// the other 16.
//
// ## The fix
//
// Before building the tree, consolidate the wallet's spendable balance
// into a SINGLE funding UTxO sized for the whole run. Each leaf is then
// handed exactly one candidate (this UTxO for leaf 0, then strictly its
// predecessor's change). With one candidate, coin selection has no
// freedom — the funding UTxO threads cleanly leaf → leaf and no two
// siblings can collide.
//
// The consolidation tx is a plain wallet self-send: spendable
// (non-collateral) UTxOs in, one fixed-size funding output out (plus
// mesh's leftover change). It rides along in the same CIP-103
// `signTxs` prompt as the leaves and is submitted before any of them.

import type { ChainProvider, Utxo } from "../chain/provider.js";
import type { UTxO as MeshUtxo } from "@meshsdk/core";
import { getMeshCostModels, getMeshProtocolParams, getMeshProvider } from "../tx/mesh-bridge.js";

/**
 * Per-leaf lovelace budget baked into the consolidated funding UTxO.
 * A wallet-mode Mix tx pays its real protocol fee (~1.27 ADA observed
 * on Preprod at N=4); 2 ADA leaves comfortable headroom so every leaf's
 * change output stays well above the min-UTxO floor.
 */
export const PER_LEAF_FUNDING_LOVELACE = 2_000_000n;

/**
 * Slack added on top of `nLeaves × PER_LEAF_FUNDING_LOVELACE` so the
 * final leaf's change output (which returns to the wallet) clears the
 * min-UTxO floor with room to spare.
 */
export const TRAILING_FUNDING_LOVELACE = 3_000_000n;

/** Output of {@link buildFanoutFundingTx}. */
export interface FanoutFundingTx {
  /** Unsigned consolidation tx, ready for `wallet.signTxs`. */
  unsignedTxHex: string;
  /** Tx id derived from the unsigned body (witnesses don't affect it). */
  txId: string;
  /**
   * The single consolidated output (always index 0). Seeds the leaf
   * chain: `planFanoutTxs` hands this to leaf 0 and threads its
   * descendants forward.
   */
  fundingUtxo: Utxo;
}

/** Arguments for {@link buildFanoutFundingTx}. */
export interface BuildFanoutFundingTxArgs {
  provider: ChainProvider;
  /**
   * Spendable wallet UTxOs to consolidate. The caller MUST have already
   * excluded the wallet's designated collateral UTxO(s) — those are
   * reused as collateral on every leaf and must not be spent here.
   */
  walletUtxos: ReadonlyArray<MeshUtxo>;
  /** Wallet change address; the consolidated UTxO lands here too. */
  changeAddress: string;
  /** Exact lovelace to place in the consolidated funding output. */
  fundingLovelace: bigint;
}

/**
 * Build the (unsigned) wallet self-send that consolidates `walletUtxos`
 * into a single `fundingLovelace` output. The funding output is always
 * at index 0; mesh appends its own leftover change after it.
 *
 * Pure build — no signing, no submission. The caller batches the
 * returned `unsignedTxHex` into the CIP-103 `signTxs` prompt and submits
 * it ahead of the fan-out leaves.
 */
export async function buildFanoutFundingTx(
  args: BuildFanoutFundingTxArgs,
): Promise<FanoutFundingTx> {
  const { provider, walletUtxos, changeAddress, fundingLovelace } = args;
  if (walletUtxos.length === 0) {
    throw new Error("buildFanoutFundingTx: no spendable wallet UTxOs to consolidate");
  }

  const { MeshTxBuilder } = await import("@meshsdk/core");
  const meshProvider = await getMeshProvider(provider);
  const meshParams = await getMeshProtocolParams(provider);
  const meshCostModels = await getMeshCostModels(provider);

  const tx = new MeshTxBuilder({
    fetcher: meshProvider as never,
    submitter: meshProvider as never,
    params: meshParams as never,
    verbose: false,
  });
  // Pin live cost models for the script-integrity hash. A plain tx
  // carries no scripts so this is a no-op today, but it keeps the
  // funding tx consistent with the leaves should that ever change.
  if (meshCostModels) tx.setNetwork(meshCostModels);

  // One explicit fixed-size output — the funding UTxO. It is emitted
  // before mesh's change output, and the Conway ledger preserves output
  // order, so the funding UTxO is deterministically at index 0.
  tx.txOut(changeAddress, [{ unit: "lovelace", quantity: fundingLovelace.toString() }]);
  tx.changeAddress(changeAddress);
  tx.selectUtxosFrom(walletUtxos as never);

  let unsignedTxHex: string;
  try {
    unsignedTxHex = await tx.complete();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `buildFanoutFundingTx: could not consolidate ${fundingLovelace} lovelace ` +
        `from ${walletUtxos.length} wallet UTxO(s). The wallet balance may be too ` +
        `low or too fragmented. Original error: ${msg}`,
    );
  }

  const cst = await import("@meshsdk/core-cst");
  const txId = String(cst.resolveTxHash(unsignedTxHex)).toLowerCase();

  return {
    unsignedTxHex,
    txId,
    fundingUtxo: {
      ref: { txId, outputIndex: 0 },
      address: changeAddress,
      lovelace: fundingLovelace,
      assets: {},
      inlineDatum: null,
      referenceScript: null,
    },
  };
}
