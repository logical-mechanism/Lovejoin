// Mix-input picker with the shard / wallet / owned-bias strategy.
//
// Branch table:
//   shard mode                              → uniform random
//   wallet mode + owned set empty           → uniform random
//   wallet mode + nothing owned in pool     → uniform random
//   wallet mode + pool ≥ POOL_BIAS_THRESHOLD → uniform random
//   wallet mode + small pool + owned in pool:
//     - if non-owned has ≥ n-1 entries → 1 random owned + (n-1) random non-owned
//     - else (owned dominates the pool) → uniform random over the whole pool
//
// The wallet's pkh is already on the tx (it pays the fee), so an observer
// can correlate submitter→inputs anyway; the privacy floor isn't moved
// by force-inclusion. What it DOES buy is real progress for the fee
// being spent. an early-pool user paying for wallet-mode wants to
// actively advance their own box's anonymity.

import type { MixFeePayer } from "@lovejoin/sdk";

/** Pool-size cutoff for wallet-mode owned-box biasing. */
export const POOL_BIAS_THRESHOLD = 8;

function refKey(ref: { txId: string; outputIndex: number }): string {
  return `${ref.txId.toLowerCase()}#${ref.outputIndex}`;
}

/**
 * Pure function. exported for unit tests so we can pin every branch.
 * Returns an array of length `n`. Caller is responsible for ensuring
 * `pool.length >= n`.
 */
export function pickMixInputs<T extends { ref: { txId: string; outputIndex: number } }>(args: {
  pool: ReadonlyArray<T>;
  n: number;
  feePayer: MixFeePayer;
  ownedRefs: ReadonlySet<string>;
}): T[] {
  const { pool, n, feePayer, ownedRefs } = args;

  const useBias = feePayer === "wallet" && ownedRefs.size > 0 && pool.length < POOL_BIAS_THRESHOLD;

  if (!useBias) {
    return pickRandomBoxes(pool, n);
  }

  const ownedInPool = pool.filter((e) => ownedRefs.has(refKey(e.ref)));
  if (ownedInPool.length === 0) {
    return pickRandomBoxes(pool, n);
  }

  const notOwned = pool.filter((e) => !ownedRefs.has(refKey(e.ref)));
  if (notOwned.length < n - 1) {
    return pickRandomBoxes(pool, n);
  }

  const ownedPick = ownedInPool[Math.floor(Math.random() * ownedInPool.length)]!;
  const others = pickRandomBoxes(notOwned, n - 1);
  return [ownedPick, ...others];
}

function pickRandomBoxes<T>(items: ReadonlyArray<T>, n: number): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr.slice(0, n);
}
