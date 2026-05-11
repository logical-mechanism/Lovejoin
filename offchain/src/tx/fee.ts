// Fee-shard selection.
//
// Spec: §"Fee contract: 10 sharded UTxOs" and
//  §3.
//
// The fee_contract is a logical pool of `fee_shard_target` (= 10) UTxOs at
// the same script address. SDK callers pick one uniformly at random for
// each tx — this gives us a 10x concurrency boost (a Mix tx and a Deposit
// tx can run in parallel as long as they pick different shards) and avoids
// hot-spotting one shard as the canonical fee bucket.
//
// We expose a small interface around random selection so tests can inject a
// deterministic RNG. Production code uses `crypto.getRandomValues` (browser
// + Node 18+) which is what the rest of the SDK uses for secret-key gen.

import type { ChainProvider, Lovelace, Utxo } from "../chain/provider.js";

import type { LovejoinAddresses, ProtocolParams } from "./params.js";

/**
 * A fee shard candidate as it appears on chain. The Plutus-Data inline datum
 * on every legitimate fee shard is `Constr 0 []` (the unit constructor) — its
 * canonical CBOR is the 2-byte sequence `d8 79 80` (tag 121 + zero-length
 * array). We accept any shard whose inline datum starts with that prefix
 * rather than insisting on byte-equality, so future canonical re-encodings
 * (or extra trailing bytes from a misbehaving wallet) don't lock us out.
 */
const UNIT_DATUM_HEX = "d87980";

/** Random-number source. Returns an integer in [0, n). */
export type RandomInt = (n: number) => number;

/**
 * The default RandomInt: rejection-sampling on `crypto.getRandomValues`. We
 * can't just `Math.floor(Math.random() * n)` for fee selection — the choice
 * of shard ought to be bias-free even on tiny pool sizes. Rejection sampling
 * gives a uniform distribution.
 */
export function cryptoRandomInt(n: number): number {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`cryptoRandomInt: n must be a positive integer, got ${n}`);
  }
  // For n up to 2^31 we can use a 32-bit draw with rejection.
  if (n > 0x7fff_ffff) {
    throw new Error(`cryptoRandomInt: n too large (${n})`);
  }
  const buf = new Uint32Array(1);
  const cap = Math.floor(0x1_0000_0000 / n) * n;
  // Use globalThis.crypto so the SDK works in browsers, Node 18+, and edge runtimes.
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.getRandomValues) {
    throw new Error("cryptoRandomInt: globalThis.crypto.getRandomValues unavailable");
  }
  while (true) {
    c.getRandomValues(buf);
    const v = buf[0]!;
    if (v < cap) return v % n;
  }
}

/**
 * True iff `utxo` looks like a legitimate fee shard:
 *   * lives at the fee script
 *   * has the inline `()` datum
 *   * carries no native assets
 *
 * The protocol's hyperstructure recovery rule (Rule 2 in
 *  §0) means malformed UTxOs at the fee script can
 * be swept by anyone; we just don't want to use them as fee shards. Native
 * assets fail the on-chain `validate_pay_mix_fee` rule 6, so picking such a
 * UTxO would deterministically fail tx submission.
 */
export function isFeeShardCandidate(utxo: Utxo, feeScriptAddressBech32: string): boolean {
  if (utxo.address !== feeScriptAddressBech32) return false;
  if (Object.keys(utxo.assets).length > 0) return false;
  if (!utxo.inlineDatum) return false;
  return utxo.inlineDatum.toLowerCase().startsWith(UNIT_DATUM_HEX);
}

/**
 * Find every fee shard at the configured address. The chain provider returns
 * the full UTxO set at the fee script; we filter down to legitimate shards.
 *
 * Throws if zero shards are found — the protocol can't deposit/mix without
 * one and the SDK shouldn't silently fall through to a malformed tx.
 */
