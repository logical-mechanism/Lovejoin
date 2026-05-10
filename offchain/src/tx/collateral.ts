// Collateral-provider abstraction.
//
// Spec: §"Collateral provider",
// §"Collateral provider client",  §A6.
//
// Plutus txs require a collateral input that is **key-witnessed** — a wallet
// holding ADA stakes a UTxO that gets seized if any script fails validation.
// For deposit and withdraw the user's own wallet is already in the tx, so
// using its collateral is fine. For Mix txs the submitter MUST NOT contribute
// a wallet input (that's what makes Mix wallet-anonymous), so collateral has
// to come from a third party — the canonical choice is giveme.my, run by
// Logical Mechanism out of
// https://github.com/logical-mechanism/Collateral-Provider.
//
// Two providers, one interface, two-step protocol:
//
//   1.  `prepareCollateral()` — synchronous-ish discovery. Returns the
//       collateral input(s), the return address, and (for an external host)
//       the host's required-signer pkh. No network signing yet. Tx builders
//       use the result to populate `txInCollateral` + `requiredSignerHash`
//       so mesh's `complete()` can size the body and run the evaluator.
//
//   2.  `signTxBody(txCborHex)` — given the *completed* tx CBOR, return a
//       vkey witness. WalletProvider returns null because the wallet's own
//       signTx() flow already covers the collateral input. GivemeMyProvider
//       POSTs the tx CBOR to the host and unpacks the response.
//
//       The caller merges the returned witness into the witness set
//       (see `witness-merge.ts`) and submits.
//
// This is a deliberate clean break from the original M3-era one-shot
// `requestCollateral()` interface. That shape encoded a body digest the
// upstream service never asked for and returned a fully-decoded vkey + sig
// pair before the body even existed — both wrong against the real wire
// format. The two-step shape mirrors what the Python / bash sample clients
// in the upstream repo actually do.

import type { ChainProvider, Lovelace, Utxo } from "../chain/provider.js";
import type { AdditionalUtxo } from "../chain/ogmios-utxo.js";
import {
  getKnownCollateralHost,
  lovejoinNetworkToCollateralNetwork,
  type CollateralNetwork,
  type KnownCollateralHost,
} from "./known-collateral-hosts.js";

import type { LovejoinWallet } from "../wallet/cip30.js";
import { meshUtxoToLovejoin } from "../wallet/cip30.js";

/**
 * One vkey witness — public key + 64-byte Ed25519 signature. We keep the
 * shape lean rather than inheriting from a CSL/mesh type so the collateral
 * surface stays pure-data and can cross the giveme.my HTTP boundary.
 */
export interface VkeyWitness {
  /** 32-byte Ed25519 public key, lowercase hex. */
  vkeyHex: string;
  /** 64-byte Ed25519 signature, lowercase hex. */
  signatureHex: string;
}

/**
 * Output of `prepareCollateral()`. Contains everything the tx builder needs
 * to wire the collateral input + return + (optional) required-signer into
 * mesh's MeshTxBuilder before the first `complete()` pass.
 */
export interface PreparedCollateral {
  /**
   * UTxOs to use as collateral. Almost always exactly one. mesh's
   * `txInCollateral(txHash, idx, amount, address)` consumes each entry.
   */
  inputs: Utxo[];
  /** `sum(inputs.lovelace)` — informational. */
  totalLovelace: Lovelace;
  /**
   * Bech32 address that unspent collateral returns to if all scripts pass.
   * For WalletProvider this is the wallet's change address; for an external
   * host it's the host's address (= the address attached to the host UTxO).
   * mesh derives the collateral_return body field from this when the
   * collateral input value exceeds the protocol-required collateral amount.
   */
  returnAddress: string;
  /**
   * 28-byte pubkey-hash, lowercase hex, that MUST appear in
   * `tx.required_signers`. Set by external hosts (their server-side
   * validators reject any tx that doesn't list them as a required signer).
   * Null for WalletProvider.
   */
  requiredSignerPkhHex: string | null;
  /**
   * True iff `signTxBody()` MUST be called and the returned witness MUST be
   * merged into the final witness set. False for WalletProvider — the
   * wallet's signTx() flow already covers the collateral input.
   */
  externallySigned: boolean;
}

