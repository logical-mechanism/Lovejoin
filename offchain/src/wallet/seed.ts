// Wallet-derived seed + per-index owner-secret derivation.
//
// Spec: docs/spec/06-ui.md M6.5 vault rework + project memory
// project_owner_secret_storage_m6.md.
//
// The vault's primary flow is "no new keys for the user to manage": the
// connected CIP-30 wallet signs a fixed payload exactly once via signData,
// and Lovejoin derives every per-deposit owner secret deterministically
// from that signature. Ed25519 (RFC 8032) is deterministic, so the same
// (wallet, stakeAddr, payload) always produces the same signature — the
// signature is a stable per-wallet "Lovejoin master key" that costs the
// user a single click on every fresh browser.
//
// Defense-in-depth layering (each step domain-separated):
//
//   1. The wallet signs a long, distinctive multi-line payload (see
//      `SIGN_DATA_PAYLOAD_V1`). The payload is what the user sees in the
//      wallet popup — verbatim text that names Lovejoin and warns
//      against re-signing it for another app, so a malicious dApp asking
//      the user to sign the same prompt would have to do so deliberately.
//   2. We refuse to sign with anything other than a stake address (HRP
//      `stake1` or `stake_test1`). CIP-8 signatures can't be confused
//      with tx witnesses, but the address header is part of CIP-8's
//      protected_header — restricting to the stake key keeps the
//      derivation independent of which payment address the wallet is
//      currently using.
//   3. The 32-byte vault seed is `blake2b_256(SEED_DOMAIN_TAG_V1 ||
//      stake_addr_bech32_utf8 || cose_sign1_hex_decoded)`. CIP-8's
//      protected header already binds the signature to the address; we
//      re-bind here so a future framing quirk in any wallet doesn't
//      silently weaken the derivation. The leading domain tag means the
//      raw signature alone is not enough to recover a Lovejoin seed
//      without also knowing the Lovejoin tag.
//   4. Per-deposit `x_i = HKDF-SHA256(seed, info=OWNER_HKDF_TAG_V1 ||
//      u32_be(i)) mod r` (`deriveOwnerSecret`). Unchanged.
//
// The seed never leaves memory. Callers hold `UnlockedSeed` for the
// session and drop it on lock-out (vault lock / inactivity timer / tab
// close). Re-unlocking re-prompts the wallet for the same signature and
// recomputes the same seed — no IndexedDB involved.

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { blake2b256 } from "../crypto/hash.js";
import {
  SCALAR_ORDER,
  bytesToBigIntBE,
  reduceScalar,
  type Scalar,
} from "../crypto/bls.js";

/**
 * The exact UTF-8 string the wallet is asked to sign. CIP-8-compatible
 * wallets (Lace, Eternl, Nami, Flint) display this verbatim in the
 * signing-confirmation popup. Multi-line + branded so a colliding prompt
 * from another dApp would have to be a deliberate attack the user can
 * read and reject.
 *
 * If you change this string, every existing user's vault changes — the
 * seed is signature-derived. So bump to v2 alongside any edit; do not
 * reflow whitespace silently.
 */
export const SIGN_DATA_PAYLOAD_V1 = [
  "Lovejoin Owner Vault — v1",
  "",
  "This signature derives every Lovejoin owner key for this wallet.",
  "Sign once per browser session; never sign this prompt for another app.",
].join("\n");

/** UTF-8 bytes of the v1 payload. Pre-encoded so callers don't reach for TextEncoder. */
export const SIGN_DATA_PAYLOAD_V1_BYTES: Uint8Array = new TextEncoder().encode(
  SIGN_DATA_PAYLOAD_V1,
);

/**
 * Domain-separation tag prefix for the seed-derivation hash. Bound into
 * every blake2b call so a CIP-8 signature taken in some other context
 * can't double as a Lovejoin seed input. v1 here is independent of the
 * payload's v1 — bumping either is a breaking change for users.
 */
