// Known collateral-provider hosts.
//
// This is a verbatim, pinned copy of the upstream `known.hosts.json`:
// https://github.com/logical-mechanism/Collateral-Provider/blob/main/known.hosts.json
//
// We pin rather than fetch so:
//   * a build that worked yesterday still builds today (the upstream JSON
//     is editable by anyone with commit rights to that repo),
//   * production txs don't depend on a third-party HTTP fetch at build time,
//   * the public_key + payment-key-hash are part of the trust boundary —
//     pinning them is how we promise users "this is the only signer that
//     will witness your collateral."
//
// To bump: pull the latest known.hosts.json, sanity-check the new entries,
// and update this file. Do NOT add hosts you haven't independently verified
// — a malicious host can't steal user funds (their UTxO is the collateral,
// the user's wallet still signs every value-bearing input), but it CAN
// refuse to witness a Mix tx and break submission for that user.

/** Network discriminator that maps to upstream JSON keys. */
export type CollateralNetwork = "preprod" | "mainnet" | "testnet";

export interface KnownCollateralHost {
  /** Display name. Not used by the wire protocol. */
  name: string;
  /** Networks this host has signed-up to provide collateral on. */
  networks: ReadonlySet<CollateralNetwork>;
  /**
   * 28-byte payment-key-hash, lowercase hex. This is the value that
   * goes into `tx.required_signers` — the host's public key blake2b-224.
   * Equal to the JSON's top-level key.
   */
  pkhHex: string;
  /**
   * 32-byte Ed25519 public key, lowercase hex. The vkey returned in the
   * witness; we don't strictly need it for tx construction (the witness
   * payload includes it) but pinning it lets a paranoid client cross-check
   * `response.vkey == knownHost.publicKeyHex` and refuse mismatches.
   */
  publicKeyHex: string;
  /** Per-network configuration: collateral UTxO, HTTP endpoint, optional onion. */
  perNetwork: Readonly<Record<CollateralNetwork, KnownCollateralHostNetwork | undefined>>;
}

export interface KnownCollateralHostNetwork {
  /** Tx hash holding the host's collateral UTxO. */
  utxoTxId: string;
  /** Output index within that tx. */
  utxoOutputIndex: number;
  /** Clearnet endpoint, e.g. https://www.giveme.my/preprod/collateral/ */
  url: string;
  /** Tor endpoint, or empty string if not exposed. */
  onion: string;
}

/**
 * Pinned known.hosts.json, snapshot of upstream main as of 2026-04-28.
 * The `$pkh / $network / $utxo / $id / $idx / $url / $onion` template entry
 * upstream is dropped here — it's documentation, not a real host.
 */
export const KNOWN_COLLATERAL_HOSTS: ReadonlyArray<KnownCollateralHost> = [
  {
    name: "giveme.my",
    networks: new Set(["preprod", "mainnet"]),
    pkhHex: "7c24c22d1dc252d31f6022ff22ccc838c2ab83a461172d7c2dae61f4",
    publicKeyHex: "fa2025e788fae01ce10deffff386f992f62a311758819e4e3792887396c171ba",
    perNetwork: {
      preprod: {
        utxoTxId: "1d388e615da2dca607e28f704130d04e39da6f251d551d66d054b75607e0393f",
        utxoOutputIndex: 0,
        url: "https://www.giveme.my/preprod/collateral/",
        onion:
          "http://fjy3v62j7vqytvtviixsbixcmgyxgfolb7pg5bb3vcozxn4rrlu7z6ad.onion/preprod/collateral/",
      },
      mainnet: {
        utxoTxId: "e62351eacbdd001aee77a91805840d2b81f77feebbf2439fb01b79e76c42c839",
        utxoOutputIndex: 0,
        url: "https://www.giveme.my/mainnet/collateral/",
        onion:
          "http://fjy3v62j7vqytvtviixsbixcmgyxgfolb7pg5bb3vcozxn4rrlu7z6ad.onion/mainnet/collateral/",
      },
      testnet: undefined,
    },
  },
];

/**
 * Pick the canonical host for `network`, or null if no pinned host serves it.
 * Lovejoin's network strings (`preprod` / `preview` / `test` / `mainnet`)
 * map to the upstream's (`preprod` / `mainnet` / `testnet`) — `preview`
 * has no public host today, so we surface that as null and let callers
 * decide between failing or falling back to WalletProvider.
 */
export function getKnownCollateralHost(network: CollateralNetwork): KnownCollateralHost | null {
  for (const host of KNOWN_COLLATERAL_HOSTS) {
    if (host.networks.has(network) && host.perNetwork[network]) {
      return host;
    }
  }
  return null;
}

/**
 * Map Lovejoin's network discriminator (which includes `"preview"` and
 * `"test"`) to the collateral-provider network discriminator. Returns null
 * for networks the upstream doesn't index — caller should fall back to
 * WalletProvider in that case.
 */
export function lovejoinNetworkToCollateralNetwork(
  network: "preprod" | "preview" | "test" | "mainnet",
): CollateralNetwork | null {
  if (network === "preprod") return "preprod";
  if (network === "mainnet") return "mainnet";
  if (network === "test") return "testnet";
  // "preview" — no pinned host.
  return null;
}