/**
 * Optional second arg to {@link CollateralProvider.signTxBody}. Carried
 * as an `opts` object rather than positional args so additional fields
 * (rate-limit overrides, future Koios v1.3+ extensions) can be added
 * without breaking callers.
 */
export interface SignTxBodyOptions {
  /**
   * Extra `[txin, txout]` pairs spliced into Ogmios' chain state for the
   * evaluator's view of this tx — see giveme.my v1.2.0 `additional_utxos`
   * and Ogmios' `evaluateTransaction.additionalUtxo`. Use this to chain
   * a child tx onto an in-flight parent (Mix → Mix, Deposit → Mix,
   * Replenish → Mix) before the parent confirms.
   *
   * Missing or empty is fine — the field is skipped, matching the upstream
   * schema's "Missing or empty is fine — the field is skipped" rule.
   *
   * Trade-off: if the parent tx is dropped from the mempool (rollback,
   * fee race, replacement), the child becomes invalid. Caller is
   * responsible for resubmit-on-rollback; the SDK doesn't auto-rebuild.
   */
  additionalUtxos?: ReadonlyArray<AdditionalUtxo>;
}

export interface CollateralProvider {
  prepareCollateral(args: PrepareCollateralArgs): Promise<PreparedCollateral>;
  /**
   * Returns the host's vkey witness over the supplied tx body.
   *
   * For WalletProvider this returns `null` — the wallet will sign the
   * collateral input as part of its normal signTx() flow.
   *
   * For an external host this performs the network call and returns the
   * unpacked vkey+sig. Callers attach it via `witness-merge.appendVkeyWitness`.
   *
   * Pass `opts.additionalUtxos` to chain onto an in-flight parent tx — the
   * extra UTxOs are forwarded verbatim into the upstream Koios/Ogmios
   * evaluator. See {@link SignTxBodyOptions}.
   */
  signTxBody(txCborHex: string, opts?: SignTxBodyOptions): Promise<VkeyWitness | null>;
}

export interface PrepareCollateralArgs {
  /**
   * The chain provider — used by GivemeMyProvider to look up the host's
   * collateral UTxO (we know its ref + idx from `known-collateral-hosts.ts`,
   * but we need its current value + address). Optional for WalletProvider.
   */
  provider?: ChainProvider;
  /**
   * Minimum lovelace the collateral must commit. Cardano's `collateralPercent`
   * (currently 150) means this is `ceil(estimated_fee * 1.5)`. Tx builders
   * compute it; the provider uses it only as a lower bound assertion against
   * the available UTxO.
   */
  collateralAmountLovelace: Lovelace;
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
 * Mix txs MUST NOT use WalletProvider — that would leak the submitter's
 * wallet identity into the tx and defeat the wallet-anonymity property. The
 * Mix tx builder defaults to GivemeMyProvider for that reason.
 */
export class WalletProvider implements CollateralProvider {
  constructor(
    private readonly wallet: LovejoinWallet,
    private readonly opts: { changeAddress?: string } = {},
  ) {}

  async prepareCollateral(args: PrepareCollateralArgs): Promise<PreparedCollateral> {
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
      requiredSignerPkhHex: null,
      externallySigned: false,
    };
  }

  async signTxBody(_txCborHex: string, _opts?: SignTxBodyOptions): Promise<VkeyWitness | null> {
    return null;
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
    throw new Error(
      "WalletProvider: wallet returned CBOR-hex collateral UTxOs. " +
        "Wrap the wallet so getCollateral() yields parsed UTxO objects (mesh's BrowserWallet does this).",
    );
  }
  return raw as Array<Parameters<typeof meshUtxoToLovejoin>[0]>;
}

// ---------------------------------------------------------------------------
// GivemeMyProvider — HTTP client for the Collateral-Provider service.
// ---------------------------------------------------------------------------

