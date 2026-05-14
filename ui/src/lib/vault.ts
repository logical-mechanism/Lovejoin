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
// Once unlocked, the vault scans the live pool (pre-decompressed per
// entry) for
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

import { newScanState, runIncrementalScan, type ScanCoreState } from "./scan-core.js";
import type { ScanResponse } from "./scan-core.js";

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
   * Number of Mix txs this box has been re-randomized through since its
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
 * A long-lived scanner bound to a (provider, addresses) pair. Holds the
 * decompression + ownership caches across rescans (see `scan-core.ts`)
 * so post-tx and tab-focus rescans only pay for the pool diff.
 *
 * Lifecycle: one scanner per unlocked vault session. Create on unlock,
 * `dispose()` on lock or when (provider, addresses) change.
 *
 * Worker-backed when `Worker` is available, with an inline fallback for
 * test environments and worker-deficient browsers. Both paths use
 * `runIncrementalScan` from `scan-core.ts`, so behaviour is identical;
 * only the threading differs. If the worker fails to instantiate or
 * errors mid-scan, the scanner permanently falls back to inline mode
 * for the rest of its life — recreating the worker on every retry
 * just amplifies whatever environmental issue caused the original
 * failure.
 */
export interface VaultScanner {
  scan(
    seed: Uint8Array,
    opts?: {
      maxIndex?: number;
      minProbe?: number;
    },
  ): Promise<VaultScanResult>;
  /**
   * Drop the scanner's caches without tearing down the worker. Use when
   * the vault is locked but the scanner instance might be reused for the
   * next unlock — keeping the worker alive saves the BLS WASM init on
   * the next scan. Seed-fingerprint detection inside `runIncrementalScan`
   * makes this defensive: a different seed would auto-reset anyway.
   */
  reset(): void;
  dispose(): void;
}

export interface CreateVaultScannerArgs {
  provider: ChainProvider;
  addresses: LovejoinAddresses;
}

export function createVaultScanner(args: CreateVaultScannerArgs): VaultScanner {
  const denomLovelace = BigInt(args.addresses.protocol.denom_lovelace);
  const networkId: 0 | 1 = args.addresses.network === "mainnet" ? 1 : 0;
  const mixBoxAddress = buildScriptAddress(args.addresses.mixBoxScriptHash, networkId);

  // Inline-mode state. Used either when no Worker is available or when
  // a worker error promoted the scanner into permanent inline mode.
  let inlineState: ScanCoreState | null = null;
  let worker: Worker | null = null;
  let workerBroken = false;
  let disposed = false;

  function ensureWorker(): Worker | null {
    if (workerBroken) return null;
    if (worker) return worker;
    if (typeof Worker === "undefined") return null;
    try {
      worker = new Worker(new URL("./scan-worker.ts", import.meta.url), {
        type: "module",
        name: "lovejoin-vault-scan",
      });
      return worker;
    } catch (e) {
      console.warn(
        `[lovejoin/vault] scan worker unavailable, running on main thread: ${e instanceof Error ? e.message : String(e)}`,
      );
      workerBroken = true;
      worker = null;
      return null;
    }
  }

  function tearDownWorker(): void {
    if (worker) {
      try {
        worker.terminate();
      } catch {
        // ignore
      }
      worker = null;
    }
  }

  async function runInWorker(
    w: Worker,
    seed: Uint8Array,
    pool: ReadonlyArray<PoolEntry>,
    maxIndex: number,
    minProbe: number,
  ): Promise<ScanResponse> {
    return new Promise<ScanResponse>((resolve, reject) => {
      w.onmessage = (e: MessageEvent<ScanResponse>) => resolve(e.data);
      w.onerror = (e: ErrorEvent) => reject(new Error(e.message || "scan worker errored"));
      w.onmessageerror = () => reject(new Error("scan worker message error"));
      w.postMessage({
        type: "scan",
        seed,
        entries: pool.map((p) => ({ ref: p.ref, a: p.a, b: p.b })),
        maxIndex,
        minProbe,
      });
    });
  }

  function runInline(
    seed: Uint8Array,
    pool: ReadonlyArray<PoolEntry>,
    maxIndex: number,
    minProbe: number,
  ): ScanResponse {
    if (!inlineState) inlineState = newScanState();
    return runIncrementalScan(inlineState, {
      seed,
      entries: pool.map((p) => ({ ref: p.ref, a: p.a, b: p.b })),
      maxIndex,
      minProbe,
    });
  }

  return {
    async scan(seed, opts) {
      if (disposed) throw new Error("vault scanner disposed");
      const maxIndex = opts?.maxIndex ?? MAX_INDEX_SCAN;
      const minProbe = opts?.minProbe ?? 8;
      const pool = await fetchPool({
        provider: args.provider,
        mixBoxAddressBech32: mixBoxAddress,
        params: { denomLovelace },
      });

      let response: ScanResponse | null = null;
      const w = ensureWorker();
      if (w) {
        try {
          response = await runInWorker(w, seed, pool, maxIndex, minProbe);
        } catch (e) {
          console.warn(
            `[lovejoin/vault] scan worker errored, falling back to inline: ${e instanceof Error ? e.message : String(e)}`,
          );
          tearDownWorker();
          workerBroken = true;
          // Inline state starts empty here, so this single rescan does
          // a full pass; subsequent rescans amortise it the same way.
        }
      }
      if (!response) {
        response = runInline(seed, pool, maxIndex, minProbe);
      }

      const owned: OwnedBox[] = [];
      for (const h of response.hits) {
        const entry = pool[h.entryIdx];
        if (!entry) continue;
        owned.push({
          entry,
          index: h.depositIndex,
          secretHex: h.secretHex,
          secret: BigInt("0x" + h.secretHex),
        });
      }
      owned.sort((a, b) => a.index - b.index);
      return {
        ownedBoxes: owned,
        poolSize: pool.length,
        nextDepositIndex: response.nextDepositIndex,
      };
    },
    reset() {
      if (disposed) return;
      if (worker) {
        try {
          worker.postMessage({ type: "reset" });
        } catch {
          // worker is in a bad state; tear it down so the next scan
          // re-creates it (or promotes to inline mode).
          tearDownWorker();
        }
      }
      if (inlineState) inlineState = null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      tearDownWorker();
      inlineState = null;
    },
  };
}

/**
 * Backwards-compatible one-shot scan. Equivalent to creating a
 * scanner, running one scan, and disposing it — i.e. always a full
 * (cold-cache) scan. New callers that rescan repeatedly should use
 * `createVaultScanner` directly so the decompression + ownership
 * caches survive across calls.
 */
export async function scanPool(args: {
  seed: Uint8Array;
  provider: ChainProvider;
  addresses: LovejoinAddresses;
  maxIndex?: number;
  /** Minimum gap of misses past the last hit before we stop scanning. */
  minProbe?: number;
}): Promise<VaultScanResult> {
  const scanner = createVaultScanner({ provider: args.provider, addresses: args.addresses });
  try {
    const opts: { maxIndex?: number; minProbe?: number } = {};
    if (args.maxIndex !== undefined) opts.maxIndex = args.maxIndex;
    if (args.minProbe !== undefined) opts.minProbe = args.minProbe;
    return await scanner.scan(args.seed, opts);
  } finally {
    scanner.dispose();
  }
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