export async function listFeeShards(args: {
  provider: ChainProvider;
  feeScriptAddressBech32: string;
}): Promise<Utxo[]> {
  const all = await args.provider.getUtxos(args.feeScriptAddressBech32);
  const shards = all.filter((u) => isFeeShardCandidate(u, args.feeScriptAddressBech32));
  if (shards.length === 0) {
    throw new Error(
      `no fee shards found at ${args.feeScriptAddressBech32}; bootstrap is incomplete or shards have all been consumed`,
    );
  }
  return shards;
}

/**
 * Pick one fee shard uniformly at random.
 *
 * `excludeRefs` is for callers that want to avoid a shard they already know
 * is in flight (e.g., a tx they just submitted but haven't confirmed yet).
 * If excluding leaves zero candidates we fall back to the full set rather
 * than throwing — concurrency hint, not a hard constraint.
 *
 * `minLovelace` is a hard floor: shards holding less than this are filtered
 * out and never picked. Mix passes 3 ADA so the shard can cover its own
 * tx fee + min-utxo on the recreated shard output without going negative.
 * Donate and Deposit intentionally leave it unset; they top shards up and
 * MUST be allowed to target depleted ones. Throws if no shard meets the
 * floor (preferable to a guaranteed-failing tx submit).
 */
export function pickRandomShard(args: {
  shards: Utxo[];
  excludeRefs?: ReadonlyArray<{ txId: string; outputIndex: number }>;
  minLovelace?: Lovelace;
  rng?: RandomInt;
}): Utxo {
  const rng = args.rng ?? cryptoRandomInt;
  if (args.shards.length === 0) {
    throw new Error("pickRandomShard: empty shard list");
  }
  const above =
    args.minLovelace !== undefined
      ? args.shards.filter((s) => s.lovelace >= args.minLovelace!)
      : args.shards;
  if (above.length === 0) {
    throw new Error(
      `pickRandomShard: no shard holds at least ${args.minLovelace} lovelace; ` +
        `donate to the fee pool to top it up`,
    );
  }
  const exclude = new Set((args.excludeRefs ?? []).map((r) => `${r.txId}#${r.outputIndex}`));
  const eligible = above.filter((s) => !exclude.has(`${s.ref.txId}#${s.ref.outputIndex}`));
  const candidates = eligible.length > 0 ? eligible : above;
  return candidates[rng(candidates.length)]!;
}

/**
 * Convenience wrapper combining listFeeShards + pickRandomShard. Most call
 * sites in the tx builders just want "give me a shard."
 *
 * `extraShards` lets callers splice in synthetic shards that aren't on
 * chain yet — typically the post-state output of an in-flight Replenish.
 * They're considered alongside the chain-confirmed shards for selection,
 * after the `minLovelace` floor and `excludeRefs` filter. This is the
 * include-polarity companion to `excludeRefs`: `excludeRefs` skips an
 * in-flight shard *input*; `extraShards` admits an in-flight shard
 * *output*. Callers chaining off a parent tx supply both — exclude the
 * parent's input shard, include the parent's output shard.
 */
export async function pickRandomFeeShard(args: {
  provider: ChainProvider;
  feeScriptAddressBech32: string;
  excludeRefs?: ReadonlyArray<{ txId: string; outputIndex: number }>;
  minLovelace?: Lovelace;
  rng?: RandomInt;
  /** In-flight shard outputs to consider alongside the chain-confirmed set. */
  extraShards?: ReadonlyArray<Utxo>;
}): Promise<Utxo> {
  const onChain = await listFeeShards({
    provider: args.provider,
    feeScriptAddressBech32: args.feeScriptAddressBech32,
  });
  const extras = (args.extraShards ?? []).filter((u) =>
    isFeeShardCandidate(u, args.feeScriptAddressBech32),
  );
  // Dedupe by `<txid>#<idx>` in case an extra shard has somehow already
  // landed on chain between fetch and call; on-chain wins (its lovelace
  // value is authoritative).
  const seen = new Set(onChain.map((u) => `${u.ref.txId}#${u.ref.outputIndex}`));
  const merged = [...onChain];
  for (const u of extras) {
    const key = `${u.ref.txId}#${u.ref.outputIndex}`;
    if (!seen.has(key)) {
      merged.push(u);
      seen.add(key);
    }
  }
  // Pass through `excludeRefs`, `minLovelace`, and `rng` only when defined;
  // with exactOptionalPropertyTypes a literal `undefined` would fail to type.
  return pickRandomShard({
    shards: merged,
    ...(args.excludeRefs !== undefined ? { excludeRefs: args.excludeRefs } : {}),
    ...(args.minLovelace !== undefined ? { minLovelace: args.minLovelace } : {}),
    ...(args.rng !== undefined ? { rng: args.rng } : {}),
  });
}