/** Minimal `fetch` we depend on — same pattern as BlockfrostProvider. */
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

/**
 * Retry policy for transient HTTP failures from the collateral host.
 *
 * The upstream (giveme.my by default) occasionally returns Cloudflare 502 /
 * 503 / 504 during deploys or load spikes. A single fetch turns a recoverable
 * 30-second blip into a user-visible "submission failed" dialog. The retry
 * loop hides that under a brief backoff.
 *
 * Retry triggers (in `signTxBody`):
 *   - HTTP status `>= 500`, `408 Request Timeout`, or `429 Too Many Requests`.
 *   - Any thrown error from the `fetchFn` (DNS / connection / abort).
 *
 * Non-retryable: 2xx with a bad body (config bug — another attempt sees the
 * same shape) and 4xx other than 408 / 429 (caller bug — another attempt
 * sees the same rejection).
 *
 * The request is idempotent: the server signs over the canonical tx-body
 * hash, so a duplicate POST yields a valid witness for the same tx. Retrying
 * does not risk double-spend or duplicate submission.
 */
export interface CollateralRetryPolicy {
  /** Total attempts including the first. Must be `>= 1`. Default 3. */
  maxAttempts: number;
  /** Delay before attempt 2 in ms. Default 250. */
  initialDelayMs: number;
  /** Multiplier applied to the delay each retry. Default 2 (250ms, 500ms). */
  backoffFactor: number;
}

/** Sensible defaults; see {@link CollateralRetryPolicy}. */
export const DEFAULT_COLLATERAL_RETRY: Readonly<CollateralRetryPolicy> = {
  maxAttempts: 3,
  initialDelayMs: 250,
  backoffFactor: 2,
};

export interface GivemeMyOptions {
  /**
   * The Lovejoin network discriminator. Maps internally to the upstream's
   * collateral-provider network discriminator. `"preview"` has no pinned
   * host — construction throws.
   */
  network: "preprod" | "preview" | "test" | "mainnet";
  /**
   * Override the default host. Defaults to the canonical giveme.my entry
   * pinned in `known-collateral-hosts.ts`. Pass an explicit host when you
   * run your own collateral provider — the test fixture in
   * `known.hosts.json` (`testnet`) is one such case.
   */
  host?: KnownCollateralHost;
  /**
   * Override the host's HTTP endpoint. Defaults to `host.perNetwork[net].url`.
   *
   * Two valid shapes:
   *   * Full path including `/{network}/collateral/` — used as-is. Example:
   *     `https://www.giveme.my/preprod/collateral/`.
   *   * Base URL — `/{network}/collateral/` is appended automatically.
   *     Example: `https://giveme.my` becomes
   *     `https://giveme.my/preprod/collateral/`.
   *
   * Empty string is treated as "no override" — same as omitting the field.
   * Useful for pointing at a localhost dev server, the `.onion` endpoint
   * (when behind a Tor proxy), or a Logical-Mechanism mirror.
   */
  endpoint?: string;
  /** Optional injected fetch (defaults to globalThis.fetch). */
  fetchFn?: CollateralFetchFn;
  /**
   * Retry policy for transient HTTP failures (5xx, 408, 429, network throw).
   * Defaults to {@link DEFAULT_COLLATERAL_RETRY} (3 attempts, 250ms initial
   * delay, 2x backoff). Pass `{ maxAttempts: 1, initialDelayMs: 0, backoffFactor: 1 }`
   * to disable retries — useful for tests that want to see the bail path.
   */
  retry?: Partial<CollateralRetryPolicy>;
}