export const SEED_DOMAIN_TAG_V1 = "lovejoin/owner-seed/v1";
const SEED_DOMAIN_TAG_V1_BYTES = new TextEncoder().encode(SEED_DOMAIN_TAG_V1);

/**
 * Domain-separation tag for the per-index HKDF expansion. Different from
 * SEED_DOMAIN_TAG_V1 so a future leak of seed-bytes derivation doesn't
 * compromise the per-deposit `x_i` values.
 */
export const OWNER_HKDF_TAG_V1 = "lovejoin/owner/v1";
const OWNER_HKDF_TAG_V1_BYTES = new TextEncoder().encode(OWNER_HKDF_TAG_V1);

/**
 * Domain tag for the password-recovery salt. Different from
 * SEED_DOMAIN_TAG_V1 so a leak of one derivation does NOT compromise the
 * other, and so a future Argon2id parameter bump only requires bumping
 * this v1 — not the signData-derived path.
 *
 * The recovery seed is `Argon2id(password, salt = recoverySalt(network,
 * stakeAddrBech32))`. Salt construction uses the same blake2b_256-of-
 * concat-bytes pattern as `deriveVaultSeed` so the per-(network, wallet)
 * salt is reproducible across devices: a user who connects the same
 * wallet on a fresh browser gets the same salt → same seed → same boxes.
 *
 * The stake-address bech32 string is mixed in raw (UTF-8 bytes) — it
 * already encodes the network header byte plus the 28-byte stake key
 * hash, so we don't need to bech32-decode it on the client. Mixing the
 * `network` argument too is belt-and-braces against a future wallet
 * exposing a mismatched address (preprod address while VITE_NETWORK is
 * mainnet) — different network, different seed.
 */
export const RECOVERY_SALT_DOMAIN_TAG_V1 = "lovejoin/recover-seed/v1";
const RECOVERY_SALT_DOMAIN_TAG_V1_BYTES = new TextEncoder().encode(
  RECOVERY_SALT_DOMAIN_TAG_V1,
);

/**
 * Refuse to derive a seed from anything other than a Cardano stake
 * (reward) address. Stake addresses use HRP `stake1` (mainnet) or
 * `stake_test1` (preprod / preview). Wallets vary in what their
 * `getRewardAddresses()` returns — most return only stake addresses, but
 * some hardware-wallet bridges have been seen returning a payment
 * address by mistake. We surface a loud error rather than silently
 * deriving the seed from a non-stake key.
 */
export function isStakeAddressBech32(address: string): boolean {
  return (
    address.startsWith("stake1") || address.startsWith("stake_test1")
  );
}

/**
 * Pure helper: blake2b_256 of arbitrary signature bytes. Kept exported
 * for test/debugging use — the production seed derivation goes through
 * `deriveVaultSeed`, which adds the domain tag + stake-address binding
 * required by the M6.5 hardening pass.
 */
export function deriveSeedFromSignatureBytes(signatureBytes: Uint8Array): Uint8Array {
  if (signatureBytes.length === 0) {
    throw new Error("seed: signature bytes must be non-empty");
  }
  return blake2b256(signatureBytes);
}

/** Hex convenience wrapper for `deriveSeedFromSignatureBytes`. */
export function deriveSeedFromSignatureHex(signatureHex: string): Uint8Array {
  return deriveSeedFromSignatureBytes(hexToBytes(signatureHex));
}

/**
 * The production vault-seed derivation. Domain-separated + bound to the
 * stake address that produced the signature.
 *
 * Layout: `blake2b_256(SEED_DOMAIN_TAG_V1 || stake_addr_utf8 || sig_bytes)`.
 *
 * - The domain tag means the raw CIP-8 signature alone isn't enough to
 *   recompute a Lovejoin seed without also knowing the tag.
 * - Mixing in the bech32 stake address (UTF-8 bytes — the bech32 string
 *   is per-network and per-wallet-account, no decoding needed) re-binds
 *   the seed even if a future wallet/CIP-8 quirk loosens the protected
 *   header's binding.
 */
