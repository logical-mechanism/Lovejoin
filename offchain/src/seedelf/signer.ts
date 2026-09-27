// Ephemeral one-time-pad signer for Seedelf spends.
//
// Spec: issue #135. Seedelf's wallet validator requires the proof's `vkh`
// to appear in `tx.extra_signatories`. That signer is intentionally
// throwaway: a fresh Ed25519 key per spend so a rollback can't replay
// the proof against a duplicate tx (the on-chain `list.has` would fail
// without the matching witness). The user's main wallet never signs the
// spend — that would leak the wallet's identity onto an otherwise
// stealthy spend tx.
//
// Pairing: this module produces the ephemeral key + its CIP-30-style
// vkey witness. Collateral comes from `GivemeMyProvider` (the same one
// Lovejoin's Mix flow uses); the collateral host's pkh is added as a
// second required signer and the host returns its own witness.
//
// The user's CIP-30 wallet contributes ONE thing only: it derives the
// vault seed via signData on first unlock (see offchain/src/wallet/seed.ts).
// All Seedelf spend authority flows from that seed; the wallet itself
// never witnesses a Seedelf spend tx body.

import { blake2b } from "@noble/hashes/blake2.js";
import { ed25519 } from "@noble/curves/ed25519.js";

/** A fresh ephemeral signing key produced for a single Seedelf spend tx. */
export interface SeedelfEphemeralKey {
  /** 32-byte Ed25519 private key. */
  secretKey: Uint8Array;
  /** 32-byte Ed25519 public key. */
  publicKey: Uint8Array;
  /** 28-byte blake2b-224 of the public key — the Cardano vkh. */
  vkh: Uint8Array;
  /** Sign an arbitrary message (the tx body hash, in practice). */
  sign(message: Uint8Array): Uint8Array;
}

/**
 * Generate a fresh ephemeral Ed25519 key for a single Seedelf spend.
 *
 * The bytes are produced via `ed25519.utils.randomSecretKey()`, which
 * pulls from the platform's CSPRNG (`crypto.getRandomValues` in
 * browsers / Web Worker, `crypto.randomBytes` in node). The key MUST NOT
 * be persisted — its sole purpose is to witness a single tx body and be
 * forgotten. Callers should drop the returned object as soon as the tx
 * is submitted (out-of-scope it; no global cache).
 */
export function generateSeedelfEphemeralKey(): SeedelfEphemeralKey {
  const secretKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(secretKey);
  const vkh = blake2b(publicKey, { dkLen: 28 });
  return {
    secretKey,
    publicKey,
    vkh,
    sign(message: Uint8Array) {
      return ed25519.sign(message, secretKey);
    },
  };
}

/**
 * Convenience helper: derive the vkh of an arbitrary Ed25519 public key.
 * Same formula Cardano uses (blake2b-224 of the raw pubkey bytes), so
 * matches what `extra_signatories` expects.
 */
export function vkhOfPublicKey(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 32) {
    throw new Error(`vkh: ed25519 pubkey must be 32 bytes, got ${publicKey.length}`);
  }
  return blake2b(publicKey, { dkLen: 28 });
}