/**
 * Client for the Cardano Altruistic Collateral Provider service.
 *
 * Wire format (matches `scripts/py/query.py` + `scripts/bash/query.sh` in
 * the upstream repo):
 *
 *   POST  <endpoint>
 *   Content-Type: application/json
 *   Body:
 *     { "tx": "<full transaction CBOR hex>" }
 *
 *   Response 200:
 *     { "witness": "<cbor hex>" }   // hex-encoded `cbor([0, [vkey, sig]])`
 *
 *   Other status codes / `{error: ...}` payloads → throw.
 *
 * The field is the FULL transaction CBOR (`[body, witness_set, valid, aux]`),
 * not just the body — the server extracts `tx[0]` itself. The historical
 * `tx_body` field name reflected that misnomer; upstream renamed it to `tx`
 * in v1.2.0 and accepts the old name as an alias for one transition release,
 * so callers on older clients still work but new code should send `tx`.
 *
 * Trust model: the host signs over the canonical tx-body hash (after
 * re-canonicalising the OrderedSet fields), so a malicious response can't
 * forge a witness for a different tx. The worst a bad host can do is refuse
 * to sign, breaking submission for that tx — the user's funds are not at
 * risk.
 */
export class GivemeMyProvider implements CollateralProvider {
  private readonly host: KnownCollateralHost;
  private readonly endpoint: string;
  private readonly fetchFn: CollateralFetchFn;
  private readonly collateralNetwork: CollateralNetwork;
  private readonly retryPolicy: CollateralRetryPolicy;

  constructor(opts: GivemeMyOptions) {
    const collateralNetwork = lovejoinNetworkToCollateralNetwork(opts.network);
    if (!collateralNetwork) {
      throw new Error(
        `GivemeMyProvider: no pinned host for network "${opts.network}". ` +
          `Provide an explicit host via opts.host, or use WalletProvider.`,
      );
    }
    this.collateralNetwork = collateralNetwork;
    const host = opts.host ?? getKnownCollateralHost(collateralNetwork);
    if (!host) {
      throw new Error(
        `GivemeMyProvider: no pinned host for collateral-network "${collateralNetwork}". ` +
          `Pass opts.host explicitly.`,
      );
    }
    const perNet = host.perNetwork[collateralNetwork];
    if (!perNet) {
      throw new Error(
        `GivemeMyProvider: host "${host.name}" does not serve collateral-network "${collateralNetwork}".`,
      );
    }
    this.host = host;
    this.endpoint = resolveEndpoint(opts.endpoint, perNet.url, collateralNetwork);
    const injected = opts.fetchFn;
    const globalFetch = (globalThis as { fetch?: CollateralFetchFn }).fetch;
    if (!injected && !globalFetch) {
      throw new Error(
        "GivemeMyProvider: no fetch implementation available. Pass opts.fetchFn explicitly.",
      );
    }
    // Browser `fetch` is internal-slot-bound to Window — calling with
    // `this === GivemeMyProvider` throws "Illegal invocation". Bind to
    // globalThis when we picked up the global; pass injected mocks
    // through unmodified so test stubs see their intended `this`.
    this.fetchFn = injected ?? (globalFetch!.bind(globalThis) as CollateralFetchFn);
    this.retryPolicy = {
      maxAttempts: Math.max(1, opts.retry?.maxAttempts ?? DEFAULT_COLLATERAL_RETRY.maxAttempts),
      initialDelayMs: Math.max(
        0,
        opts.retry?.initialDelayMs ?? DEFAULT_COLLATERAL_RETRY.initialDelayMs,
      ),
      backoffFactor: opts.retry?.backoffFactor ?? DEFAULT_COLLATERAL_RETRY.backoffFactor,
    };
  }