export function deriveVaultSeed(args: {
  signatureBytes: Uint8Array;
  stakeAddrBech32: string;
}): Uint8Array {
  if (args.signatureBytes.length === 0) {
    throw new Error("seed: signature bytes must be non-empty");
  }
  if (!isStakeAddressBech32(args.stakeAddrBech32)) {
    throw new Error(
      `seed: refusing to derive vault seed from non-stake address ${JSON.stringify(args.stakeAddrBech32)}`,
    );
  }
  const addrBytes = new TextEncoder().encode(args.stakeAddrBech32);
  const buf = new Uint8Array(
    SEED_DOMAIN_TAG_V1_BYTES.length + addrBytes.length + args.signatureBytes.length,
  );
  let off = 0;
  buf.set(SEED_DOMAIN_TAG_V1_BYTES, off);
  off += SEED_DOMAIN_TAG_V1_BYTES.length;
  buf.set(addrBytes, off);
  off += addrBytes.length;
  buf.set(args.signatureBytes, off);
  return blake2b256(buf);
}

/** Cardano network tag byte mixed into the recovery salt. */
const RECOVERY_NETWORK_TAG: Record<RecoveryNetwork, number> = {
  mainnet: 0x01,
  preprod: 0x02,
  preview: 0x03,
};

export type RecoveryNetwork = "mainnet" | "preprod" | "preview";

/**
 * Build the per-(network, wallet) Argon2id salt for the password-recovery
 * unlock path. Reproducible across devices given the same inputs.
 *
 * Layout: `blake2b_256(RECOVERY_SALT_DOMAIN_TAG_V1 || network_tag ||
 * stake_addr_utf8)`. The output is 32 bytes — the salt size Argon2id
 * expects. We hash everything together so the salt is fixed-length
 * regardless of how long the address bech32 is.
 *
 * Refuses non-stake addresses for the same reason `deriveVaultSeed`
 * does: a wallet bridge mistakenly returning a payment address would
 * silently change the salt across reconnects (payment addresses rotate;
 * stake addresses don't).
 */
export function recoverySalt(args: {
  network: RecoveryNetwork;
  stakeAddrBech32: string;
}): Uint8Array {
  if (!isStakeAddressBech32(args.stakeAddrBech32)) {
    throw new Error(
      `recoverySalt: refusing to build salt from non-stake address ${JSON.stringify(args.stakeAddrBech32)}`,
    );
  }
  const tag = RECOVERY_NETWORK_TAG[args.network];
  if (tag === undefined) {
    throw new Error(`recoverySalt: unknown network ${args.network}`);
  }
  const addrBytes = new TextEncoder().encode(args.stakeAddrBech32);
  const buf = new Uint8Array(
    RECOVERY_SALT_DOMAIN_TAG_V1_BYTES.length + 1 + addrBytes.length,
  );
  let off = 0;
  buf.set(RECOVERY_SALT_DOMAIN_TAG_V1_BYTES, off);
  off += RECOVERY_SALT_DOMAIN_TAG_V1_BYTES.length;
  buf[off] = tag;
  off += 1;
  buf.set(addrBytes, off);
  return blake2b256(buf);
}

/**
 * Argon2id parameter set for the password-recovery seed.
 *
 * Threat model: the salt is reproducible from any user's *public* stake
 * address, so an attacker who knows which address to target can
 * brute-force the password offline. Unlike the (now-removed) BIP-39
 * vault, there's no encrypted blob the attacker has to also exfiltrate
 * — the password is the entire security barrier. We compensate with
 * deliberately heavy Argon2id parameters: 4 iterations × 256 MiB ×
 * single lane runs in ~2 s on a 2025-era laptop and forces a memory-
 * hungry workload that hurts GPU/ASIC crackers most.
 *
 * Exposed as a constant so the UI can show users a "this will take a
 * couple seconds" hint and tests can assert against it.
 */
