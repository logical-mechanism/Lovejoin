// Random N-tuple selection over a pool of mix-boxes.
//
// Spec: docs/spec/04-offchain.md §"Random N-tuple selection".
//
// The Mix tx submitter picks N pool entries to re-randomize together. To
// preserve the (1/N)^k linkage-probability bound, the choice MUST be
// unbiased — the simple `pool.slice(0, n)` would let an adversary submit
// targeted "mix me with these specific boxes" txs and flatly skew the
// per-round entropy. We use rejection-sampled integers from
// `crypto.getRandomValues` for the index draws (same source the SDK uses
// for secret-key generation).
//
// `pickRandomNTuple(pool, n)` is a uniform random sample without replacement.
// Tests pass a deterministic `rng` so the N-tuple is reproducible.

import { cryptoRandomInt, type RandomInt } from "../tx/fee.js";

import type { PoolEntry } from "./identify.js";

/**
 * Pick `n` distinct entries from `pool` uniformly at random (no replacement).
 *
 * `n` is clamped to `min(n, pool.length - excludeRefs.length)` so callers can
 * say "give me up to N" without splitting the request branch. Returns the
 * empty array iff the eligible pool is empty.
 *
 * Algorithm: partial Fisher-Yates over the eligible array — O(eligible.length)
 * memory, O(n) RNG draws. We choose this over rejection sampling-by-index
 * (which has worst-case unbounded retries when n approaches eligible.length)
 * and over reservoir sampling (which is O(eligible.length) draws).
 */
export function pickRandomNTuple(args: {
  pool: ReadonlyArray<PoolEntry>;
  n: number;
  /** UtxoRefs to exclude — useful when caller has tx_in-flight boxes. */
  excludeRefs?: ReadonlyArray<{ txId: string; outputIndex: number }>;
  rng?: RandomInt;
}): PoolEntry[] {
  if (!Number.isInteger(args.n) || args.n < 0) {
    throw new Error(`pickRandomNTuple: n must be a non-negative integer, got ${args.n}`);
  }
  const exclude = new Set((args.excludeRefs ?? []).map((r) => `${r.txId}#${r.outputIndex}`));
  const eligible = args.pool.filter((e) => !exclude.has(`${e.ref.txId}#${e.ref.outputIndex}`));
  if (eligible.length === 0 || args.n === 0) return [];
  const n = Math.min(args.n, eligible.length);
  const rng = args.rng ?? cryptoRandomInt;

  // Partial Fisher-Yates: copy the eligible array (immutable input), swap the
  // first n positions with random indices in [i, eligible.length), return the
  // first n. This guarantees uniform sample without replacement.
  const work = eligible.slice();
  for (let i = 0; i < n; i++) {
    const j = i + rng(work.length - i);
    if (j !== i) {
      const tmp = work[i]!;
      work[i] = work[j]!;
      work[j] = tmp;
    }
  }
  return work.slice(0, n);
}

/**
 * Pick a random permutation of `[0, n)`. Used by the Mix tx builder to
 * decide which input maps to which output position. Same algorithm as
 * pickRandomNTuple, just over indices.
 */
export function randomPermutation(n: number, rng?: RandomInt): number[] {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`randomPermutation: n must be a non-negative integer, got ${n}`);
  }
  const draw = rng ?? cryptoRandomInt;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i);
  // Fisher-Yates over the full array.
  for (let i = n - 1; i > 0; i--) {
    const j = draw(i + 1);
    if (j !== i) {
      const tmp = out[i]!;
      out[i] = out[j]!;
      out[j] = tmp;
    }
  }
  return out;
}

/**
 * Inverse of a permutation: `inv[p[i]] === i`. Useful for the Mix builder —
 * the prover knows "input i went to output position permutation[i]"; the
 * verifier checks per output. The inverse maps output position → input index.
 */
export function inversePermutation(p: ReadonlyArray<number>): number[] {
  const out = new Array<number>(p.length);
  for (let i = 0; i < p.length; i++) {
    const j = p[i]!;
    if (!Number.isInteger(j) || j < 0 || j >= p.length) {
      throw new Error(`inversePermutation: index ${j} at position ${i} out of range`);
    }
    if (out[j] !== undefined) {
      throw new Error(`inversePermutation: duplicate target ${j}`);
    }
    out[j] = i;
  }
  return out;
}
