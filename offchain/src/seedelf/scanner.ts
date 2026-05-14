// Seedelf UTxO scanner.
//
// Spec: issue #135. The Vault unlock derives a single 32-byte seed and a
// counter `i` of per-index secrets. To surface a user's Seedelf wallet
// state we walk the wallet-script address, decode each UTxO's inline
// datum as a Register, and check `[x_i]·g == u` for each candidate
// secret. A match means we hold the secret and can spend the UTxO.
//
// Two flavours of "owned UTxO" are surfaced separately:
//
//   - **Registers** (locator NFTs): UTxOs carrying a 5eed0e1f… token. The
//     user's "Seedelf addresses" — what they share with senders. There is
//     typically one register per index, but there may be more if the user
//     used `util mint` to publish multiple locator tokens for the same
//     secret. Treated as the user-facing identities.
//   - **Funds**: UTxOs at the wallet address that don't carry a 5eed0e1f
//     token but whose datum the user owns. These are the result of
//     someone sending into one of the user's registers via re-randomization
//     and are the spendable balance.
//
// Both come from the same scan — we partition by token presence after
// the ownership filter runs.

import type { ChainProvider, Utxo } from "../chain/provider.js";
import type { Scalar } from "../crypto/bls.js";
import { decodeRegisterDatum, ownsSeedelfRegister, type SeedelfRegister } from "./register.js";
import { isSeedelfAssetName } from "./token.js";
import { seedelfWalletAddressBech32, type SeedelfAddresses } from "./addresses.js";

/**
 * The maximum derivation index the scanner probes by default. The cost is
 * O(N_indices * N_pool_utxos) point compares; 256 indices keeps the
 * unlock cheap while covering far more registers than a normal user will
 * create. Operators can raise it via the explicit option.
 */
export const DEFAULT_MAX_SCAN_INDEX = 256;

/** A Seedelf UTxO the active vault unlocks. */
export interface OwnedSeedelfUtxo {
  /** The chain UTxO. */
  utxo: Utxo;
  /** Decoded inline datum. */
  register: SeedelfRegister;
  /** The seed-derivation index that produced the matching secret. */
  index: number;
  /** Owner secret scalar — convenience for downstream tx builders. */
  secret: Scalar;
  /** Hex-encoded seedelf locator token name, if this UTxO carries one. */
  seedelfTokenHex: string | null;
}

export interface ScanSeedelfArgs {
  provider: ChainProvider;
  addresses: SeedelfAddresses;
  /**
   * Per-index secrets the active vault can produce, in derivation order.
   * The scanner stops looking once it has tried each secret against every
   * UTxO — secrets are NOT re-derived inside the scanner so the caller
   * controls the HKDF cost.
   */
  secrets: ReadonlyArray<{ index: number; secret: Scalar }>;
}

export interface ScanSeedelfResult {
  /** Registers (locator-NFT UTxOs) the user owns, ordered by derivation index. */
  registers: OwnedSeedelfUtxo[];
  /** Funded UTxOs the user owns (no locator NFT), ordered by chain UTxO ref. */
  funds: OwnedSeedelfUtxo[];
  /** Total UTxOs scanned at the wallet script address. */
  scannedCount: number;
}

/**
 * Walk all UTxOs at the Seedelf wallet script address and classify them
 * relative to the active vault's per-index secrets.
 *
 * Implementation cost: one provider `getUtxos` (paginated), then for each
 * UTxO at most `secrets.length` point-equality checks. Caller should
 * keep `secrets` small — typical vaults have a handful of registers.
 */
export async function scanSeedelfUtxos(args: ScanSeedelfArgs): Promise<ScanSeedelfResult> {
  const address = seedelfWalletAddressBech32(args.addresses);
  const utxos = await args.provider.getUtxos(address);
  return classifySeedelfUtxos({ utxos, secrets: args.secrets });
}

/**
 * Pure classifier: split UTxOs at the wallet script address into
 * registers vs funds vs not-mine. Used by `scanSeedelfUtxos` after a
 * provider fetch; also useful in tests with a fixed UTxO list.
 */
export function classifySeedelfUtxos(args: {
  utxos: ReadonlyArray<Utxo>;
  secrets: ReadonlyArray<{ index: number; secret: Scalar }>;
}): ScanSeedelfResult {
  const registers: OwnedSeedelfUtxo[] = [];
  const funds: OwnedSeedelfUtxo[] = [];
  for (const utxo of args.utxos) {
    if (!utxo.inlineDatum) continue;
    const register = decodeRegisterDatum(utxo.inlineDatum);
    if (!register) continue;

    // Find the secret that unlocks this register, if any. Bail on the
    // first match — a register's `(g, u)` pair is by construction owned
    // by exactly one secret.
    let match: { index: number; secret: Scalar } | null = null;
    for (const cand of args.secrets) {
      if (ownsSeedelfRegister(register, cand.secret)) {
        match = cand;
        break;
      }
    }
    if (!match) continue;

    const seedelfTokenHex = pickSeedelfToken(utxo, args);
    const owned: OwnedSeedelfUtxo = {
      utxo,
      register,
      index: match.index,
      secret: match.secret,
      seedelfTokenHex,
    };
    if (seedelfTokenHex) {
      registers.push(owned);
    } else {
      funds.push(owned);
    }
  }
  registers.sort((a, b) => a.index - b.index);
  funds.sort((a, b) => {
    if (a.utxo.ref.txId === b.utxo.ref.txId) {
      return a.utxo.ref.outputIndex - b.utxo.ref.outputIndex;
    }
    return a.utxo.ref.txId.localeCompare(b.utxo.ref.txId);
  });
  return { registers, funds, scannedCount: args.utxos.length };
}

function pickSeedelfToken(utxo: Utxo, _ctx: unknown): string | null {
  for (const unit of Object.keys(utxo.assets)) {
    // unit is `<policy_id_hex><asset_name_hex>`. Locate the asset-name
    // portion (everything after the 56-char policy prefix) and check
    // the seedelf prefix bytes. We don't constrain the policy to the
    // canonical seedelfPolicyId here because the scanner already
    // restricts to the wallet script address — any 5eed0e1f token
    // sitting there is the locator regardless of who minted it.
    if (unit.length < 56 + 8) continue;
    const assetNameHex = unit.slice(56);
    if (isSeedelfAssetName(assetNameHex)) return assetNameHex;
  }
  return null;
}
