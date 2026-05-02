// Wallet adapter — mesh integration for CIP-30 (browser) and server-side
// wallets (CLI keys, mnemonic).
//
// Spec: docs/spec/04-offchain.md §"Package layout" and §"Wallet integration".
//
// The tx builders in `tx/{deposit,withdraw,mix}.ts` consume a structural
// `LovejoinWallet` interface — the minimum surface they need to fund inputs,
// pay fees, source collateral, sign, and submit. Both mesh's `MeshWallet`
// (server-side) and `BrowserWallet` (CIP-30) already satisfy that surface, so
// no runtime wrapper is required: callers pass the mesh wallet directly.
//
// Why dynamic imports for mesh: `@meshsdk/core` transitively pulls
// `libsodium-wrappers-sumo`, whose ESM build has a broken relative import
// (`./libsodium-sumo.mjs`) that fails under pnpm's strict layout. Eagerly
// importing mesh would crash any unit test that imports the SDK index. By
// deferring the mesh import to the factory functions, callers that don't
// need mesh wallets (most unit tests; the params + crypto layers) don't pay
// the cost or hit the bug. The factory functions themselves still throw
// loudly if the dynamic import fails.

import type { Utxo } from "../chain/provider.js";

// Type-only imports erase to nothing at runtime — they don't trigger the
// libsodium load. Runtime code below uses `await import("@meshsdk/core")`.
import type {
  BrowserWallet,
  MeshWallet,
  IFetcher,
  ISubmitter,
  UTxO as MeshUtxo,
} from "@meshsdk/core";

/**
 * The minimum wallet surface the Lovejoin tx builders need.
 *
 * Both `MeshWallet` and `BrowserWallet` from `@meshsdk/core` are structural
 * subtypes — pass either directly. We do not require IWallet by name to keep
 * this module re-usable if we ever swap out mesh.
 */
export interface LovejoinWallet {
  /** All addresses the wallet has ever received funds on (bech32). */
  getUsedAddresses(): Promise<string[]>;
  /**
   * Bech32 change address. Mesh's two wallets disagree on whether this is
   * sync or async (`MeshWallet` returns a string; `BrowserWallet` returns a
   * `Promise<string>`). The union admits both — call sites `await` it
   * either way.
   */
  getChangeAddress(): string | Promise<string>;
  /**
   * Spendable UTxOs. Mesh's two wallets disagree on the resolved shape:
   * `BrowserWallet` returns parsed `UTxO[]`; `MeshWallet` returns CBOR-hex
   * strings. The tx builders normalize at the call site.
   */
  getUtxos(): Promise<MeshUtxo[] | string[] | undefined>;
  /** Wallet-side collateral candidates. Same shape ambiguity as getUtxos. */
  getCollateral(): Promise<MeshUtxo[] | string[] | undefined>;
  /** Sign a CBOR-hex tx; returns the signed tx as CBOR hex. */
  signTx(unsignedTx: string, partialSign?: boolean): Promise<string>;
  /** Submit a signed tx; returns the txid. */
  submitTx(signedTx: string): Promise<string>;
}

/**
 * Network id mapping. Mesh expects `0` for testnets (preview/preprod) and `1`
 * for mainnet — there is no separate value for preprod vs preview at the
 * wallet level (they share network id 0; the discriminator is the magic).
 */
export type LovejoinNetworkId = 0 | 1;

export function networkIdFor(network: string): LovejoinNetworkId {
  return network === "mainnet" ? 1 : 0;
}

export interface ServerWalletOptions {
  /** Network id derived from the config network name. */
  networkId: LovejoinNetworkId;
  /**
   * Optional fetcher (chain queries). For Lovejoin tx builders we usually
   * don't need this — the SDK's own ChainProvider handles queries — but mesh
   * uses the fetcher to fill in missing UTxO information at sign time.
   */
  fetcher?: IFetcher;
  /** Optional submitter (tx submission). Same caveat as fetcher. */
  submitter?: ISubmitter;
}

/**
 * Construct a `MeshWallet` from a cardano-cli `payment.skey` hex string.
 *
 * cardano-cli skeys are 64-hex-char strings prefixed with `5820` (CBOR
 * bytes(32) tag) — this is exactly what mesh's `key.type = "cli"` consumes.
 * The optional `stake` lets the wallet compute the base address; without it,
 * the wallet exposes the enterprise address only.
 */
export async function createCliMeshWallet(
  opts: ServerWalletOptions & {
    payment: string;
    stake?: string;
  },
): Promise<MeshWallet> {
  const { MeshWallet } = await import("@meshsdk/core");
  return new MeshWallet({
    networkId: opts.networkId,
    ...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
    ...(opts.submitter ? { submitter: opts.submitter } : {}),
    key: opts.stake
      ? { type: "cli", payment: opts.payment, stake: opts.stake }
      : { type: "cli", payment: opts.payment },
  });
}