  /**
   * Resolve the host's collateral UTxO. We pin the (txId, idx) but the
   * value + address change every time the host re-funds it, so we look the
   * UTxO up via the supplied chain provider on every call. If the UTxO has
   * been spent (the host hasn't refunded yet), we throw with an actionable
   * message — Mix submission can't proceed without it.
   */
  async prepareCollateral(args: PrepareCollateralArgs): Promise<PreparedCollateral> {
    if (!args.provider) {
      throw new Error(
        "GivemeMyProvider: prepareCollateral needs a ChainProvider to resolve " +
          "the host UTxO's current value and address. Pass `provider`.",
      );
    }
    const perNet = this.host.perNetwork[this.collateralNetwork];
    if (!perNet) {
      throw new Error(
        `GivemeMyProvider: host "${this.host.name}" no longer serves ${this.collateralNetwork}`,
      );
    }
    const utxo = await args.provider.getUtxoByRef({
      txId: perNet.utxoTxId,
      outputIndex: perNet.utxoOutputIndex,
    });
    if (!utxo) {
      throw new Error(
        `GivemeMyProvider: host "${this.host.name}" collateral UTxO ` +
          `${perNet.utxoTxId}#${perNet.utxoOutputIndex} not found on chain. ` +
          `The host may be out-of-band re-funding; retry shortly or fall back to WalletProvider.`,
      );
    }
    if (utxo.lovelace < args.collateralAmountLovelace) {
      throw new Error(
        `GivemeMyProvider: host UTxO has ${utxo.lovelace} lovelace, need at least ` +
          `${args.collateralAmountLovelace}. Pick a different host or wait for re-funding.`,
      );
    }
    return {
      inputs: [utxo],
      totalLovelace: utxo.lovelace,
      returnAddress: utxo.address,
      requiredSignerPkhHex: this.host.pkhHex,
      externallySigned: true,
    };
  }

  async signTxBody(txCborHex: string, opts?: SignTxBodyOptions): Promise<VkeyWitness | null> {
    if (!/^[0-9a-fA-F]+$/.test(txCborHex) || txCborHex.length < 2) {
      throw new Error("GivemeMyProvider.signTxBody: txCborHex must be non-empty hex");
    }
    // Build the JSON body. The `additional_utxos` field is OMITTED when
    // missing or empty — matches the upstream schema's "skipped when
    // empty" rule and keeps the wire identical to v1.1.x clients for the
    // confirmed-inputs case.
    const additional = opts?.additionalUtxos;
    const payload: { tx: string; additional_utxos?: ReadonlyArray<AdditionalUtxo> } = {
      tx: txCborHex,
    };
    if (additional && additional.length > 0) {
      payload.additional_utxos = additional;
    }
    // bigint values inside Ogmios `value` need a custom replacer — JSON.stringify
    // throws on bigints by default. Ogmios accepts JSON numbers for lovelace
    // values up to 2^53; that bound is well above the max-supply ceiling, so
    // serialising as numbers is fine in practice. We surface a clear error
    // rather than silently truncate if a caller chains a fictional UTxO with
    // out-of-range lovelace.
    const body = JSON.stringify(payload, (_key, value) => {
      if (typeof value === "bigint") {
        if (value > Number.MAX_SAFE_INTEGER) {
          throw new Error(
            `GivemeMyProvider.signTxBody: additional_utxos contains bigint ` +
              `${value} > Number.MAX_SAFE_INTEGER; Ogmios JSON cannot represent it`,
          );
        }
        return Number(value);
      }
      return value;
    });
    const { maxAttempts } = this.retryPolicy;
    const txBytes = txCborHex.length / 2;

    const additionalCount = additional && additional.length > 0 ? additional.length : 0;
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(
        `[lovejoin/collateral] POST ${this.endpoint} ` +
          `(host=${this.host.name}, txCbor=${txBytes} bytes, ` +
          `additional_utxos=${additionalCount}, attempt ${attempt}/${maxAttempts})`,
      );

      // Network-level failure: fetch threw before producing a Response.
      // Always retryable until we exhaust attempts; the request didn't
      // reach the upstream so it can't have side effects.
      let res: Awaited<ReturnType<CollateralFetchFn>>;
      try {
        res = await this.fetchFn(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
      } catch (fetchErr) {
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        lastErr = new Error(`GivemeMyProvider: fetch to ${this.endpoint} threw: ${msg}`);
        if (attempt < maxAttempts) {
          await this.sleepBeforeRetry(attempt, `fetch threw (${msg})`);
          continue;
        }
        throw lastErr;
      }

      console.log(`[lovejoin/collateral] HTTP ${res.status} ${res.statusText}`);

      // HTTP-level failure. Retry on the transient buckets (5xx / 408 / 429);
      // bail immediately on the deterministic ones (other 4xx). On bail, drop
      // the (first 400 bytes of) body into the message so the user sees
      // exactly what the upstream said.
      if (!res.ok) {
        const rawText = await res.text();
        const httpErr = new Error(
          `GivemeMyProvider: ${this.endpoint} returned HTTP ${res.status} ${res.statusText}. ` +
            `Body (first 400 bytes): ${rawText.slice(0, 400)}`,
        );
        const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
        lastErr = httpErr;
        if (retryable && attempt < maxAttempts) {
          await this.sleepBeforeRetry(attempt, `HTTP ${res.status}`);
          continue;
        }
        throw httpErr;
      }

      // 2xx — parse and return. Bad body is non-retryable: the server replied,
      // the response is just unexpected. Almost always a config bug (wrong
      // endpoint, wrong network) and another attempt would yield the same
      // shape. Detecting HTML up-front emits a pointed error when the
      // override sent us to a homepage instead of the API endpoint (e.g.
      // https://giveme.my vs https://www.giveme.my/preprod/collateral/).
      const rawText = await res.text();
      const looksHtml = /^\s*<(?:!doctype|html|head|body)/i.test(rawText);
      if (looksHtml) {
        throw new Error(
          `GivemeMyProvider: ${this.endpoint} returned HTML, not JSON — almost certainly a wrong endpoint. ` +
            `Expected a path ending in /{network}/collateral/. ` +
            `Body (first 200 bytes): ${rawText.slice(0, 200)}`,
        );
      }
      let json: unknown;
      try {
        json = JSON.parse(rawText);
      } catch (parseErr) {
        throw new Error(
          `GivemeMyProvider: ${this.endpoint} returned non-JSON. ` +
            `Original parse error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. ` +
            `Body (first 400 bytes): ${rawText.slice(0, 400)}`,
        );
      }
      return parseGivemeMyWitnessResponse(json, this.host.publicKeyHex);
    }
    // Unreachable: every iteration either returns or throws. The bound is
    // here to satisfy the type checker and to give a recognizable error if
    // the loop ever exits without a result.
    throw lastErr ?? new Error("GivemeMyProvider: retry loop exhausted without a result");
  }

