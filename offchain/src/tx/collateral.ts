// Collateral-provider abstraction.
//
// Spec: docs/spec/01-protocol.md §"Collateral provider", docs/spec/04-offchain.md
// §"Collateral provider client", docs/spec/08-threat-model.md §A6.
//
// Plutus txs require a collateral input that is **key-witnessed** — a wallet
// holding ADA stakes a UTxO that gets seized if any script fails validation.
// For deposit and withdraw the user's own wallet is already in the tx, so
// using its collateral is fine. For Mix txs the submitter MUST NOT contribute
// a wallet input (that's what makes Mix wallet-anonymous), so collateral has
// to come from a third party — the canonical choice is giveme.my.
//
// This module defines a single `CollateralProvider` interface with two
// implementations:
//   * `WalletProvider` — uses the LovejoinWallet's own `getCollateral()`
//     output. The wallet signs at tx-completion time as usual, so the
//     returned `externalWitness` is null.
//   * `GivemeMyProvider` — calls the giveme.my HTTP API to obtain a
//     pre-signed collateral input + return + witness. The witness is
//     attached directly to the tx body's witness set; the submitter
//     never signs the collateral input themselves.
//
// The Mix-tx-only "no wallet fallback" rule lives at the call site
// (tx/mix.ts in M4): if the configured `CollateralProvider` is unreachable,
// the SDK throws rather than silently switching to WalletProvider, because
// that would defeat the wallet-anonymity property. Deposit and withdraw set
// `provider = new WalletProvider(wallet)` explicitly, which is harmless
// because the wallet is in the tx anyway.

import type { Lovelace, Utxo } from "../chain/provider.js";

import type { LovejoinWallet } from "../wallet/cip30.js";
import { meshUtxoToLovejoin } from "../wallet/cip30.js";

/**
 * One vkey witness — public key + 64-byte Ed25519 signature.
 *
 * We keep the shape lean rather than inheriting from a CSL/mesh type so the
 * collateral surface stays pure-data and serializable across the giveme.my
 * HTTP boundary.
 */
export interface VkeyWitness {
  /** 32-byte Ed25519 public key, lowercase hex. */
  vkeyHex: string;
  /** 64-byte Ed25519 signature, lowercase hex. */
  signatureHex: string;
}

/**
 * What a CollateralProvider hands back. Same shape regardless of who provides
 * the collateral — wallet or external service.
 *
 * `externalWitness` is null when the wallet that holds the inputs is the same
 * wallet that will sign the tx via `signTx()` (the WalletProvider case).
 * GivemeMyProvider returns a pre-signed witness here so the submitter doesn't
 * need to ask their wallet to sign someone else's inputs (which it couldn't
 * do anyway).
 */
export interface CollateralProvision {
  /** UTxOs the collateral comes from. Almost always exactly one. */
  inputs: Utxo[];
  /** `sum(inputs.lovelace)` — the protocol-level "collateral total". */
  totalLovelace: Lovelace;
  /** Where unspent collateral returns to if scripts succeed. Bech32. */
  returnAddress: string;
  /**
   * Witness for `inputs`, or null if the tx-builder's wallet-signer covers
   * it. Only GivemeMyProvider sets this.
   */
  externalWitness: VkeyWitness | null;
}

/**
 * Information the provider needs to size and authorize a collateral input.
 */
export interface CollateralRequest {
  /**
   * 32-byte hash of the *body* of the to-be-built tx. For pre-signing
   * collateral against giveme.my the body must be finalized first
   * (everything except the witness set) and its hash submitted alongside
   * the request.
   *
   * For WalletProvider this field is informational and unused.
   */
  txBodyDigest: Uint8Array;
  /**
   * Minimum lovelace the provider needs to commit. Cardano's `collateralPercent`
   * protocol parameter (currently 150) means this is `ceil(estimated_fee * 1.5)`.
   * Tx builders compute this and pass it through.
   */
  collateralAmountLovelace: Lovelace;
}

export interface CollateralProvider {
  requestCollateral(args: CollateralRequest): Promise<CollateralProvision>;
}

// ---------------------------------------------------------------------------
// WalletProvider — sources collateral from the user's own wallet.
// ---------------------------------------------------------------------------