/**
 * Construct a `MeshWallet` from a 24-word BIP-39 mnemonic. Useful for
 * integration tests and the CLI's `--mnemonic` flag.
 */
export async function createMnemonicMeshWallet(
  opts: ServerWalletOptions & { mnemonic: string[] },
): Promise<MeshWallet> {
  if (opts.mnemonic.length < 12) {
    throw new Error(`mnemonic must be at least 12 words, got ${opts.mnemonic.length}`);
  }
  const { MeshWallet } = await import("@meshsdk/core");
  return new MeshWallet({
    networkId: opts.networkId,
    ...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
    ...(opts.submitter ? { submitter: opts.submitter } : {}),
    key: { type: "mnemonic", words: opts.mnemonic },
  });
}

/**
 * Connect to a CIP-30 browser wallet by id (e.g. "lace", "eternl", "nami").
 * Thin re-export of mesh's `BrowserWallet.enable` so UI code doesn't need to
 * import the mesh class directly.
 *
 * Throws when called from a non-browser environment — mesh's BrowserWallet
 * relies on `window.cardano`.
 */
export async function connectBrowserWallet(name: string): Promise<BrowserWallet> {
  const { BrowserWallet } = await import("@meshsdk/core");
  return BrowserWallet.enable(name);
}

// ---------------------------------------------------------------------------
// UTxO converters — pure, no mesh runtime needed.
// ---------------------------------------------------------------------------

/**
 * Normalize the polymorphic return of `LovejoinWallet.getUtxos()` (or
 * `getCollateral()`) into a `MeshUtxo[]` the tx builders can hand to mesh.
 *
 * `MeshWallet` and `BrowserWallet` both return `UTxO[]` when called without
 * an address-type argument; the raw CIP-30 byte-string form (`string[]` of
 * CBOR-encoded TransactionUnspentOutput hex) is rare in mesh-mediated code
 * but allowed by the IWallet contract. We surface a clear error on the
 * string case rather than pulling in a CBOR decoder here.
 */
export function normalizeWalletUtxos(raw: MeshUtxo[] | string[] | undefined): MeshUtxo[] {
  if (!raw || raw.length === 0) return [];
  if (typeof raw[0] === "string") {
    throw new Error(
      "wallet.getUtxos returned CBOR-hex strings; expected parsed UTxO[]. " +
        "Wrap the wallet so utxos are pre-parsed (mesh's MeshWallet/BrowserWallet do this).",
    );
  }
  return raw as MeshUtxo[];
}

/**
 * Convert mesh's `UTxO` shape (used by wallets and the mesh tx builder) into
 * the lighter `Utxo` shape from `chain/provider.ts` that Lovejoin tx builders
 * use internally. The two shapes differ in:
 *
 *   * mesh splits `(input, output)`; we keep them flat.
 *   * mesh uses `Asset[]` (unit/quantity strings) for value; we use a
 *     bigint-keyed record + a separate lovelace field.
 */
export function meshUtxoToLovejoin(u: MeshUtxo): Utxo {
  let lovelace = 0n;
  const assets: Record<string, bigint> = {};
  for (const a of u.output.amount) {
    if (a.unit === "lovelace") {
      lovelace = BigInt(a.quantity);
    } else {
      assets[a.unit] = (assets[a.unit] ?? 0n) + BigInt(a.quantity);
    }
  }
  return {
    ref: { txId: u.input.txHash.toLowerCase(), outputIndex: u.input.outputIndex },
    address: u.output.address,
    lovelace,
    assets,
    inlineDatum: u.output.plutusData ?? null,
    referenceScript: u.output.scriptRef ?? null,
  };
}

/**
 * Convert our flat `Utxo` shape back into mesh's `UTxO`. Used when tx builders
 * need to feed a wallet-fetched or chain-fetched UTxO into mesh's tx builder.
 */
export function lovejoinUtxoToMesh(u: Utxo): MeshUtxo {
  const amount: Array<{ unit: string; quantity: string }> = [
    { unit: "lovelace", quantity: u.lovelace.toString() },
  ];
  for (const [unit, qty] of Object.entries(u.assets)) {
    amount.push({ unit, quantity: qty.toString() });
  }
  return {
    input: { txHash: u.ref.txId, outputIndex: u.ref.outputIndex },
    output: {
      address: u.address,
      amount,
      ...(u.inlineDatum ? { plutusData: u.inlineDatum } : {}),
      ...(u.referenceScript ? { scriptRef: u.referenceScript } : {}),
    },
  };
}
