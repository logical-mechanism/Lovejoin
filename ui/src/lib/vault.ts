// Vault state machine — turns a master seed into the live "owned boxes"
// the rest of the UI consumes.
//
// Two unlock paths both produce a 32-byte master seed; the rest of the
// vault doesn't care which path was used. Both are wallet-bound (no
// vault is reachable without a connected CIP-30 wallet) and both leave
// nothing on disk:
//
//   1. **signData (default):** the wallet signs a fixed payload via
//      CIP-8. `seed = blake2b_256(domain || stake_addr || sig_bytes)`.
//      Recovery = same wallet anywhere; Ed25519 is deterministic.
//      Strongest path because security ports from the wallet's private
//      key — no separate secret to memorize. Requires a wallet that
//      exposes signData (most software wallets do; some hardware-wallet
//      bridges don't).
//
//   2. **Password (recovery):** for wallets without signData and as a
//      cross-device recovery escape hatch. `seed = Argon2id(password,
//      salt = recoverySalt(network, stake_addr_bech32))`. Same wallet +
//      same password on any device → same seed. Strictly weaker than
//      signData (the salt is built from the public stake address, so an
//      attacker who knows your address can offline-brute-force the
//      password) — mitigated by enforcing a long password and heavy
//      Argon2id parameters (RECOVERY_KDF_PARAMS_V1, ~2 s per derivation).
//      Replaces the prior BIP-39 + IndexedDB fallback, which required
//      saving 24 words AND maintaining browser storage to recover.
//
// Once unlocked, the vault scans the live pool with `findOwnedBoxes` for
// indices `[0..MAX_INDEX_SCAN)` and surfaces the union as `OwnedBox[]`.
// The "next deposit index" is the smallest counter that didn't match an
// existing box — straightforward because indices are dense by
// construction (every deposit increments by 1 when sourced from this
// derivation).

import { argon2id } from "hash-wasm";

import {
  buildScriptAddress,
  deriveOwnerSecret,
  deriveSeedFromWalletSignature,
  fetchPool,
  findOwnedBoxes,
  ownsBox,
  recoverySalt,
  scalarMul,
  pointEqual,
  pointFromBytes,
  scalarToBytes,
  GENERATOR_COMPRESSED,
  RECOVERY_KDF_PARAMS_V1,
  RECOVERY_PASSWORD_MIN_LENGTH,
  type ChainProvider,
  type LovejoinAddresses,
  type PoolEntry,
  type RecoveryNetwork,
  type Scalar,
  type SignDataCapableWallet,
} from "@lovejoin/sdk";

interface RewardAddressCapableWallet {
  getRewardAddresses(): Promise<string[]>;
}

/**
 * Maximum per-vault deposit index the auto-scanner will probe. Higher =
 * slower unlock; lower = a power user could "lose" later boxes. 1024 is
 * generous — at the 100M-lovelace denomination that's 102.4 ADA × 1024 =
 * over 100K ADA in deposits before the cap matters.
 */
export const MAX_INDEX_SCAN = 1024;

export type VaultKind = "wallet" | "password";

export interface UnlockedSeed {
  kind: VaultKind;
  /** The raw 32-byte master seed. Held in memory only. */
  seed: Uint8Array;
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
  /**
   * Number of Mix txs this box has been re-randomised through since its
   * deposit, as tracked by the self-hosted indexer. 0 for fresh deposits.
   * `undefined` when no backend is configured or the lookup failed —
   * the field is indexer-only metadata, not on-chain state.
   */
  generation?: number;
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
  provider: ChainProvider;
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
export function deriveDepositSecret(
  seed: Uint8Array,
  index: number,
): {
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
  return { kind: "wallet", seed };
}

/**
 * Recovery unlock — `seed = Argon2id(password, salt = recoverySalt(...))`.
 * Used by wallets that don't expose signData and as a cross-device
 * recovery path (same wallet + same password = same seed, no IndexedDB
 * blob required). Wallet still must be connected so we can read the
 * stake address that goes into the salt.
 *
 * Throws if the password is shorter than RECOVERY_PASSWORD_MIN_LENGTH or
 * if the wallet exposes no reward addresses. The Argon2id call typically
 * runs ~2 s on a 2025-era laptop with the v1 parameter set; callers
 * should show a spinner.
 */
export async function unlockFromPassword(args: {
  wallet: RewardAddressCapableWallet;
  password: string;
  network: RecoveryNetwork;
}): Promise<UnlockedSeed> {
  if (args.password.length < RECOVERY_PASSWORD_MIN_LENGTH) {
    throw new Error(`password: must be at least ${RECOVERY_PASSWORD_MIN_LENGTH} characters`);
  }
  const rewards = await args.wallet.getRewardAddresses();
  if (!rewards || rewards.length === 0) {
    throw new Error("wallet: exposed no reward (stake) addresses — cannot derive a recovery salt");
  }
  const salt = recoverySalt({
    network: args.network,
    stakeAddrBech32: rewards[0]!,
  });
  // hash-wasm returns a `Uint8Array` when outputType is "binary", but its
  // type narrowing routes through a string union; cast and copy out of
  // the wasm-backed buffer (same pattern the prior BIP-39 vault used).
  const raw = (await argon2id({
    password: args.password,
    salt,
    iterations: RECOVERY_KDF_PARAMS_V1.iterations,
    memorySize: RECOVERY_KDF_PARAMS_V1.memorySizeKib,
    parallelism: RECOVERY_KDF_PARAMS_V1.parallelism,
    hashLength: RECOVERY_KDF_PARAMS_V1.hashLength,
    outputType: "binary",
  })) as Uint8Array;
  return { kind: "password", seed: Uint8Array.from(raw) };
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
