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
 * Pinned known.hosts.json, snapshot of upstream main as of 2026-05-11.
 * The `$pkh / $network / $utxo / $id / $idx / $url / $onion` template entry
 * upstream is dropped here — it's documentation, not a real host.
 *
 * 2026-05-11 bump: giveme.my rotated its key + collateral UTxOs.
 * Previous snapshot (2026-04-28) carried pkh 7c24c22d… / vkey fa2025e7…;
 * the new keyset is pkh 1108b97f… / vkey 754c1db5… and the per-network
 * collateral UTxOs moved. Mix txs built against the stale pkh started
 * returning HTTP 500 from the host's signer once the old key was
 * retired. The `onion` field is dropped: upstream removed it from the
 * `giveme.my` entry in the same bump.
 */
export const KNOWN_COLLATERAL_HOSTS: ReadonlyArray<KnownCollateralHost> = [
  {
    name: "giveme.my",
    networks: new Set(["preprod", "mainnet"]),
    pkhHex: "1108b97f2e199d58a0c0697d25412d0fb14d354dcd39654b9eb0dec8",
    publicKeyHex: "754c1db51aaee2e939b05b529ff5e210d8469afebcd2e487dae6f125fd500356",
    perNetwork: {
      preprod: {
        utxoTxId: "ef18e00c412c06b74606c5e68901693c3974b2073dbec1dfd8b74f01af3102a1",
        utxoOutputIndex: 0,
        url: "https://www.giveme.my/preprod/collateral/",
        onion: "",
      },
      mainnet: {
        utxoTxId: "1c2fbce4e3974f721b27226645c7a35d648698c77f62bc337b40bc2cd294e9cd",
        utxoOutputIndex: 0,
        url: "https://www.giveme.my/mainnet/collateral/",
        onion: "",
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
