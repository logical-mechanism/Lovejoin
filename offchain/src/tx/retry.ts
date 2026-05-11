// Tx submission retry on input collision.
//
// All three of donate, mix (shard mode), and withdraw can collide on a
// shared UTxO between tx-build and tx-submit time:
//   * donate: the picked fee shard is consumed by another Mix or Replenish.
//   * mix: same fee shard hazard, plus pool-box collision (rare).
//   * withdraw: only the wallet's own funding UTxOs can churn (the mix-box
//     itself is owner-only).
//
// Without retry the user sees a script-evaluation error and has to start
// over (and re-sign for wallet-signed flows). With retry, the SDK
// transparently re-picks the contended UTxO and rebuilds. For wallet-
// signed flows a retry still costs one extra signature because the new
// body invalidates the witness; for shard-mix the retry is silent.
//
// First-pass scope: detect the error, expose a small `RetryOptions` shape,
// and let each builder loop. Mempool-aware shard picking (skip shards we
// can see are already mempool inputs) is a follow-up that needs Ogmios
// access through the self-hosted backend.

/**
 * Heuristic: does this error look like a retryable input-collision OR
 * fee-shard depletion error? We match on substrings rather than
 * structured fields because the error body shape differs across
 * providers (Blockfrost, Ogmios via the backend, mesh-csl's build).
 *
 * Patterns we treat as collisions / retryable:
 *   * `BadInputsUTxO` - the ledger's canonical "input not in current UTxO
 *     set" error. Most reliable signal.
 *   * `ValueNotConservedUTxO` - sometimes follows BadInputsUTxO when a
 *     consumed input was a different size.
 *   * `input not found` / `unknown input` / `unknown UTxO reference` /
 *     `unknownOutputReferences` - looser matches that show up in Ogmios
 *     and mesh error stringifications.
 *   * Ogmios JSON-RPC code 3117 - "The transaction contains unknown
 *     UTxO references as inputs". Same root cause: the input was spent
 *     between build and submit.
 *   * `Insufficient input in transaction` - mesh-csl build-time error
 *     when the picked fee shard's `shard_in - cap_fee` would land
 *     below min-utxo, OR mesh's auto-balancer can't reconcile after
 *     the SDK pinned the fee. A re-pick with a different shard (one
 *     with more headroom above the cap) typically clears it. Recorded
 *     in retry-tracking so the failed shard is excluded on subsequent
 *     attempts — see `mix.ts` `failedFeeShardRefs`.
 *
 * Anything else (script eval, datum mismatch, signature, etc.) is a
 * non-retryable failure and surfaces to the caller.
 */
export function isInputCollisionError(err: unknown): boolean {
  if (!err) return false;
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : (() => {
            try {
              return JSON.stringify(err);
            } catch {
              return String(err);
            }
          })();
  if (!msg) return false;
  return (
    msg.includes("BadInputsUTxO") ||
    msg.includes("ValueNotConservedUTxO") ||
    msg.includes("unknownOutputReferences") ||
    msg.includes("Insufficient input in transaction") ||
    /\binput not found\b/i.test(msg) ||
    /\bunknown input\b/i.test(msg) ||
    /\bunknown utxo reference/i.test(msg) ||
    /ogmios[^]*\berror\s*3117\b/i.test(msg)
  );
}

/**
 * Tighter heuristic: was this specifically a fee-shard-related build
 * failure (mesh-csl "Insufficient input" at build time, or a
 * balance-conservation error from the ledger)? Used by the Mix builder
 * to decide whether to add the just-tried fee shard to its
 * exclude-list before the next attempt.
 *
 * `BadInputsUTxO` alone isn't sufficient signal — it can fire for a
 * mix-box collision, in which case re-picking the fee shard wouldn't
 * help. We err on the side of excluding the fee shard for these
 * value-balance errors; if the actual culprit was a mix-box, the
 * exclude is harmless and the retry still has the same mix-box
 * problem (which exhausts maxAttempts).
 */
export function looksLikeFeeShardBuildError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("Insufficient input in transaction") || msg.includes("ValueNotConservedUTxO");
}

export interface RetryInfo {
  /** 1-indexed attempt number that's about to start (i.e. 2 on first retry). */
  attempt: number;
  /** Error from the previous attempt that triggered the retry. */
  error: Error;
}

export interface RetryOptions {
  /**
   * Max number of attempts including the first. Default: 1 (no retry).
   * Common production setting: 3. We don't retry forever because a
   * persistent collision usually signals a deeper problem (e.g. all
   * shards are in flight, or the wallet's funding UTxO set is empty).
   */
  maxAttempts?: number;
  /**
   * Delay between attempts in ms. Default: 0 (immediate retry). The UI
   * typically passes ~2000 so retries straddle a Cardano block boundary
   * (~20s blocks; most mempool txs land within one block, freeing
   * shards that were transiently in flight). The delay only fires on
   * a collision retry, not on success or non-collision errors.
   */
  delayBetweenAttemptsMs?: number;
  /**
   * Optional callback invoked just before each retry attempt. The UI
   * uses this to surface "retrying with a fresh shard..." feedback so
   * the user understands why their wallet is prompting again.
   */
  onRetry?: (info: RetryInfo) => void;
}

/**
 * Run `fn` and retry up to `maxAttempts` times when it throws an
 * input-collision error. Errors that aren't collisions surface
 * immediately. The caller is responsible for any state mutation needed
 * between attempts (e.g. re-picking a fee shard) - typically by closing
 * over fresh state inside `fn`.
 */
export async function withInputCollisionRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? 1);
  const delayMs = Math.max(0, options?.delayBetweenAttemptsMs ?? 0);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !isInputCollisionError(err)) throw err;
      options?.onRetry?.({
        attempt: attempt + 1,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  // Unreachable: the loop either returns or throws on the last iteration.
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
