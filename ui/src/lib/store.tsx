// Shared app state — single source of truth for the routes.
//
// Holds:
//   * `config` — runtime config (network, Blockfrost key, backend URL,
//     collateral provider endpoint). Baked at build time from Vite env vars
//     (see lib/sdk.ts); developers can override via `?advanced=1`.
//   * `provider` — ChainProvider built from `config`. Backend-backed
//     when `backendUrl` is set (with Blockfrost as fallback); plain
//     Blockfrost otherwise. Memoized so screens don't see a new
//     instance on every render.
//   * `addresses` — bootstrap output (addresses.<network>.json) loaded
//     async at mount.
//   * `wallet` — connected CIP-30 BrowserWallet handle + change address.
//   * `vault` — null when locked; otherwise an `UnlockedSeed` (wallet-
//     signData or password-recovery derived) plus the most recent live
//     pool scan.
//   * `ownedBoxes` — derived view computed by walking the pool with the
//     vault's seed. Re-runs on (un)lock and on user-triggered rescan.
//
// Plain React Context + useState because the surface is small. The vault
// flow keeps the master seed in memory only; locking the vault drops the
// reference. Nothing about the vault is persisted — both unlock paths
// re-derive the seed on demand from inputs the user re-supplies.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { BrowserWallet } from "@meshsdk/core";
import type { LovejoinAddresses, ChainProvider } from "@lovejoin/sdk";

import { BackendClient } from "./backend.js";
import { loadAddresses, loadConfig, makeProvider, saveConfig, type RuntimeConfig } from "./sdk.js";
import { useAfterFirstPaint } from "./use-after-first-paint.js";
import {
  scanPool,
  unlockFromPassword,
  unlockFromWallet,
  type OwnedBox,
  type UnlockedSeed,
  type VaultScanResult,
} from "./vault.js";

export interface AppState {
  config: RuntimeConfig;
  setConfig: (next: RuntimeConfig) => void;

  provider: ChainProvider | null;
  providerError: string | null;

  addresses: LovejoinAddresses | null;
  addressesError: string | null;

  wallet: BrowserWallet | null;
  walletId: string | null;
  changeAddress: string | null;
  /**
   * Cached spendable lovelace from the connected wallet, refreshed at
   * connect, after every tx submit (success or failure), and on demand
   * via `refreshWalletBalance()`. Null when no wallet is connected, or
   * when a fetch failed (the UI treats null as "unknown" rather than
   * "zero").
   */
  walletLovelace: bigint | null;
  /** Re-read the connected wallet's lovelace into store state. */
  refreshWalletBalance: () => Promise<void>;
  setWallet: (
    args: { wallet: BrowserWallet; walletId: string; changeAddress: string } | null,
  ) => void;

  vault: UnlockedSeed | null;
  vaultError: string | null;
  vaultBusy: boolean;

  ownedBoxes: OwnedBox[];
  poolSize: number;
  nextDepositIndex: number;
  scanError: string | null;

  /**
   * Set of `${txId}#${outputIndex}` keys for boxes the user has just
   * submitted in a tx (Mix consuming an owned box, or Withdraw). Used
   * by the Vault row renderer to dim + lock those rows so the user
   * can't accidentally re-select them in the 12 s window between
   * submission and the post-submit rescan landing.
   *
   * Auto-clears on:
   *   * a successful rescan that no longer returns the ref (the chain
   *     confirmed our spend);
   *   * a 90 s safety timeout (covers the case where the tx ended up
   *     orphaned and the box reappeared in the user's set).
   */
  pendingTxRefs: ReadonlySet<string>;
  /**
   * Mark these refs as pending and start a 90 s safety timer. Idempotent
   * over already-pending refs.
   */
  markTxPending: (refs: ReadonlyArray<string>) => void;

