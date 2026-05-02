// Map raw SDK / fetch / Blockfrost error strings to user-facing copy.
//
// Spec: M6.5+ punch-list L1. Pool.tsx (and the toast paths in
// deposit/withdraw/mix) used to surface raw `(e as Error).message`
// strings — "fetch failed", "401 Unauthorized", "CBOR decode failed"
// — directly to the user. This module owns the mapping in one place so
// every screen renders the same friendly string for the same root cause.
//
// The mapper is pattern-based: we look for substrings in the raw
// message and pick the first matching translated string. Anything that
// doesn't match falls through to a sanitized version of the raw message
// (CBOR / hex blobs stripped, length capped) — better to surface a
// trimmed SDK string than to silently invent a misleading error, but
// dumping a multi-kilobyte tx CBOR into a toast pushed every other
// notification off screen.

export type FriendlyErrorKey =
  | "errors.network"
  | "errors.blockfrost_auth"
  | "errors.blockfrost_rate"
  | "errors.blockfrost_other"
  | "errors.cbor"
  | "errors.script_eval"
  | "errors.no_utxos"
  | "errors.no_fee_shards"
  | "errors.user_rejected"
  | "errors.collateral_unreachable";

interface ErrorPattern {
  match: RegExp;
  key: FriendlyErrorKey;
}

const PATTERNS: ErrorPattern[] = [
  // Wallet user-rejected the signing prompt.
  { match: /user (?:declined|rejected|cancel)/i, key: "errors.user_rejected" },
  // Blockfrost / HTTP layer.
  { match: /\b401\b|unauthori[sz]ed|invalid project[_ ]?id/i, key: "errors.blockfrost_auth" },
  { match: /\b429\b|rate[- ]?limit|too many requests/i, key: "errors.blockfrost_rate" },
  { match: /blockfrost.*\b5\d\d\b|blockfrost.*error/i, key: "errors.blockfrost_other" },
  // Generic fetch failures (offline, DNS, CORS).
  { match: /fetch failed|network ?error|networkerror|failed to fetch/i, key: "errors.network" },
  // Plutus / tx-builder. Ogmios JSON-RPC 3010 = "Some scripts of the
  // transactions terminated with error(s)" — a script eval failure
  // surfaced through the backend's evaluator path.
  {
    match:
      /script (?:evaluation|execution).*fail|plutus.*fail|terminated with error|ogmios[^]*\berror\s*3010\b/i,
    key: "errors.script_eval",
  },
  { match: /cbor (?:decode|encod).*fail|invalid cbor/i, key: "errors.cbor" },
  // "No fee shards on chain" — surfaced when listFeeShards finds zero
  // candidates at the fee_contract address. Either the pool is in heavy
  // use and every shard is mid-spend (transient — wait + retry), or the
  // bootstrap is incomplete on this network (operator concern).
  {
    match: /no fee shards found|shards have all been consumed/i,
    key: "errors.no_fee_shards",
  },
  { match: /no (?:utxo|inputs?)|insufficient (?:utxo|funds)/i, key: "errors.no_utxos" },
  { match: /collateral.*(?:unavailable|unreachable|down)/i, key: "errors.collateral_unreachable" },
];

/**
 * Look up a friendly-error i18n key for a raw error message. Returns
 * null when nothing matched — caller should fall back to the original
 * message.
 */
export function friendlyErrorKey(raw: string): FriendlyErrorKey | null {
  if (!raw) return null;
  for (const p of PATTERNS) {
    if (p.match.test(raw)) return p.key;
  }
  return null;
}

const MAX_DETAIL_LEN = 360;

/**
 * Strip raw CBOR / hex blobs and other unhelpful noise from an error
 * message, then truncate. The mesh / mesh-provider error path embeds
 * the full tx CBOR in the message ("For txHex: 84a8…") which can be
 * 2–4 KB and pushes every other toast off screen. We keep the prose
 * around the blob and drop the blob itself.
 */
export function sanitizeErrorMessage(raw: string): string {
  if (!raw) return raw;
  let s = raw;
  // mesh's evaluator path: "...terminated with error(s). \n For txHex: <hex>"
  s = s.replace(/(?:\r?\n)?\s*For txHex:\s*[0-9a-fA-F]+/g, "");
  // Standalone long hex runs (e.g. embedded inputs / witness sets).
  s = s.replace(/\b[0-9a-fA-F]{120,}\b/g, "[hex omitted]");
  // The SDK's evaluator wrapper prefixes a long apology before the real
  // message. Drop it so the user sees the cause directly.
  s = s.replace(/^[^]*?evaluator failed and there is no fallback\.[^]*?Original error:\s*/i, "");
  // Common "Error: Tx evaluation failed: Error:" chains — collapse
  // repeated "Error: " prefixes that mesh layers stack.
  s = s.replace(/(?:Error:\s*){2,}/g, "Error: ");
  s = s.replace(/Tx evaluation failed:\s*Error:\s*/i, "");
  s = s.trim();
  if (s.length > MAX_DETAIL_LEN) {
    s = s.slice(0, MAX_DETAIL_LEN - 1).trimEnd() + "…";
  }
  return s;
}

/**
 * Convenience: returns the friendly translation when one matches,
 * otherwise a sanitized version of the raw string (CBOR / hex blobs
 * stripped, capped at MAX_DETAIL_LEN). The translator must already
 * have an entry for every `FriendlyErrorKey` (en.json `errors.*`).
 */
export function friendlyErrorMessage(raw: string, t: (key: string) => string): string {
  const key = friendlyErrorKey(raw);
  return key ? t(key) : sanitizeErrorMessage(raw);
}
