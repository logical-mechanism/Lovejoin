// Indexer prime path — bulk-load the live pool / fee shards / reference
// NFT location from db-sync at cold start (and on deep-rollback recovery)
// so chainsync can resume from db-sync's tip instead of replaying every
// block from `bootstrapStartPoint`.
//
// Spec: docs/spec/05-backend.md §"Cold-start prime" (issue #87).
//
// Why a separate module:
//   - The `IndexerState` is the "what is the current chain state"
//     model and shouldn't know about db-sync.
//   - The `DbSyncClient` exposes a chain-shaped query and shouldn't
//     know about indexer state internals.
//   - The runtime needs a single callable `() => Promise<ChainTip>`
//     so the prime path is the same on cold start and on
//     `DeepRollbackError` recovery.
//
// This module is the seam between those three.

import type { DbSyncClient, DbSyncUtxo, ProtocolPrimeParams } from "../db/dbsync.js";
import type { IndexerState, PrimeSnapshot } from "./state.js";
import type { ChainTip, ProducedUtxo } from "./types.js";

export interface PrimeContext {
  state: IndexerState;
  dbsync: DbSyncClient;
  params: ProtocolPrimeParams;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

/**
 * Cold-start / recovery prime. Pulls the latest live snapshot from
 * db-sync, resets the in-memory state to it, and returns the tip so
 * the caller can use it as a chainsync intersection point.
 *
 * Errors propagate so the caller decides between "fall back to replay"
 * (cold start) and "fatal halt" (deep-rollback recovery exhausted its
 * options). We do not retry inside this function — the runtime owns
 * the retry policy at its scope.
 */
export async function primeFromDbSync(ctx: PrimeContext): Promise<ChainTip> {
  // Wall-clock timing on the db-sync round-trip is the operator's
  // signal that the prime is starting to creep toward the danger
  // zone. On Preprod with a small live pool it should be well under
  // a second; on a busy mainnet pool with the legacy NOT EXISTS
  // path it can scale to many seconds. Log every prime so the trend
  // is visible across deploys.
  const startedAt = Date.now();
  const snapshot = await ctx.dbsync.primeProtocolState(ctx.params);
  const elapsedMs = Date.now() - startedAt;

  const mixBoxUtxos = snapshot.mixBoxUtxos.map((u) =>
    dbsyncToProduced(u, ctx.params.mixBoxAddress),
  );
  const feeShardUtxos = snapshot.feeShardUtxos.map((u) =>
    dbsyncToProduced(u, ctx.params.feeContractAddress),
  );
  const referenceUtxo = snapshot.referenceUtxo
    ? dbsyncToProduced(snapshot.referenceUtxo, snapshot.referenceUtxo.address)
    : null;

  const primeSnapshot: PrimeSnapshot = {
    tip: snapshot.tip,
    mixBoxUtxos,
    feeShardUtxos,
    referenceUtxo,
  };
  ctx.state.primeFrom(primeSnapshot);

  ctx.logger?.info(
    `prime: applied snapshot at slot ${snapshot.tip.slot} (height ${snapshot.tip.height}) in ${elapsedMs}ms: ` +
      `${mixBoxUtxos.length} mix-box, ${feeShardUtxos.length} fee shard, reference=${
        referenceUtxo ? "ok" : "missing"
      }`,
  );
  if (!referenceUtxo) {
    ctx.logger?.warn(
      "prime: reference NFT not observed in db-sync; running with referenceAlarm set " +
        "(bootstrap not yet applied, or db-sync lagging the bootstrap tx)",
    );
  }
  return snapshot.tip;
}

/**
 * Translate a `DbSyncUtxo` into the `ProducedUtxo` shape the indexer
 * state model already understands. This is a structural rename — the
 * inline datum CBOR, lovelace, address, and asset map all carry over
 * verbatim. We pass `address` explicitly so the reference-UTxO branch
 * can supply whatever address db-sync recorded (the validator address
 * may not match `referenceHolderAddress` if NETWORK is misconfigured;
 * the indexer keys on the NFT, not the address).
 */
function dbsyncToProduced(u: DbSyncUtxo, address: string): ProducedUtxo {
  return {
    ref: { txId: u.txHash, outputIndex: u.outputIndex },
    address,
    lovelace: u.lovelace,
    inlineDatumHex: u.inlineDatum,
    assets: u.assets,
  };
}