/**
 * Like `pickRandomFeeShard` but returns `null` instead of throwing when no
 * shards are available. Deposit uses this to gracefully fall back to a
 * shard-less tx (mix-box only, no Replenish branch). Mix doesn't — it
 * requires a shard to source `tx.fee`, and bailing loud is the right move.
 */
export async function pickFeeShardOptional(args: {
  provider: ChainProvider;
  feeScriptAddressBech32: string;
  excludeRefs?: ReadonlyArray<{ txId: string; outputIndex: number }>;
  rng?: RandomInt;
}): Promise<Utxo | null> {
  const all = await args.provider.getUtxos(args.feeScriptAddressBech32);
  const shards = all.filter((u) => isFeeShardCandidate(u, args.feeScriptAddressBech32));
  if (shards.length === 0) return null;
  return pickRandomShard({
    shards,
    ...(args.excludeRefs !== undefined ? { excludeRefs: args.excludeRefs } : {}),
    ...(args.rng !== undefined ? { rng: args.rng } : {}),
  });
}

/**
 * Compute the lovelace value the Replenish output of a Deposit tx should hold.
 *
 * Spec:  §"Deposit" — the user contributes
 * `rounds × max_fee_per_mix` lovelace, on top of whatever the input shard
 * already held. The on-chain validator only checks `fee_out > fee_in` (strict
 * increase), so any positive contribution satisfies the rule; the
 * `rounds × max_fee_per_mix` formula is the user-facing convention that lets
 * the deposited box afford `rounds` mixes worth of fees on average.
 */
export function replenishOutputLovelace(args: {
  shard: Utxo;
  rounds: number;
  params: Pick<ProtocolParams, "maxFeePerMixLovelace">;
  /**
   * Optional: minimum top-up to insist on (e.g., from `min_mix_rounds` in the
   * network config). The UI is expected to enforce this; the SDK still
   * accepts user-chosen rounds because (a) round count is private to the user
   * and (b) the on-chain rule is just `fee_out > fee_in`.
   */
  minRounds?: number;
}): Lovelace {
  if (!Number.isInteger(args.rounds) || args.rounds <= 0) {
    throw new Error(`rounds must be a positive integer, got ${args.rounds}`);
  }
  if (args.minRounds !== undefined && args.rounds < args.minRounds) {
    throw new Error(`rounds=${args.rounds} below minRounds=${args.minRounds}; UI should reject`);
  }
  const contribution = BigInt(args.rounds) * args.params.maxFeePerMixLovelace;
  return args.shard.lovelace + contribution;
}

/**
 * Sanity check: are there enough fee shards on chain to satisfy the
 * `fee_shard_target` from the reference datum? This is informational —
 * the protocol still works with fewer shards (concurrency degrades) — but
 * it's useful for the CLI/UI to surface to operators.
 */
export function shardCountSanity(args: {
  shards: Utxo[];
  addresses: Pick<LovejoinAddresses, "feeShardUtxos">;
}): { actual: number; bootstrapped: number; healthy: boolean } {
  return {
    actual: args.shards.length,
    bootstrapped: args.addresses.feeShardUtxos.length,
    healthy: args.shards.length >= args.addresses.feeShardUtxos.length,
  };
}
