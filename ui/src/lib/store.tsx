// Shared app state — single source of truth for the routes.
//
// Holds:
//   * `config` — runtime config (network, Blockfrost key, backend URL,
//     collateral provider endpoint). Baked at build time from Vite env vars
//     (see lib/sdk.ts); developers can override via `?advanced=1`.
//   * `provider` — BlockfrostProvider built from `config`. Memoized so
//     screens don't see a new instance on every render.
//   * `addresses` — bootstrap output (addresses.<network>.json) loaded
//     async at mount.
//   * `wallet` — connected CIP-30 BrowserWallet handle + change address.
//   * `vault` — null when locked; otherwise an `UnlockedSeed` (wallet- or
//     BIP-39-derived) plus the most recent live pool scan.
//   * `ownedBoxes` — derived view computed by walking the pool with the
//     vault's seed. Re-runs on (un)lock and on user-triggered rescan.
//
// Plain React Context + useState because the surface is small. The vault
// flow keeps the master seed in memory only; locking the vault drops the
// reference and the AES key the BIP-39 path holds.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { BrowserWallet } from "@meshsdk/core";
import type { LovejoinAddresses, BlockfrostProvider } from "@lovejoin/sdk";

import {
  loadAddresses,
  loadConfig,
  makeProvider,
  saveConfig,
  type RuntimeConfig,
} from "./sdk.js";
import {
  scanPool,
  unlockFromBip39,
  unlockFromWallet,
  type OwnedBox,
  type UnlockedSeed,
  type VaultScanResult,
} from "./vault.js";
import { EntropyVault } from "../storage/secrets.js";

export interface AppState {
  config: RuntimeConfig;
  setConfig: (next: RuntimeConfig) => void;

  provider: BlockfrostProvider | null;
  providerError: string | null;

  addresses: LovejoinAddresses | null;
  addressesError: string | null;

  wallet: BrowserWallet | null;
  walletId: string | null;
  changeAddress: string | null;
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

  /** Drive the wallet-signData round-trip + initial pool scan. */
  unlockWithWallet: () => Promise<void>;
  /** Unlock the BIP-39 fallback vault; null seed means "no entropy yet". */
  unlockWithPassphrase: (passphrase: string) => Promise<{ hasEntropy: boolean }>;
  /** Persist a fresh BIP-39 entropy hex into the unlocked vault. */
  storeEntropyHex: (entropyHex: string) => Promise<void>;
  /** Drop the seed + any open BIP-39 handle. */
  lockVault: () => void;
  /** Wipe the BIP-39 vault from disk. Wallet-derived path leaves nothing. */
  destroyVault: () => Promise<void>;
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

  const [wallet, setWalletState] = useState<BrowserWallet | null>(null);
  const [walletId, setWalletId] = useState<string | null>(null);
  const [changeAddress, setChangeAddress] = useState<string | null>(null);

  const [vault, setVault] = useState<UnlockedSeed | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [vaultBusy, setVaultBusy] = useState(false);

  const [scan, setScan] = useState<VaultScanResult>({
    ownedBoxes: [],
    poolSize: 0,
    nextDepositIndex: 0,
  });
  const [scanError, setScanError] = useState<string | null>(null);

  const setConfig = useCallback((next: RuntimeConfig) => {
    saveConfig(next);
    setConfigState(next);
  }, []);

  const provider = useMemo<BlockfrostProvider | null>(
    () => makeProvider(config),
    [config],
  );
  const providerError = useMemo<string | null>(
    () =>
      provider
        ? null
        : "Chain provider not configured. Set VITE_BLOCKFROST_PROJECT_ID at build time.",
    [provider],
  );

  useEffect(() => {
    if (testOverrides?.skipAddressLoad) return;
    if (testOverrides?.addresses) return;
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
  }, [config.network, testOverrides?.addresses, testOverrides?.skipAddressLoad]);

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
        // Disconnecting the wallet implicitly locks the wallet-derived
        // vault since its seed is bound to that wallet's signature.
        setVault((cur) => (cur?.kind === "wallet" ? null : cur));
      }
    },
    [],
  );

  const runScan = useCallback(
    async (seed: Uint8Array) => {
      if (!provider || !addresses) return;
      setScanError(null);
      try {
        const result = await scanPool({ seed, provider, addresses });
        setScan(result);
      } catch (e) {
        setScanError((e as Error).message);
      }
    },
    [provider, addresses],
  );

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

  const unlockWithPassphrase = useCallback(
    async (passphrase: string) => {
      setVaultBusy(true);
      setVaultError(null);
      try {
        const { seed, vault: bip39Vault } = await unlockFromBip39({ passphrase });
        if (!seed) {
          // Vault exists but no entropy yet — caller is mid-create.
          setVault({ kind: "bip39", seed: new Uint8Array(0), bip39Vault });
          return { hasEntropy: false };
        }
        const unlocked: UnlockedSeed = { kind: "bip39", seed, bip39Vault };
        setVault(unlocked);
        await runScan(seed);
        return { hasEntropy: true };
      } catch (e) {
        setVault(null);
        setVaultError((e as Error).message);
        throw e;
      } finally {
        setVaultBusy(false);
      }
    },
    [runScan],
  );

  const storeEntropyHex = useCallback(
    async (entropyHex: string) => {
      if (!vault || vault.kind !== "bip39" || !vault.bip39Vault) {
        throw new Error("vault: open the BIP-39 vault first");
      }
      await vault.bip39Vault.putEntropyHex(entropyHex);
      const seed = hexToBytes(entropyHex);
      const unlocked: UnlockedSeed = { kind: "bip39", seed, bip39Vault: vault.bip39Vault };
      setVault(unlocked);
      await runScan(seed);
    },
    [vault, runScan],
  );

  const lockVault = useCallback(() => {
    setVault(null);
    setVaultError(null);
    setScan({ ownedBoxes: [], poolSize: 0, nextDepositIndex: 0 });
    setScanError(null);
  }, []);

  const destroyVault = useCallback(async () => {
    await EntropyVault.destroy();
    lockVault();
  }, [lockVault]);

  const rescan = useCallback(async () => {
    if (!vault) return;
    await runScan(vault.seed);
  }, [vault, runScan]);

  // Auto-rescan whenever the addresses or provider change after unlock.
  useEffect(() => {
    if (!vault) return;
    if (vault.kind === "bip39" && vault.seed.length === 0) return;
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
    unlockWithPassphrase,
    storeEntropyHex,
    lockVault,
    destroyVault,
    rescan,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppState(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppState: AppStateProvider missing");
  return v;
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/^0x/i, "");
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