/**
 * The simple case: deposit + withdraw txs already have the user's wallet as
 * a signer, so we can pull collateral from `wallet.getCollateral()` and let
 * the wallet sign it as part of the normal `signTx` flow. No external
 * witness, no extra HTTP round-trip.
 *
 * If `getCollateral()` returns nothing or insufficient lovelace, the
 * provider throws — most CIP-30 wallets expose a configurable collateral
 * UTxO and require the user to set it up; the error nudges them toward that.
 */
export class WalletProvider implements CollateralProvider {
  constructor(
    private readonly wallet: LovejoinWallet,
    private readonly opts: { changeAddress?: string } = {},
  ) {}

  async requestCollateral(args: CollateralRequest): Promise<CollateralProvision> {
    const candidates = await this.wallet.getCollateral();
    const meshUtxos = normalizeCollateralCandidates(candidates);
    if (meshUtxos.length === 0) {
      throw new Error(
        "WalletProvider: wallet exposes no collateral UTxOs. Most CIP-30 wallets " +
        "require a dedicated collateral set in wallet settings — set one up and retry.",
      );
    }
    const inputs = meshUtxos.map(meshUtxoToLovejoin);
    const totalLovelace = inputs.reduce((acc, u) => acc + u.lovelace, 0n);
    if (totalLovelace < args.collateralAmountLovelace) {
      throw new Error(
        `WalletProvider: wallet collateral has ${totalLovelace} lovelace, need at least ` +
        `${args.collateralAmountLovelace}. Top up the wallet's collateral UTxO.`,
      );
    }
    const returnAddress = this.opts.changeAddress ?? (await this.wallet.getChangeAddress());
    return {
      inputs,
      totalLovelace,
      returnAddress,
      externalWitness: null,
    };
  }
}

/** Normalize CIP-30's `getCollateral` polymorphism into the mesh `UTxO` array. */
function normalizeCollateralCandidates(
  raw: Awaited<ReturnType<LovejoinWallet["getCollateral"]>>,
): Array<Parameters<typeof meshUtxoToLovejoin>[0]> {
  if (!raw) return [];
  if (raw.length === 0) return [];
  // CIP-30 native `getCollateral` returns hex strings (CBOR-encoded UTxO).
  // mesh's BrowserWallet pre-parses them into UTxO objects. We support both.
  if (typeof raw[0] === "string") {
    // The CBOR hex variant is rare in practice (mesh's BrowserWallet always
    // parses) and decoding it here would pull mesh's CSL bindings, which
    // currently can't load under the test harness. Surface an actionable
    // error and let the caller pre-decode in this case.
    throw new Error(
      "WalletProvider: wallet returned CBOR-hex collateral UTxOs. " +
      "Wrap the wallet so getCollateral() yields parsed UTxO objects (mesh's BrowserWallet does this).",
    );
  }
  return raw as Array<Parameters<typeof meshUtxoToLovejoin>[0]>;
}

// ---------------------------------------------------------------------------
// GivemeMyProvider — HTTP client for a giveme.my-shaped collateral service.
// ---------------------------------------------------------------------------

/**
 * Minimal `fetch` we depend on. Same pattern as BlockfrostProvider — keeps
 * the module testable without pulling node-fetch / undici.
 */
export type CollateralFetchFn = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface GivemeMyOptions {
  /** Base URL of the service. Default: https://giveme.my */
  endpoint?: string;
  /**
   * Optional API key header. The public service is free + stateless; an
   * operator running their own instance may require a key.
   */
  apiKey?: string;
  /** Optional injected fetch (defaults to globalThis.fetch). */
  fetchFn?: CollateralFetchFn;
  /** Network to request collateral on — sent as part of the request. */
  network: "preprod" | "preview" | "mainnet";
}

const GIVEME_MY_DEFAULT_ENDPOINT = "https://giveme.my";

