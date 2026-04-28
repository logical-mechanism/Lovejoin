// Vault state machine — turns a master seed into the live "owned boxes"
// the rest of the UI consumes.
//
// Spec: docs/spec/06-ui.md M6.5 — "Wallet-derived vault (default flow) —
// zero new keys for the user to manage. ... seed = blake2b_256(signature
// _bytes); per-deposit owner secret x_i = scalar_from_hkdf(seed, 'lovejoin
// /owner/v1', counter=i) reduced mod r."
//
// Two unlock paths produce the same kind of `UnlockedSeed`:
//
//   1. **Wallet-derived (default):** the connected CIP-30 wallet does a
//      single signData(stakeAddr, 'lovejoin/owner/v1') round-trip. The
//      signature is hashed into a 32-byte seed. No persistence — the
//      next session re-prompts the wallet for the same signature and
//      recomputes the same seed (Ed25519 is deterministic).
//
//   2. **BIP-39 fallback (advanced):** the user creates or unlocks an
//      encrypted IndexedDB vault. The 32-byte BIP-39 entropy is the
//      seed input directly (no further round-trip needed).
//
// Once unlocked, the vault scans the live pool with `findOwnedBoxes` for
// indices `[0..MAX_INDEX_SCAN)` and surfaces the union as `OwnedBox[]`.
// The "next deposit index" is the smallest counter that didn't match an
// existing box — straightforward because indices are dense by
// construction (every deposit increments by 1 when sourced from this
// derivation).

import {
  buildScriptAddress,
  deriveOwnerSecret,
  deriveSeedFromWalletSignature,
  fetchPool,
  findOwnedBoxes,
  ownsBox,
  scalarMul,
  pointEqual,
  pointFromBytes,
  scalarToBytes,
  GENERATOR_COMPRESSED,
  type BlockfrostProvider,
  type LovejoinAddresses,
  type PoolEntry,
  type Scalar,
  type SignDataCapableWallet,
} from "@lovejoin/sdk";

import { EntropyVault, type UnlockedEntropyVault } from "../storage/secrets.js";

/**
 * Maximum per-vault deposit index the auto-scanner will probe. Higher =
 * slower unlock; lower = a power user could "lose" later boxes. 1024 is
 * generous — at the 100M-lovelace denomination that's 102.4 ADA × 1024 =
 * over 100K ADA in deposits before the cap matters.
 */
export const MAX_INDEX_SCAN = 1024;

export type VaultKind = "wallet" | "bip39";

export interface UnlockedSeed {
  kind: VaultKind;
  /** The raw 32-byte master seed. Held in memory only. */
  seed: Uint8Array;
  /**
   * For the BIP-39 path: the open vault handle so callers can rotate
   * passphrases or destroy the entropy. Always null for wallet-derived.
   */
  bip39Vault: UnlockedEntropyVault | null;
}

export interface OwnedBox {
  /** The pool entry as the SDK sees it (ref + a + b + utxo). */
  entry: PoolEntry;
  /** The deposit-counter index that derived the owner secret. */
  index: number;
  /** Owner secret as a 32-byte hex — convenience for tx builders. */
  secretHex: string;
  /** Scalar form of the owner secret. */
  secret: Scalar;
}

export interface VaultScanResult {
  /** Boxes the unlocked vault owns, ordered by ascending index. */
  ownedBoxes: OwnedBox[];
  /** Total number of legitimate pool entries surveyed. */
  poolSize: number;
  /** Highest used index + 1 — i.e. the index the next deposit should claim. */
  nextDepositIndex: number;
}

/**
 * Walk the live pool with the master seed and return every owned box.
 *
 * Strategy: derive the deposit-time `[x]·G` for each candidate index
 * `0..maxIndex`; if any pool entry's `b` decompresses to the same point
 * (regardless of randomization rounds), that entry is ours. Once we
 * stop finding owned boxes we stop scanning — but we always probe at
 * least `minProbe` consecutive misses past the last hit so a deposit
 * that sits in the pool at index 50 but indices 51..52 are missing
 * doesn't make us return early at index 53.
 *
 * The scan complexity is O(maxIndex · poolSize) point comparisons;
 * each comparison is a 48-byte uncompress + a constant-time equal,
 * which is fast enough for ~1024 × ~50K boxes (≈ 50ms in Chrome).
 */
