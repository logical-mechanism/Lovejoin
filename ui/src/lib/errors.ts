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
// doesn't match falls through to the original message — better to leak
// SDK noise than to silently invent a misleading error.

export type FriendlyErrorKey =
  | "errors.network"
  | "errors.blockfrost_auth"
  | "errors.blockfrost_rate"
  | "errors.blockfrost_other"
  | "errors.cbor"
  | "errors.script_eval"
  | "errors.no_utxos"
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
  // Plutus / tx-builder.
  { match: /script (?:evaluation|execution).*fail|plutus.*fail/i, key: "errors.script_eval" },
  { match: /cbor (?:decode|encod).*fail|invalid cbor/i, key: "errors.cbor" },
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

/**
 * Convenience: returns the friendly translation when one matches,
 * otherwise the raw string. The translator must already have an entry
 * for every `FriendlyErrorKey` (en.json `errors.*`).
 */
export function friendlyErrorMessage(
  raw: string,
  t: (key: string) => string,
): string {
  const key = friendlyErrorKey(raw);
  return key ? t(key) : raw;
}
