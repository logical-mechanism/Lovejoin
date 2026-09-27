// useSeedelfState — wallet-derived Seedelf register/fund discovery for the Vault.
//
// Spec: issue #135 ("Vault UI extension: register list, balance, send,
// spend"). This hook pairs the unlocked vault seed with the SDK's Seedelf
// scanner so the Vault page can render the user's stealth wallet state
// alongside their Lovejoin owned boxes. It is read-only — mint / send /
// spend tx-builders are scoped for follow-up issues.
//
// The hook self-derives a small batch of Seedelf-domain secrets (16 by
// default) on demand, walks the wallet-contract address via the active
// `ChainProvider`, and partitions the resulting UTxOs into "registers"
// (carry a 5eed0e1f… locator NFT) and "funds" (re-randomized payments,
// no NFT). Scans are deduplicated by `(provider, addresses, seed,
// network)`; the UI's vault rescan path triggers a re-run.
//
// Cost: one HKDF expansion per index, one provider getUtxos call, one
// ownership probe (scalar-mul + point-equality) per (UTxO, index) pair.
// Cheap enough to call on every vault rescan; we don't worker-ize it
// the way the Lovejoin pool scanner does.

import { useEffect, useMemo, useState } from "react";

import {
  classifySeedelfUtxos,
  deriveSeedelfSecret,
  seedelfWalletAddressBech32,
  type SeedelfAddresses,
  type OwnedSeedelfUtxo,
} from "@lovejoin/sdk";

import { useAppState } from "./store.js";

/**
 * Maximum derivation index the Seedelf scanner probes. 16 covers a
 * realistic upper bound of registers a single user mints per wallet
 * before they would lean on the standalone seedelf-cli. The HKDF cost
 * per index is negligible (microseconds), so bumping later is free.
 */
export const SEEDELF_MAX_INDEX_SCAN = 16;

export interface SeedelfHookState {
  /** True iff the active network has a Seedelf deployment we can reach. */
  enabled: boolean;
  /** Wallet-script address funds park at; null when disabled. */
  walletAddressBech32: string | null;
  /** Owned registers (carry a 5eed0e1f… NFT), ordered by derivation index. */
  registers: OwnedSeedelfUtxo[];
  /** Owned funds (no locator NFT), ordered by UTxO ref. */
  funds: OwnedSeedelfUtxo[];
  /** Sum of lovelace across registers + funds. */
  totalLovelace: bigint;
  /** Loading flag — true during the initial scan and any subsequent rescan. */
  loading: boolean;
  /** Last scan error message, if any. */
  error: string | null;
  /** Manually trigger a rescan (vault rescan auto-triggers this via deps). */
  rescan: () => void;
}

/**
 * Mount the Seedelf scanner against the unlocked vault. Returns a `null`-ish
 * state (`enabled: false`) when:
 *
 *   - the active network has no canonical or overridden Seedelf addresses,
 *   - the vault is locked,
 *   - no chain provider is configured,
 *   - the Lovejoin addresses bundle hasn't loaded yet.
 *
 * The UI mounts this hook unconditionally and reads `enabled` to decide
 * whether to render the Seedelf section.
 */
export function useSeedelfState(seedelfAddresses: SeedelfAddresses | null): SeedelfHookState {
  const { provider, vault } = useAppState();
  const [registers, setRegisters] = useState<OwnedSeedelfUtxo[]>([]);
  const [funds, setFunds] = useState<OwnedSeedelfUtxo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rescanTick, setRescanTick] = useState(0);

  const enabled = !!provider && !!vault && !!seedelfAddresses;
  const walletAddressBech32 = useMemo(() => {
    if (!seedelfAddresses) return null;
    return seedelfWalletAddressBech32(seedelfAddresses);
  }, [seedelfAddresses]);

  useEffect(() => {
    let cancelled = false;
    if (!enabled || !provider || !vault || !seedelfAddresses) {
      setRegisters([]);
      setFunds([]);
      setError(null);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    setError(null);

    const secrets = Array.from({ length: SEEDELF_MAX_INDEX_SCAN }, (_, i) => ({
      index: i,
      secret: deriveSeedelfSecret(vault.seed, i),
    }));

    void (async () => {
      try {
        const utxos = await provider.getUtxos(seedelfWalletAddressBech32(seedelfAddresses));
        if (cancelled) return;
        const classified = classifySeedelfUtxos({ utxos, secrets });
        setRegisters(classified.registers);
        setFunds(classified.funds);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, provider, vault, seedelfAddresses, rescanTick]);

  const totalLovelace = useMemo(() => {
    let sum = 0n;
    for (const r of registers) sum += r.utxo.lovelace;
    for (const f of funds) sum += f.utxo.lovelace;
    return sum;
  }, [registers, funds]);

  return {
    enabled,
    walletAddressBech32,
    registers,
    funds,
    totalLovelace,
    loading,
    error,
    rescan: () => setRescanTick((n) => n + 1),
  };
}