  private async sleepBeforeRetry(attempt: number, symptom: string): Promise<void> {
    const { maxAttempts, initialDelayMs, backoffFactor } = this.retryPolicy;
    const delay = Math.round(initialDelayMs * Math.pow(backoffFactor, attempt - 1));
    console.log(
      `[lovejoin/collateral] retry ${attempt + 1}/${maxAttempts} after ${symptom}; sleeping ${delay}ms`,
    );
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /** The pkh that callers must list under `required_signers`. */
  get requiredSignerPkhHex(): string {
    return this.host.pkhHex;
  }

  /** Underlying host record — for diagnostics / verification. */
  get hostInfo(): KnownCollateralHost {
    return this.host;
  }
}

/**
 * Parse `{witness: "<hex>"}` where `<hex>` decodes (as CBOR) to the 2-element
 * sequence `[0, [vkey_bytes, sig_bytes]]`.
 *
 * The leading `0` is the witness-set field key (`vkey_witnesses`); we don't
 * use it — we know it's a vkey witness because that's the only thing this
 * service emits.
 *
 * `expectedPublicKeyHex`: if supplied, we cross-check that the returned vkey
 * matches the pinned public key. A mismatch means either the host rotated
 * keys (rare) or someone is MITM'ing the response — fail loudly.
 */
export function parseGivemeMyWitnessResponse(
  raw: unknown,
  expectedPublicKeyHex?: string,
): VkeyWitness {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`GivemeMyProvider: response is not an object (${typeof raw})`);
  }
  const r = raw as Record<string, unknown>;
  const witnessField = r["witness"];
  if (typeof witnessField !== "string" || witnessField.length === 0) {
    const errField = JSON.stringify(r).slice(0, 300);
    throw new Error(`GivemeMyProvider: response missing/empty "witness" field. Body: ${errField}`);
  }
  const witnessBytes = hexToBytes(witnessField);
  // Layout from upstream's `create_witness_cbor`:
  //   cbor.dumps([0, [vkey_bytes, sig_bytes]])
  // CBOR: 82 00 82 5820 <32 vkey> 5840 <64 sig>
  //   = 2 (1) + 1 (1) + 2 (1) + 2 (1) + 32 + 2 (1) + 64 = 100 bytes
  // (Server cbor2 may emit slightly different forms, so parse defensively.)
  if (witnessBytes.length < 4 || witnessBytes[0] !== 0x82) {
    throw new Error(
      `GivemeMyProvider: witness payload not a 2-element CBOR array (first byte 0x${(witnessBytes[0] ?? 0).toString(16)})`,
    );
  }
  // The first element is `int 0` — major type 0, value 0 → byte 0x00.
  if (witnessBytes[1] !== 0x00) {
    throw new Error(
      `GivemeMyProvider: witness payload's first element is not int(0) (got 0x${(witnessBytes[1] ?? 0).toString(16)})`,
    );
  }
  // Second element: a 2-element array [bytes(32), bytes(64)].
  if (witnessBytes[2] !== 0x82) {
    throw new Error(
      `GivemeMyProvider: witness payload's second element is not a 2-element CBOR array`,
    );
  }
  // bytes(32) header: 0x58 0x20
  if (witnessBytes[3] !== 0x58 || witnessBytes[4] !== 0x20) {
    throw new Error(`GivemeMyProvider: vkey field is not a 32-byte CBOR byte string`);
  }
  if (witnessBytes.length < 5 + 32 + 2 + 64) {
    throw new Error(
      `GivemeMyProvider: witness payload too short (got ${witnessBytes.length} bytes)`,
    );
  }
  const vkeyBytes = witnessBytes.subarray(5, 5 + 32);
  // bytes(64) header: 0x58 0x40
  if (witnessBytes[5 + 32] !== 0x58 || witnessBytes[5 + 32 + 1] !== 0x40) {
    throw new Error(`GivemeMyProvider: signature field is not a 64-byte CBOR byte string`);
  }
  const sigBytes = witnessBytes.subarray(5 + 32 + 2, 5 + 32 + 2 + 64);

  const vkeyHex = bytesToHex(vkeyBytes);
  const signatureHex = bytesToHex(sigBytes);

  if (expectedPublicKeyHex && vkeyHex !== expectedPublicKeyHex.toLowerCase()) {
    throw new Error(
      `GivemeMyProvider: response vkey ${vkeyHex} does not match pinned public key ` +
        `${expectedPublicKeyHex.toLowerCase()}. Refusing to use a key the host hasn't ` +
        `published — bump known-collateral-hosts.ts after independently verifying the rotation.`,
    );
  }

  return { vkeyHex, signatureHex };
}