  /** Drive the wallet-signData round-trip + initial pool scan. */
  unlockWithWallet: () => Promise<void>;
  /**
   * Recovery unlock: derive `seed = Argon2id(password, salt = recoverySalt(...))`.
   * Wallet must already be connected — its stake address goes into the
   * salt. ~2 s of Argon2id work; callers should show a spinner.
   */
  unlockWithPassword: (password: string) => Promise<void>;
  /** Drop the seed. Re-unlocking re-runs the chosen derivation. */
  lockVault: () => void;
  /** Re-walk the live pool with the current seed. Cheap; safe to call often. */
  rescan: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export interface AppStateProviderProps {
  children: ReactNode;
  testOverrides?: {
    initialConfig?: RuntimeConfig;
    addresses?: LovejoinAddresses;
    skipAddressLoad?: boolean;
    /**
     * Pre-seeded wallet state. Useful for tests that need to render
     * components which gate on a connected wallet (e.g. the
     * wallet-funded fan-out toggle in MixPanel) without having to
     * mount the WalletModal and walk through the connect handshake.
     */
    initialWallet?: { wallet: BrowserWallet; walletId: string; changeAddress: string };
  };
}

export function AppStateProvider({ children, testOverrides }: AppStateProviderProps) {
  const [config, setConfigState] = useState<RuntimeConfig>(
    () => testOverrides?.initialConfig ?? loadConfig(),
  );
  const [addresses, setAddresses] = useState<LovejoinAddresses | null>(
    testOverrides?.addresses ?? null,
  );
  const [addressesError, setAddressesError] = useState<string | null>(null);

  const [wallet, setWalletState] = useState<BrowserWallet | null>(
    testOverrides?.initialWallet?.wallet ?? null,
  );
  const [walletId, setWalletId] = useState<string | null>(
    testOverrides?.initialWallet?.walletId ?? null,
  );
  const [changeAddress, setChangeAddress] = useState<string | null>(
    testOverrides?.initialWallet?.changeAddress ?? null,
  );
  const [walletLovelace, setWalletLovelace] = useState<bigint | null>(null);

  const [vault, setVault] = useState<UnlockedSeed | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [vaultBusy, setVaultBusy] = useState(false);

  const [scan, setScan] = useState<VaultScanResult>({
    ownedBoxes: [],
    poolSize: 0,
    nextDepositIndex: 0,
  });
  const [scanError, setScanError] = useState<string | null>(null);

  // Pending-tx refs (refKey strings). `pendingExpiry` tracks when each
  // ref was marked so the safety timer can sweep stale entries even if
  // a rescan never confirms the spend (e.g. the user's tx got orphaned
  // and the box reappeared). Both maps are kept in lockstep.
  const [pendingTxRefs, setPendingTxRefs] = useState<ReadonlySet<string>>(() => new Set());
  const pendingExpiryRef = useRef<Map<string, number>>(new Map());
  const PENDING_SAFETY_MS = 90_000;
  const markTxPending = useCallback((refs: ReadonlyArray<string>) => {
    if (refs.length === 0) return;
    const now = Date.now();
    for (const ref of refs) {
      pendingExpiryRef.current.set(ref, now + PENDING_SAFETY_MS);
    }
    setPendingTxRefs((cur) => {
      const next = new Set(cur);
      for (const ref of refs) next.add(ref);
      return next;
    });
  }, []);

  const setConfig = useCallback((next: RuntimeConfig) => {
    saveConfig(next);
    setConfigState(next);
  }, []);

  const provider = useMemo<ChainProvider | null>(() => makeProvider(config), [config]);
  const providerError = useMemo<string | null>(
    () =>
      provider
        ? null
        : "Chain provider not configured. Set VITE_BLOCKFROST_PROJECT_ID at build time.",
    [provider],
  );

  // addresses.<network>.json is a static asset shipped from /public.
  // Home doesn't need it (the hero + pillars are pure i18n strings),
  // so we defer the fetch until after first paint — that takes the
  // request off the LCP-critical connection pool. Other routes that
  // depend on `addresses` already gate their UI on `addresses != null`.
  const addressesReady = useAfterFirstPaint(
    testOverrides?.skipAddressLoad === true || testOverrides?.addresses != null,
  );
  useEffect(() => {
    if (testOverrides?.skipAddressLoad) return;
    if (testOverrides?.addresses) return;
    if (!addressesReady) return;
    let cancelled = false;
    setAddresses(null);
    setAddressesError(null);
    loadAddresses(config.network)
      .then((a) => {
        if (!cancelled) setAddresses(a);
      })
      .catch((e: Error) => {
        if (!cancelled) setAddressesError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [config.network, addressesReady, testOverrides?.addresses, testOverrides?.skipAddressLoad]);

  const setWallet = useCallback(
    (args: { wallet: BrowserWallet; walletId: string; changeAddress: string } | null) => {
      if (args) {
        setWalletState(args.wallet);
        setWalletId(args.walletId);
        setChangeAddress(args.changeAddress);
      } else {
        setWalletState(null);
        setWalletId(null);
        setChangeAddress(null);
        setWalletLovelace(null);
        // Disconnecting the wallet implicitly locks the wallet-derived
        // vault since its seed is bound to that wallet's signature.
        setVault((cur) => (cur?.kind === "wallet" ? null : cur));
      }
    },
    [],
  );

  const refreshWalletBalance = useCallback(async () => {
    if (!wallet) {
      setWalletLovelace(null);
      return;
    }
    try {
      // CIP-30 wallets expose total spendable lovelace as a decimal
      // string. Coerce to bigint; null on parse failure so consumers
      // can render "unknown" instead of misreporting zero.
      const lov = await wallet.getLovelace();
      setWalletLovelace(BigInt(lov));
    } catch {
      setWalletLovelace(null);
    }
  }, [wallet]);

  // Pull the balance once on connect. Tx submit handlers re-call this
  // after their submit resolves so the form's "you have X ada" hint
  // updates without waiting for the next visibility refresh.
  useEffect(() => {
    if (!wallet) {
      setWalletLovelace(null);
      return;
    }
    void refreshWalletBalance();
  }, [wallet, refreshWalletBalance]);

  const runScan = useCallback(
    async (seed: Uint8Array) => {
      if (!provider || !addresses) return;
      setScanError(null);
      try {
        const result = await scanPool({ seed, provider, addresses });
        // Merge per-box `generation` from the indexer when a backend URL
        // is configured. The counter is indexer-only (the on-chain datum
        // has no room for it — see CLAUDE.md M4.5), so we degrade
        // silently when no backend is reachable: the Vault row just
        // hides the rounds column. One concurrent /box/:tx/:idx
        // request per owned box; small enough at typical vault sizes
        // that batching isn't worth the wire-shape churn.
        if (config.backendUrl && result.ownedBoxes.length > 0) {
          try {
            const client = new BackendClient(config.backendUrl);
            const enriched = await Promise.all(
              result.ownedBoxes.map(async (b) => {
                const lookup = await client.box(b.entry.ref);
                if (lookup && typeof lookup.generation === "number") {
                  return { ...b, generation: lookup.generation };
                }
                return b;
              }),
            );
            setScan({ ...result, ownedBoxes: enriched });
          } catch {
            setScan(result);
          }
        } else {
          setScan(result);
        }
        // Reconcile pending-tx refs against the fresh scan: any ref
        // that's no longer in the owned set is confirmed-spent (the
        // chain accepted the user's submit), and we drop the pending
        // mark. Refs that are still present stay marked — either the
        // tx hasn't landed yet or it got rolled back. The 90 s safety
        // timer below catches the rollback case.
        const stillOwned = new Set(
          result.ownedBoxes.map(
            (b) => `${b.entry.ref.txId.toLowerCase()}#${b.entry.ref.outputIndex}`,
          ),
        );
        let mutated = false;
        const survivors = new Set<string>();
        for (const ref of pendingTxRefs) {
          if (stillOwned.has(ref)) {
            survivors.add(ref);
          } else {
            pendingExpiryRef.current.delete(ref);
            mutated = true;
          }
        }
        if (mutated) setPendingTxRefs(survivors);
      } catch (e) {
        setScanError((e as Error).message);
      }
    },
    [provider, addresses, pendingTxRefs, config.backendUrl],
  );

  // Safety timer: prune expired pending refs every 10 s. Only matters
  // when a rescan never re-confirms the spend (orphaned tx, network
  // rollback, etc.) — under happy-path operation the rescan above
  // clears the entry first.
  useEffect(() => {
    if (pendingTxRefs.size === 0) return;
    const id = window.setInterval(() => {
      const now = Date.now();
      const survivors = new Set<string>();
      let mutated = false;
      for (const ref of pendingTxRefs) {
        const expiry = pendingExpiryRef.current.get(ref);
        if (expiry !== undefined && expiry > now) {
          survivors.add(ref);
        } else {
          pendingExpiryRef.current.delete(ref);
          mutated = true;
        }
      }
      if (mutated) setPendingTxRefs(survivors);
    }, 10_000);
    return () => window.clearInterval(id);
  }, [pendingTxRefs]);

  const unlockWithWallet = useCallback(async () => {
    if (!wallet) {
      setVaultError("Connect a wallet first.");
      throw new Error("no wallet");
    }
    setVaultBusy(true);
    setVaultError(null);
    try {
      const seed = await unlockFromWallet({ wallet });
      setVault(seed);
      await runScan(seed.seed);
    } catch (e) {
      setVault(null);
      setVaultError((e as Error).message);
      throw e;
    } finally {
      setVaultBusy(false);
    }
  }, [wallet, runScan]);

  const unlockWithPassword = useCallback(
    async (password: string) => {
      if (!wallet) {
        setVaultError("Connect a wallet first.");
        throw new Error("no wallet");
      }
      setVaultBusy(true);
      setVaultError(null);
      try {
        const unlocked = await unlockFromPassword({
          wallet,
          password,
          network: config.network,
        });
        setVault(unlocked);
        await runScan(unlocked.seed);
      } catch (e) {
        setVault(null);
        setVaultError((e as Error).message);
        throw e;
      } finally {
        setVaultBusy(false);
      }
    },
    [wallet, config.network, runScan],
  );

  const lockVault = useCallback(() => {
    setVault(null);
    setVaultError(null);
    setScan({ ownedBoxes: [], poolSize: 0, nextDepositIndex: 0 });
    setScanError(null);
    pendingExpiryRef.current.clear();
    setPendingTxRefs(new Set());
  }, []);

  const rescan = useCallback(async () => {
    if (!vault) return;
    await runScan(vault.seed);
  }, [vault, runScan]);

  // Auto-rescan whenever the addresses or provider change after unlock.
  useEffect(() => {
    if (!vault) return;
    runScan(vault.seed).catch(() => {});
  }, [vault, runScan]);

  const value: AppState = {
    config,
    setConfig,
    provider,
    providerError,
    addresses,
    addressesError,
    wallet,
    walletId,
    changeAddress,
    setWallet,
    vault,
    vaultError,
    vaultBusy,
    ownedBoxes: scan.ownedBoxes,
    poolSize: scan.poolSize,
    nextDepositIndex: scan.nextDepositIndex,
    scanError,
    unlockWithWallet,
    unlockWithPassword,
    lockVault,
    rescan,
    pendingTxRefs,
    markTxPending,
    walletLovelace,
    refreshWalletBalance,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppState(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppState: AppStateProvider missing");
  return v;
}
