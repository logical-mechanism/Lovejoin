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
 * The scan complexity is O(maxIndex · poolSize) scalar muls. On a
 * large vault (~50K pool × ~100 owned indices = 5M scalar muls) that's
 * several seconds of pure CPU. Running it on the main thread freezes
 * the UI and trips Chrome's "Wait for app" dialog even when we yield
 * every few indices — the wall-clock cost doesn't go away, we just
 * spread it across paint frames.
 *
 * Fix: the heavy loop runs in a Web Worker
 * (`scan-worker.ts`). The main thread fetches the pool (network I/O
 * is fine here), ships the raw `(a, b)` bytes to the worker, and
 * awaits the worker's `OwnedBox` hits. The UI stays interactive
 * throughout; the `scanInFlight` indicator keeps the user oriented.
 *
 * Worker fallback: if `Worker` isn't available (SSR, very old
 * browsers, test environments without worker support) we transparently
 * run the same loop on the main thread. Same correctness; same
 * "Wait for app" risk we had before.
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
  const networkId: 0 | 1 = args.addresses.network === "mainnet" ? 1 : 0;
  const mixBoxAddress = buildScriptAddress(args.addresses.mixBoxScriptHash, networkId);
  const pool = await fetchPool({
    provider: args.provider,
    mixBoxAddressBech32: mixBoxAddress,
    params: { denomLovelace },
  });

  // Try the worker path first. Wraps the message exchange in a
  // promise; falls back to the inline scan on any worker error
  // (instantiation failure, message error, etc.) so a worker-deficient
  // environment still produces results.
  if (typeof Worker !== "undefined") {
    try {
      const ownedRefs = await runScanInWorker({
        seed: args.seed,
        pool,
        maxIndex,
        minProbe,
      });
      return {
        ownedBoxes: ownedRefs.owned,
        poolSize: pool.length,
        nextDepositIndex: ownedRefs.nextDepositIndex,
      };
    } catch (e) {
      // Worker setup failed (bundler quirk, restricted environment,
      // etc.). Log once and fall through to the inline scan so the
      // user isn't dead-ended.
      console.warn(
        `[lovejoin/vault] scanPool worker unavailable, running on main thread: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return scanPoolInline({
    seed: args.seed,
    pool,
    maxIndex,
    minProbe,
  });
}

/**
 * Worker-backed scan. Posts the pool's raw `(ref, a, b)` triples to
 * `scan-worker.ts` and rehydrates the hits into `OwnedBox[]` on return.
 *
 * The worker bundles via Vite's `new URL(..., import.meta.url)` +
 * `{ type: "module" }` pattern so the BLS WASM lives in its own
 * module graph and initialises independently of the main thread's.
 */
async function runScanInWorker(args: {
  seed: Uint8Array;
  pool: ReadonlyArray<PoolEntry>;
  maxIndex: number;
  minProbe: number;
}): Promise<{ owned: OwnedBox[]; nextDepositIndex: number }> {
  // Lazy-import the worker URL so module-load time (which can pull the
  // worker bundle into the main thread's parse pass on some bundlers)
  // stays out of the unlock hot-path until we actually need it.
  const worker = new Worker(new URL("./scan-worker.ts", import.meta.url), {
    type: "module",
    name: "lovejoin-vault-scan",
  });
  try {
    const response = await new Promise<{
      hits: ReadonlyArray<{
        entryIdx: number;
        depositIndex: number;
        secretHex: string;
      }>;
      nextDepositIndex: number;
      poolSize: number;
    }>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent) => resolve(e.data);
      worker.onerror = (e: ErrorEvent) => reject(new Error(e.message || "scan worker errored"));
      worker.onmessageerror = () => reject(new Error("scan worker message error"));
      worker.postMessage({
        seed: args.seed,
        entries: args.pool.map((p) => ({ ref: p.ref, a: p.a, b: p.b })),
        maxIndex: args.maxIndex,
        minProbe: args.minProbe,
      });
    });
    // Rehydrate: each hit references an index into the pool array we
    // posted. We use that to grab the original `entry` (with its
    // `utxo` field intact) on the main thread, then convert the
    // worker's hex secret back to a Scalar for `OwnedBox.secret`.
    const owned: OwnedBox[] = [];
    for (const h of response.hits) {
      const entry = args.pool[h.entryIdx]!;
      owned.push({
        entry,
        index: h.depositIndex,
        secretHex: h.secretHex,
        secret: BigInt("0x" + h.secretHex),
      });
    }
    owned.sort((a, b) => a.index - b.index);
    return { owned, nextDepositIndex: response.nextDepositIndex };
  } finally {
    worker.terminate();
  }
}

/**
 * Main-thread scan, used as a fallback when the worker isn't
 * available. Identical logic to what the worker runs internally.
 * Yields every 4 indices so even the fallback path doesn't lock up
 * the browser on a moderate vault.
 */
async function scanPoolInline(args: {
  seed: Uint8Array;
  pool: ReadonlyArray<PoolEntry>;
  maxIndex: number;
  minProbe: number;
}): Promise<VaultScanResult> {
  type DecodedEntry = {
    entry: PoolEntry;
    aPt: ReturnType<typeof pointFromBytes>;
    bPt: ReturnType<typeof pointFromBytes>;
  };
  const decoded: DecodedEntry[] = [];
  for (const e of args.pool) {
    try {
      decoded.push({ entry: e, aPt: pointFromBytes(e.a), bPt: pointFromBytes(e.b) });
    } catch {
      // skip
    }
  }

  const owned: OwnedBox[] = [];
  let lastHit = -1;
  const YIELD_EVERY_INDICES = 4;
  for (let i = 0; i < args.maxIndex; i++) {
    const x = deriveOwnerSecret(args.seed, i);
    let matchedAny = false;
    let cachedSecretHex: string | null = null;
    for (const d of decoded) {
      if (pointEqual(scalarMul(x, d.aPt), d.bPt)) {
        if (cachedSecretHex === null) {
          cachedSecretHex = bytesToHex(scalarToBytes(x));
        }
        owned.push({
          entry: d.entry,
          index: i,
          secretHex: cachedSecretHex,
          secret: x,
        });
        matchedAny = true;
      }
    }
    if (matchedAny) lastHit = i;
    if (i - lastHit >= args.minProbe && lastHit >= 0) break;
    if (i - lastHit >= args.minProbe && lastHit < 0 && i >= args.minProbe * 2) break;
    if ((i + 1) % YIELD_EVERY_INDICES === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  owned.sort((a, b) => a.index - b.index);
  return {
    ownedBoxes: owned,
    poolSize: args.pool.length,
    nextDepositIndex: lastHit + 1,
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
