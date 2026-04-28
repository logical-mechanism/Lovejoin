// Seedelf-address detection.
//
// Spec: docs/spec/06-ui.md §"Withdraw" — the screen distinguishes between a
// regular Cardano payment-key destination (yellow `SeedelfHint`) and a
// stealth Seedelf destination (green confirmation that wallet identity is
// hidden after withdraw).
//
// Seedelf addresses (https://github.com/logical-mechanism/seedelf-platform)
// park funds at a script address that the recipient unlocks via a
// Schnorr proof — same architecture as a Lovejoin mix-box. From a
// Cardano-address perspective they are *script* addresses (CIP-19 type 1
// or type 7). A regular wallet destination is a key address (CIP-19 type
// 0 or type 6).
//
// The heuristic we ship: payment credential is a script ⇒ "looks like a
// stealth address" ⇒ green hint. Everything else ⇒ yellow hint suggesting
// the user use a Seedelf address. This isn't a definitive check (any
// script address would qualify), so the green text deliberately says
// "looks like" rather than "is".

import { bech32Decode } from "./bech32.js";

export type AddressKind =
  | { kind: "stealth"; addressType: AddressType }
  | { kind: "regular-key"; addressType: AddressType }
  | { kind: "unknown"; reason: string };

/** CIP-19 address types we care about. */
export type AddressType =
  | "base-key-key"
  | "base-script-key"
  | "base-key-script"
  | "base-script-script"
  | "pointer-key"
  | "pointer-script"
  | "enterprise-key"
  | "enterprise-script"
  | "reward-key"
  | "reward-script";

const HEADER_TO_TYPE: Record<number, AddressType> = {
  0x0: "base-key-key",
  0x1: "base-script-key",
  0x2: "base-key-script",
  0x3: "base-script-script",
  0x4: "pointer-key",
  0x5: "pointer-script",
  0x6: "enterprise-key",
  0x7: "enterprise-script",
  0xe: "reward-key",
  0xf: "reward-script",
};

const SCRIPT_PAYMENT_TYPES = new Set<AddressType>([
  "base-script-key",
  "base-script-script",
  "pointer-script",
  "enterprise-script",
]);

/**
 * Classify a bech32 Cardano address. Returns `unknown` for addresses we
 * can't parse — caller should treat that as "not validated, don't enable
 * Submit".
 */
export function classifyAddress(bech32: string): AddressKind {
  const trimmed = bech32.trim();
  if (!trimmed) return { kind: "unknown", reason: "empty" };
  const decoded = bech32Decode(trimmed);
  if (!decoded) {
    return { kind: "unknown", reason: "not bech32" };
  }
  const { hrp, bytes } = decoded;
  if (!hrp.startsWith("addr") && !hrp.startsWith("stake")) {
    return { kind: "unknown", reason: `unexpected HRP ${hrp}` };
  }
  if (bytes.length < 1) {
    return { kind: "unknown", reason: "address too short" };
  }
  const headerHigh = (bytes[0]! >> 4) & 0xf;
  const addressType = HEADER_TO_TYPE[headerHigh];
  if (!addressType) {
    return { kind: "unknown", reason: `unknown header ${headerHigh}` };
  }
  if (SCRIPT_PAYMENT_TYPES.has(addressType)) {
    return { kind: "stealth", addressType };
  }
  return { kind: "regular-key", addressType };
}

/**
 * Convenience wrapper used by the Withdraw screen to validate addresses
 * before the user submits. Returns true iff the address passes bech32
 * checksum + has a recognized header — i.e. won't be rejected at the
 * tx-builder layer for being malformed.
 */
export function looksLikeCardanoAddress(bech32: string): boolean {
  const k = classifyAddress(bech32);
  return k.kind !== "unknown";
}