export async function scanPool(args: {
  seed: Uint8Array;
  provider: BlockfrostProvider;
  addresses: LovejoinAddresses;
  maxIndex?: number;
  /** Minimum gap of misses past the last hit before we stop scanning. */
  minProbe?: number;
}): Promise<VaultScanResult> {
  const maxIndex = args.maxIndex ?? MAX_INDEX_SCAN;
  const minProbe = args.minProbe ?? 8;
  const denomLovelace = BigInt(args.addresses.protocol.denom_lovelace);
  // Mix-box outputs are tagged with the dApp stake key so the indexer can
  // find every live box with a single address filter (CLAUDE.md: "Mix
  // outputs are tagged with a per-network dApp stake key... so all live
  // boxes share a stake credential"). Deposits write to the staked
  // address; the vault must read from the same address. Dropping the
  // stake key here used to silently return zero boxes against a populated
  // pool — Pool.tsx's fetchPoolDirect already uses the stake key, so the
  // Pool screen worked while Vault didn't.
  const networkId: 0 | 1 = args.addresses.network === "mainnet" ? 1 : 0;
  const mixBoxAddress = buildScriptAddress(
    args.addresses.mixBoxScriptHash,
    networkId,
    args.addresses.dappStakeKeyHashHex ?? null,
  );
  const pool = await fetchPool({
    provider: args.provider,
    mixBoxAddressBech32: mixBoxAddress,
    params: { denomLovelace },
  });

  const owned: OwnedBox[] = [];
  let lastHit = -1;
  for (let i = 0; i < maxIndex; i++) {
    const x = deriveOwnerSecret(args.seed, i);
    const matches = findOwnedBoxes(x, pool);
    if (matches.length > 0) {
      const secretBytes = scalarToBytes(x);
      const secretHex = bytesToHex(secretBytes);
      for (const entry of matches) {
        owned.push({ entry, index: i, secretHex, secret: x });
      }
      lastHit = i;
    }
    if (i - lastHit >= minProbe && lastHit >= 0) {
      // Found at least one box and have probed `minProbe` consecutive
      // misses without finding more — the rest is empty space.
      break;
    }
    if (i - lastHit >= minProbe && lastHit < 0 && i >= minProbe * 2) {
      // Never found anything in the first 2*minProbe indices — assume
      // the vault is empty. This keeps unlock fast on a fresh wallet.
      break;
    }
  }

  owned.sort((a, b) => a.index - b.index);
  const nextDepositIndex = lastHit + 1;
  return {
    ownedBoxes: owned,
    poolSize: pool.length,
    nextDepositIndex,
  };
}

/**
 * Derive an owner-secret + box-side `(a, b)` for a fresh deposit at the
 * given index. Use this in the deposit builder so deposits are sourced
 * from the same deterministic schedule as the recovery scan.
 *
 * The `a` is fixed by spec — the box's `a = [d]·G` for a fresh randomness
 * `d`; the deposit builder owns `d`. This helper just turns the seed +
 * index into the owner secret. Callers compose `a` and `b` themselves.
 */
export function deriveDepositSecret(seed: Uint8Array, index: number): {
  index: number;
  secret: Scalar;
  secretHex: string;
} {
  const secret = deriveOwnerSecret(seed, index);
  const secretHex = bytesToHex(scalarToBytes(secret));
  return { index, secret, secretHex };
}

/**
 * Drive the wallet-signed seed flow. Thin wrapper that calls into the
 * SDK and forwards the result. Lives in the UI layer rather than the
 * SDK so the caller only needs the mesh handle the rest of the UI
 * already holds.
 */
export async function unlockFromWallet(args: {
  wallet: SignDataCapableWallet;
}): Promise<UnlockedSeed> {
  const { seed } = await deriveSeedFromWalletSignature({ wallet: args.wallet });
  return { kind: "wallet", seed, bip39Vault: null };
}

/**
 * Unlock the BIP-39 fallback vault with a passphrase. First-ever call
 * auto-creates the meta record; subsequent calls verify the passphrase.
 * Returns null when the vault exists but no entropy has been written
 * yet (the in-progress create flow).
 */
export async function unlockFromBip39(args: {
  passphrase: string;
}): Promise<{ seed: Uint8Array | null; vault: UnlockedEntropyVault }> {
  const vault = await EntropyVault.unlock(args.passphrase);
  const entropyHex = await vault.getEntropyHex();
  if (!entropyHex) return { seed: null, vault };
  return { seed: hexToBytes(entropyHex), vault };
}

/**
 * Quick sanity check: does `b == [secret]·a`? Useful for the deposit
 * confirmation step — we trust the SDK but a crash here means the
 * derivation diverged from the deposit builder.
 */
export function verifyOwnership(secret: Scalar, aBytes: Uint8Array, bBytes: Uint8Array): boolean {
  return ownsBox(secret, { a: aBytes, b: bBytes });
}

/**
 * Identity sanity-check used by the unit tests: `[x]·G != 0` for any
 * derived secret. Keeps the public surface of vault.ts inspectable.
 */
export function pubKeyOf(secret: Scalar): Uint8Array {
  return scalarMul(secret, pointFromBytes(GENERATOR_COMPRESSED)).toBytes();
}

export { pointEqual };

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/^0x/i, "");
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