/**
 * Decide the final URL we POST to.
 *
 *   * No override → the host's pinned full URL.
 *   * Override containing "/collateral" anywhere in the path → use as-is
 *     (we trust the caller knows the full URL); trailing slash normalised.
 *   * Override that's only a base URL → append `/{network}/collateral/`.
 *   * Empty / whitespace override → treated as no override.
 *
 * The whole reason this is messier than a `??` fallback is that the
 * upstream service expects exactly `/{network}/collateral/` — a base-URL
 * POST hits the homepage and gets HTML back, which is the failure mode
 * that motivated this helper.
 */
function resolveEndpoint(
  override: string | undefined,
  pinnedUrl: string,
  network: CollateralNetwork,
): string {
  const trimmed = (override ?? "").trim();
  if (!trimmed) return pinnedUrl.replace(/\/+$/, "/");
  if (/\/collateral\/?$/i.test(trimmed)) {
    // Already a full path — just normalise the trailing slash.
    return trimmed.replace(/\/+$/, "") + "/";
  }
  // Treat as base URL; append `/{network}/collateral/`.
  return trimmed.replace(/\/+$/, "") + `/${network}/collateral/`;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (cleaned.length % 2 !== 0) {
    throw new Error("hex string must have even length");
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(v)) throw new Error(`bad hex byte at offset ${i * 2}`);
    out[i] = v;
  }
  return out;
}