export const RECOVERY_KDF_PARAMS_V1 = {
  iterations: 4,
  memorySizeKib: 256 * 1024,
  parallelism: 1,
  hashLength: 32,
} as const;

/**
 * Minimum password length the UI enforces for the recovery flow. Keep in
 * sync with the strength meter. 12 characters at full ASCII printable
 * range gives ~78 bits of entropy if chosen randomly — plenty against
 * the Argon2id wall above. Users who pick natural-language passphrases
 * need to type more characters to reach the same entropy; the UI's
 * strength meter is what actually gates submission.
 */
export const RECOVERY_PASSWORD_MIN_LENGTH = 12;

/**
 * Encode a 32-bit unsigned counter big-endian. Matches the bytes the spec
 * recommends for the HKDF info argument so cross-impl re-derivation is
 * straightforward (a Rust or Aiken port can hash the same 4 bytes).
 */
function counterToBytes(index: number): Uint8Array {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
    throw new Error(`seed: index must be a uint32, got ${index}`);
  }
  const buf = new Uint8Array(4);
  buf[0] = (index >>> 24) & 0xff;
  buf[1] = (index >>> 16) & 0xff;
  buf[2] = (index >>> 8) & 0xff;
  buf[3] = index & 0xff;
  return buf;
}

/**
 * Derive the i-th per-deposit owner secret from a seed.
 *
 * Implementation: HKDF-SHA256 with the 32-byte seed as IKM, no salt, info
 * = `OWNER_HKDF_TAG_V1 || u32_be(index)`, expand to 64 bytes, reduce
 * mod r. The 64-byte expansion makes the bias from `mod r` reduction
 * negligible (≪ 2⁻²⁵⁶).
 *
 * Note that `OWNER_HKDF_TAG_V1` ("lovejoin/owner/v1") is independent from
 * the human-readable `SIGN_DATA_PAYLOAD_V1` text — the latter is what the
 * wallet shows the user, the former is the HKDF context tag. Decoupling
 * lets us reword the prompt without rotating every per-deposit secret.
 *
 * The result is a non-zero scalar by overwhelming probability; we still
 * reject the zero case loudly so callers don't accidentally generate the
 * identity element. In practice this branch is dead code.
 */
export function deriveOwnerSecret(seed: Uint8Array, index: number): Scalar {
  if (seed.length !== 32) {
    throw new Error(`seed: seed must be 32 bytes, got ${seed.length}`);
  }
  const info = concat(OWNER_HKDF_TAG_V1_BYTES, counterToBytes(index));
  const okm = hkdf(sha256, seed, undefined, info, 64);
  const x = reduceScalar(bytesToBigIntBE(okm));
  if (x === 0n) {
    // Probability ≈ 2⁻²⁵⁶ in a 256-bit field. Surface anyway rather than
    // returning a zero secret — the on-chain validator would reject any
    // proof built from x = 0 because [0]·a is the identity.
    throw new Error(`seed: owner secret was zero at index ${index} (bump index)`);
  }
  if (x >= SCALAR_ORDER) {
    // Defensive: reduceScalar already mods by SCALAR_ORDER. Catch a future
    // refactor that accidentally returns an out-of-range value.
    throw new Error("seed: derived secret >= SCALAR_ORDER");
  }
  return x;
}

/**
 * Mesh wallet surface for `signData`. Both `BrowserWallet` and
 * `MeshWallet` already implement this — we type the minimum so this
 * module is callable with a bare mesh-shaped stub in tests.
 *
 * NOTE: mesh's argument order is `(payload, address?)` — payload first,
 * address optional and second. This is the OPPOSITE of the raw CIP-30
 * convention (which is `signData(address, payload)`); mesh's wrapper
 * also UTF-8-encodes the payload internally, so callers pass plain text,
 * not hex. We mirror mesh's contract here so a `BrowserWallet` instance
 * is structurally assignable to `SignDataCapableWallet` — passing the
 * wallet straight in just works.
 */