/**
 * Client for a giveme.my-style collateral provider service.
 *
 * The exact wire format is governed by the upstream service
 * (https://github.com/logical-mechanism/Collateral-Provider). The shape this
 * client expects is a single POST to `/collateral` with a JSON body of:
 *
 *   { "network": "preprod", "tx_body_digest": "<64-hex>", "amount_lovelace": "5000000" }
 *
 * and a response of:
 *
 *   {
 *     "input": { "tx_id": "<64-hex>", "output_index": 0, "address": "<bech32>",
 *                "lovelace": "5000000", "assets": {} },
 *     "return_address": "<bech32>",
 *     "witness": { "vkey": "<64-hex>", "signature": "<128-hex>" }
 *   }
 *
 * If the upstream API ends up using a different schema, this client gets
 * adjusted in a single place — the rest of the SDK only sees the
 * CollateralProvider interface.
 *
 * Status: the wire format above is the SDK's *expected* schema. M3 only
 * exercises this client through unit tests against a mock fetch; M4's Mix
 * integration test will be the first time we hit a live giveme.my
 * deployment, which is when any schema mismatch surfaces.
 */
export class GivemeMyProvider implements CollateralProvider {
  private readonly endpoint: string;
  private readonly fetchFn: CollateralFetchFn;
  private readonly apiKey: string | undefined;
  private readonly network: GivemeMyOptions["network"];

  constructor(opts: GivemeMyOptions) {
    this.endpoint = (opts.endpoint ?? GIVEME_MY_DEFAULT_ENDPOINT).replace(/\/$/, "");
    const f = opts.fetchFn ?? (globalThis as { fetch?: CollateralFetchFn }).fetch;
    if (!f) {
      throw new Error(
        "GivemeMyProvider: no fetch implementation available. Pass `fetchFn` explicitly.",
      );
    }
    this.fetchFn = f;
    this.apiKey = opts.apiKey;
    this.network = opts.network;
  }

  async requestCollateral(args: CollateralRequest): Promise<CollateralProvision> {
    const body = JSON.stringify({
      network: this.network,
      tx_body_digest: bytesToHex(args.txBodyDigest),
      amount_lovelace: args.collateralAmountLovelace.toString(),
    });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const res = await this.fetchFn(`${this.endpoint}/collateral`, {
      method: "POST",
      headers,
      body,
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(
        `GivemeMyProvider: collateral request failed (${res.status} ${res.statusText}): ${errBody}`,
      );
    }
    const json = await res.json();
    return parseGivemeMyResponse(json);
  }
}

function parseGivemeMyResponse(raw: unknown): CollateralProvision {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`GivemeMyProvider: response is not an object (${typeof raw})`);
  }
  const r = raw as Record<string, unknown>;
  const inputObj = r.input;
  if (inputObj === null || typeof inputObj !== "object") {
    throw new Error("GivemeMyProvider: response.input missing or not an object");
  }
  const i = inputObj as Record<string, unknown>;
  const txId = String(i.tx_id ?? "").toLowerCase();
  const outputIndex = Number(i.output_index ?? 0);
  const address = String(i.address ?? "");
  const lovelace = BigInt(String(i.lovelace ?? "0"));
  const assetsRaw = i.assets;
  const assets: Record<string, bigint> = {};
  if (assetsRaw !== undefined && typeof assetsRaw === "object" && assetsRaw !== null) {
    for (const [k, v] of Object.entries(assetsRaw as Record<string, unknown>)) {
      assets[k] = BigInt(String(v));
    }
  }

  const returnAddress = String(r.return_address ?? "");
  const witnessRaw = r.witness;
  if (witnessRaw === null || typeof witnessRaw !== "object") {
    throw new Error("GivemeMyProvider: response.witness missing or not an object");
  }
  const w = witnessRaw as Record<string, unknown>;
  const witness: VkeyWitness = {
    vkeyHex: String(w.vkey ?? "").toLowerCase(),
    signatureHex: String(w.signature ?? "").toLowerCase(),
  };
  if (!/^[0-9a-f]{64}$/.test(witness.vkeyHex)) {
    throw new Error("GivemeMyProvider: response.witness.vkey is not 32-byte hex");
  }
  if (!/^[0-9a-f]{128}$/.test(witness.signatureHex)) {
    throw new Error("GivemeMyProvider: response.witness.signature is not 64-byte hex");
  }

  const input: Utxo = {
    ref: { txId, outputIndex },
    address,
    lovelace,
    assets,
    inlineDatum: null,
    referenceScript: null,
  };

  return {
    inputs: [input],
    totalLovelace: lovelace,
    returnAddress,
    externalWitness: witness,
  };
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
