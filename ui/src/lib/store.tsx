// Shared app state — single source of truth for the routes.
//
// Holds:
//   * `config` — runtime config (network, Blockfrost key, backend URL,
//     collateral provider endpoint). Persisted to localStorage via lib/sdk.
//   * `provider` — BlockfrostProvider built from `config`. Memoized so
//     screens don't see a new instance on every render.
//   * `addresses` — bootstrap output (addresses.<network>.json) loaded
//     async at mount.
//   * `wallet` — connected CIP-30 BrowserWallet handle + change address.
//   * `vault` — UnlockedVault handle once the user enters their passphrase.
//     null until then; routes that need persisted boxes show a "unlock vault"
//     prompt instead of crashing.
//   * `boxes` — the cached list of stored boxes; mutated through the helpers
//     so the vault stays the source of truth.
//
// We deliberately use plain React Context + useState here — adding redux /
// zustand for a five-route app is overkill, and the spec calls out no
// state-management lib. The trade-off: every state change re-renders every
// consumer. That's fine for the M6 surface; if perf bites we can split.

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
import { Vault, type StoredBox, type UnlockedVault } from "../storage/secrets.js";

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

  vault: UnlockedVault | null;
  vaultError: string | null;
  /**
   * Unlock or auto-create the on-disk vault. First call ever creates it
   * with a fresh salt; subsequent calls verify the passphrase. Throws on
   * a wrong passphrase so the UI can keep prompting.
   */
  unlockVault: (passphrase: string) => Promise<void>;
  lockVault: () => void;
  destroyVault: () => Promise<void>;

  boxes: StoredBox[];
  /**
   * Add or replace a stored box. Persists to the encrypted vault when
   * unlocked; keeps an in-memory mirror in `boxes` for the routes to render.
   */
  addBox: (box: StoredBox) => Promise<void>;
  removeBox: (txId: string, outputIndex: number) => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export interface AppStateProviderProps {
  children: ReactNode;
  /**
   * Overrides for tests. Inject a fixed initial config / pre-loaded
   * addresses so the component tree doesn't have to wait on fetch().
   */
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

  const [vault, setVault] = useState<UnlockedVault | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<StoredBox[]>([]);

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

  // Load addresses.<network>.json on first mount + whenever the user
  // switches network. Skipped under tests so unit tests don't depend on
  // a fetch shim.
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
      }
    },
    [],
  );

  const unlockVault = useCallback(async (passphrase: string) => {
    setVaultError(null);
    try {
      const v = await Vault.unlock(passphrase);
      setVault(v);
      const stored = await v.listBoxes();
      setBoxes(stored);
    } catch (e) {
      setVault(null);
      setBoxes([]);
      setVaultError((e as Error).message);
      throw e;
    }
  }, []);

  const lockVault = useCallback(() => {
    setVault(null);
    setBoxes([]);
    setVaultError(null);
  }, []);

  const destroyVault = useCallback(async () => {
    await Vault.destroy();
    setVault(null);
    setBoxes([]);
  }, []);

  const addBox = useCallback(
    async (box: StoredBox) => {
      if (vault) await vault.putBox(box);
      setBoxes((prev) => {
        const filtered = prev.filter(
          (b) => !(b.txId === box.txId && b.outputIndex === box.outputIndex),
        );
        return [box, ...filtered];
      });
    },
    [vault],
  );

  const removeBox = useCallback(
    async (txId: string, outputIndex: number) => {
      if (vault) await vault.deleteBox(txId, outputIndex);
      setBoxes((prev) =>
        prev.filter((b) => !(b.txId === txId && b.outputIndex === outputIndex)),
      );
    },
    [vault],
  );

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
    unlockVault,
    lockVault,
    destroyVault,
    boxes,
    addBox,
    removeBox,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppState(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppState: AppStateProvider missing");
  return v;
}