export interface SignDataCapableWallet {
  /**
   * CIP-30 signData via mesh's wrapper. Returns a CIP-8 envelope in
   * `signature` (hex) and a COSE_Key in `key` (hex). For Lovejoin we only
   * consume `signature`.
   *
   * @param payload - plain UTF-8 string. Mesh hex-encodes internally.
   * @param address - bech32 address (stake / reward / payment). When
   *   omitted mesh defaults to the first used address; we ALWAYS pass an
   *   explicit stake address so the seed is per-account.
   */
  signData(
    payload: string,
    address?: string,
  ): Promise<{ signature: string; key: string }>;
  /**
   * Bech32 stake / reward addresses owned by the wallet. CIP-30 lets a
   * wallet sign with any of its keys; we always sign with the stake key
   * so the seed is per-account, not per-payment-address. Mesh's
   * BrowserWallet returns these as bech32 strings.
   */
  getRewardAddresses(): Promise<string[]>;
}

/**
 * Drive a wallet signData round-trip and return the derived 32-byte seed.
 *
 * Sequence:
 *   1. Pick the signing stake address (caller-supplied, otherwise the
 *      wallet's first reward address).
 *   2. Refuse anything that isn't a stake-HRP bech32 string. Defends
 *      against a wallet bridge that returns a payment address by mistake.
 *   3. Drive `wallet.signData(payload, address)` — mesh's argument order
 *      is (payload, address), and mesh hex-encodes UTF-8 internally.
 *   4. Run the resulting CIP-8 envelope through `deriveVaultSeed` so the
 *      32-byte seed is bound to the domain tag + the stake address, not
 *      just to the raw signature bytes.
 *
 * Args:
 *   wallet:           any mesh BrowserWallet / MeshWallet handle.
 *   payloadOverride:  optional override for the signed payload — defaults
 *                     to `SIGN_DATA_PAYLOAD_V1`. Overrides exist for test
 *                     fixtures and for a future v2 derivation; production
 *                     code should always use the default.
 *   stakeAddrBech32:  optional override for the signing address. Defaults
 *                     to the wallet's first reward address.
 */
export async function deriveSeedFromWalletSignature(args: {
  wallet: SignDataCapableWallet;
  payloadOverride?: string;
  stakeAddrBech32?: string;
}): Promise<{ seed: Uint8Array; signatureHex: string; address: string }> {
  const payload = args.payloadOverride ?? SIGN_DATA_PAYLOAD_V1;
  let address = args.stakeAddrBech32 ?? "";
  if (!address) {
    const rewards = await args.wallet.getRewardAddresses();
    if (!rewards || rewards.length === 0) {
      throw new Error(
        "seed: wallet exposed no reward (stake) addresses — cannot derive a Lovejoin seed",
      );
    }
    address = rewards[0]!;
  }
  if (!isStakeAddressBech32(address)) {
    throw new Error(
      `seed: refusing to sign with non-stake address ${JSON.stringify(address)} — expected stake1… / stake_test1… HRP`,
    );
  }
  // Mesh's wrapper signature is (payload, address) — payload first — and
  // mesh handles the UTF-8→hex conversion internally. Passing the bech32
  // string directly is correct.
  const result = await args.wallet.signData(payload, address);
  const seed = deriveVaultSeed({
    signatureBytes: hexToBytes(result.signature),
    stakeAddrBech32: address,
  });
  return { seed, signatureHex: result.signature, address };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (cleaned.length === 0) throw new Error("hex string must be non-empty");
  if (cleaned.length % 2 !== 0) throw new Error("hex string must have even length");
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`hex string contains non-hex char at ${i * 2}`);
    out[i] = byte;
  }
  return out;
}
