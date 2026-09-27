// Seedelf network coordinates: script hashes + reference UTxOs.
//
// Spec: issue #135. We reuse the canonical Seedelf deployment on Preprod
// and Mainnet rather than publishing our own copy — the seedelf-contracts
// repo at https://github.com/logical-mechanism/Seedelf-Wallet ships fixed
// hashes per network, and so do we.
//
// The values are surfaced through `SeedelfAddresses` so the UI can pull
// them from build-time env vars (and operators running their own copy
// can override). Defaults come from
// platform/seedelf-core/src/constants.rs `get_config(1, _)` snapshot.

import type { UtxoRef } from "../chain/provider.js";
import { parseUtxoRef } from "../tx/params.js";
import { buildScriptAddress } from "../tx/address.js";

/** A Seedelf deployment, on a single Cardano network. */
export interface SeedelfAddresses {
  /** Lovejoin network discriminator the addresses belong to. */
  network: "preprod" | "preview" | "test" | "mainnet";
  /** 28-byte payment-script hash of the wallet (spend) validator. */
  walletScriptHash: string;
  /** 28-byte policy ID of the seedelf mint validator. */
  seedelfPolicyId: string;
  /** UTxO carrying the wallet validator as a reference script. */
  walletReferenceUtxoRef: UtxoRef;
  /** UTxO carrying the seedelf mint validator as a reference script. */
  seedelfReferenceUtxoRef: UtxoRef;
  /** CBOR byte size of the wallet reference script (for fee accounting). */
  walletReferenceScriptSize?: number;
  /** CBOR byte size of the seedelf reference script (for fee accounting). */
  seedelfReferenceScriptSize?: number;
}

/**
 * Canonical Seedelf preprod deployment, snapshot from upstream
 * seedelf-platform/seedelf-core/src/constants.rs `get_config(1, true)`.
 *
 * Operators running their own deployment override every field via
 * `.env` (see ui/.env.example). The defaults here keep the SDK usable
 * with zero configuration — `pnpm dev` works against the live Preprod
 * Seedelf without extra setup.
 */
export const SEEDELF_PREPROD_ADDRESSES: SeedelfAddresses = {
  network: "preprod",
  walletScriptHash: "94bca9c099e84ffd90d150316bb44c31a78702239076a0a80ea4a469",
  seedelfPolicyId: "84967d911e1a10d5b4a38441879f374a07f340945bcf9e7697485255",
  walletReferenceUtxoRef: {
    txId: "51f12c1a5c2b0558a284628d81b06dee50b27693242fe35618c5f921730c0527",
    outputIndex: 1,
  },
  seedelfReferenceUtxoRef: {
    txId: "f3955f42f660fae8b3e4dcf664011876cf769d87aa8450dc73171b4f6b5f520b",
    outputIndex: 1,
  },
  walletReferenceScriptSize: 629,
  seedelfReferenceScriptSize: 519,
};

/** Canonical Seedelf mainnet deployment. Same upstream snapshot. */
export const SEEDELF_MAINNET_ADDRESSES: SeedelfAddresses = {
  network: "mainnet",
  walletScriptHash: "94bca9c099e84ffd90d150316bb44c31a78702239076a0a80ea4a469",
  seedelfPolicyId: "84967d911e1a10d5b4a38441879f374a07f340945bcf9e7697485255",
  walletReferenceUtxoRef: {
    txId: "96fbddac63c55284fbbaa3c216ef1c0f460019e8643a889a189d5b5f7ddd71d6",
    outputIndex: 1,
  },
  seedelfReferenceUtxoRef: {
    txId: "f620a4e949bfbefbf2892d39d0777439f3acfbf850eae9b007c6558ba8ef4db4",
    outputIndex: 1,
  },
  walletReferenceScriptSize: 629,
  seedelfReferenceScriptSize: 519,
};

/**
 * Convenience: the canonical addresses for a Lovejoin network. Returns
 * null when no canonical deployment exists (`preview` and `test` ship no
 * Seedelf hashes today — operators must supply them via env vars).
 */
export function defaultSeedelfAddresses(
  network: "preprod" | "preview" | "test" | "mainnet",
): SeedelfAddresses | null {
  if (network === "preprod") return SEEDELF_PREPROD_ADDRESSES;
  if (network === "mainnet") return SEEDELF_MAINNET_ADDRESSES;
  return null;
}

/**
 * Bech32 enterprise script address for the Seedelf wallet validator —
 * where every Seedelf-funded UTxO lives. Mirrors how Lovejoin builds its
 * own mix-box address (CIP-19, payment = script hash, no stake credential).
 */
export function seedelfWalletAddressBech32(addresses: SeedelfAddresses): string {
  const networkId =
    addresses.network === "mainnet"
      ? 1
      : addresses.network === "preprod" ||
          addresses.network === "preview" ||
          addresses.network === "test"
        ? 0
        : 0;
  return buildScriptAddress(addresses.walletScriptHash, networkId as 0 | 1);
}

/**
 * Lightweight env/JSON loader. The UI populates this from
 * `VITE_SEEDELF_*` build-time vars when present, falling back to the
 * canonical hashes above. Returns null if any required field is missing
 * AND the network has no canonical default — operator misconfiguration.
 *
 * Inputs accept "<txid>#<index>" for UtxoRef fields, matching
 * addresses.json convention.
 */
export interface SeedelfAddressOverrides {
  walletScriptHash?: string;
  seedelfPolicyId?: string;
  /** "<txid>#<index>" */
  walletReferenceUtxoRef?: string;
  /** "<txid>#<index>" */
  seedelfReferenceUtxoRef?: string;
  walletReferenceScriptSize?: number;
  seedelfReferenceScriptSize?: number;
}

export function resolveSeedelfAddresses(
  network: "preprod" | "preview" | "test" | "mainnet",
  overrides: SeedelfAddressOverrides,
): SeedelfAddresses | null {
  const base = defaultSeedelfAddresses(network);
  const walletScriptHash = overrides.walletScriptHash || base?.walletScriptHash;
  const seedelfPolicyId = overrides.seedelfPolicyId || base?.seedelfPolicyId;
  const walletRefStr = overrides.walletReferenceUtxoRef;
  const seedelfRefStr = overrides.seedelfReferenceUtxoRef;
  const walletReferenceUtxoRef = walletRefStr
    ? parseUtxoRef(walletRefStr)
    : base?.walletReferenceUtxoRef;
  const seedelfReferenceUtxoRef = seedelfRefStr
    ? parseUtxoRef(seedelfRefStr)
    : base?.seedelfReferenceUtxoRef;
  if (
    !walletScriptHash ||
    !seedelfPolicyId ||
    !walletReferenceUtxoRef ||
    !seedelfReferenceUtxoRef
  ) {
    return null;
  }
  const walletReferenceScriptSize =
    overrides.walletReferenceScriptSize ?? base?.walletReferenceScriptSize;
  const seedelfReferenceScriptSize =
    overrides.seedelfReferenceScriptSize ?? base?.seedelfReferenceScriptSize;
  return {
    network,
    walletScriptHash,
    seedelfPolicyId,
    walletReferenceUtxoRef,
    seedelfReferenceUtxoRef,
    ...(walletReferenceScriptSize !== undefined ? { walletReferenceScriptSize } : {}),
    ...(seedelfReferenceScriptSize !== undefined ? { seedelfReferenceScriptSize } : {}),
  };
}
