// Koios-backed implementation of `ChainProvider`.
//
// Koios is a public Cardano API (db-sync plus an Ogmios passthrough) that
// needs no project id, so the SDK can run against Preprod or mainnet without
// a Blockfrost key or a self-hosted backend. The token-pool Preprod test uses
// it; any SDK consumer can too.
//
// Why hand-rolled vs mesh's `KoiosProvider`: mesh 1.8's `fetchUTxOs` stamps
// every output's address as the string "undefined", it has no evaluator, and
// its protocol parameters drop Conway's `minFeeRefScriptCostPerByte`. The
// mesh sibling below fixes all three and routes evaluation through Koios'
// `POST /ogmios` JSON-RPC passthrough (Ogmios v6 `evaluateTransaction`).
//
// Endpoint mapping:
//   getUtxos / fetchAddressUTxOs   → POST /address_utxos (paged, 1000 per page)
//   getUtxoByRef                   → POST /utxo_info
//   getReferenceUtxo               → POST /asset_utxos
//   awaitConfirmation              → POST /tx_status
//   getProtocolParameters          → GET  /cli_protocol_params
//   fetchUTxOs (mesh)              → POST /tx_info (all outputs of one tx)
//   fetchProtocolParameters (mesh) → POST /ogmios queryLedgerState/protocolParameters
//   evaluateTx[WithAdditionalUtxos]→ POST /ogmios evaluateTransaction
//   submitTx                       → POST /submittx (raw CBOR bytes)

import type {
  AssetMap,
  ChainProvider,
  Hex28,
  Hex32,
  NetworkProtocolParameters,
  Utxo,
  UtxoRef,
} from "./provider.js";
import type {
  FetchFn,
  MeshAction,
  MeshFetcherSubmitter,
  MeshProtocolParameters,
} from "./blockfrost.js";
import { type OgmiosV6Params, ogmiosV6ToMeshProtocol, PURPOSE_TO_TAG } from "./backend-mesh.js";
import type { AdditionalUtxo } from "./ogmios-utxo.js";

export interface KoiosConfig {
  /** Base URL, e.g. `https://preprod.koios.rest/api/v1`. See {@link koiosBaseUrl}. */
  baseUrl: string;
  /** Optional Koios bearer token (higher rate limits). Requests are anonymous without one. */
  bearerToken?: string;
  /** `fetch` implementation. Defaults to global `fetch`; tests inject a mock. */
  fetchFn?: FetchFn;
  /** Polling interval for awaitConfirmation, in ms. Default 5000. */
  pollIntervalMs?: number;
  /**
   * Koios load-balances across instances, so the Ogmios node that evaluates
   * a tx can lag the db-sync instance that just reported its parent as
   * confirmed. An evaluation that names unknown inputs is retried this many
   * times, `evaluateRetryDelayMs` apart. Default 6 retries, 5000 ms.
   */
  evaluateRetries?: number;
  evaluateRetryDelayMs?: number;
}

/** The public Koios endpoint for a network. */
export function koiosBaseUrl(network: "mainnet" | "preprod" | "preview"): string {
  return network === "mainnet"
    ? "https://api.koios.rest/api/v1"
    : `https://${network}.koios.rest/api/v1`;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_EVALUATE_RETRIES = 6;
const DEFAULT_EVALUATE_RETRY_DELAY_MS = 5_000;
/** Koios caps every response at 1000 rows. */
const PAGE_SIZE = 1_000;

/** One UTxO as Koios returns it from `address_utxos`, `utxo_info`, and `asset_utxos` (`_extended`). */
interface KoiosUtxoRow {
  tx_hash: string;
  tx_index: number;
  address: string;
  value: string;
  datum_hash: string | null;
  inline_datum: { bytes: string } | null;
  asset_list: Array<{ policy_id: string; asset_name: string | null; quantity: string }> | null;
  reference_script: { hash: string; type: string; bytes: string | null } | null;
  is_spent?: boolean;
}

/** A `tx_info` output: the same fields, but the address sits under `payment_addr`. */
type KoiosTxOutput = Omit<KoiosUtxoRow, "address"> & { payment_addr: { bech32: string } };

interface MeshUtxo {
  input: { outputIndex: number; txHash: string };
  output: {
    address: string;
    amount: { unit: string; quantity: string }[];
    dataHash?: string;
    plutusData?: string;
    scriptRef?: string;
    scriptHash?: string;
  };
}

export class KoiosProvider implements ChainProvider {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: FetchFn;
  private readonly pollIntervalMs: number;
  private readonly evaluateRetries: number;
  private readonly evaluateRetryDelayMs: number;
  private _mesh: KoiosMeshProvider | null = null;

  constructor(config: KoiosConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.headers = {
      Accept: "application/json",
      ...(config.bearerToken ? { Authorization: `Bearer ${config.bearerToken}` } : {}),
    };
    const injected = config.fetchFn;
    const globalFetch = (globalThis as { fetch?: FetchFn }).fetch;
    if (!injected && !globalFetch) {
      throw new Error(
        "KoiosProvider: no fetch implementation available. Pass `fetchFn` explicitly.",
      );
    }
    // Bind the global fetch to its owner; see BlockfrostProvider's constructor.
    this.fetchFn = injected ?? (globalFetch!.bind(globalThis) as FetchFn);
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.evaluateRetries = config.evaluateRetries ?? DEFAULT_EVALUATE_RETRIES;
    this.evaluateRetryDelayMs = config.evaluateRetryDelayMs ?? DEFAULT_EVALUATE_RETRY_DELAY_MS;
  }

  /** Mesh-shaped fetcher + submitter + evaluator for `MeshTxBuilder`. */
  async meshProvider(): Promise<MeshFetcherSubmitter> {
    this._mesh ??= new KoiosMeshProvider(this);
    return this._mesh;
  }

  async submitTx(signedTxCborHex: string): Promise<Hex32> {
    const res = await this.fetchFn(`${this.baseUrl}/submittx`, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/cbor" },
      body: hexToBytes(signedTxCborHex),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`KoiosProvider.submitTx failed (${res.status} ${res.statusText}): ${text}`);
    }
    // Koios answers 202 with the txid as a JSON-quoted string.
    const txId = text.trim().replace(/^"|"$/g, "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txId)) {
      throw new Error(`KoiosProvider.submitTx: expected a txid, got ${text.slice(0, 200)}`);
    }
    return txId;
  }

  async getUtxos(address: string): Promise<Utxo[]> {
    const rows = await this.postPaged<KoiosUtxoRow>("/address_utxos", {
      _addresses: [address],
      _extended: true,
    });
    return rows.map(koiosRowToUtxo);
  }

  async getUtxoByRef(ref: UtxoRef): Promise<Utxo | null> {
    const key = `${ref.txId}#${ref.outputIndex}`;
    const rows = expectArray(
      await this.post("/utxo_info", { _utxo_refs: [key], _extended: true }),
      "utxo_info",
    ) as KoiosUtxoRow[];
    const row = rows.find((r) => `${r.tx_hash}#${r.tx_index}` === key);
    return row ? koiosRowToUtxo(row) : null;
  }

  async awaitConfirmation(txId: Hex32, timeoutMs = 120_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const rows = expectArray(
        await this.post("/tx_status", { _tx_hashes: [txId] }),
        "tx_status",
      ) as Array<{ tx_hash: string; num_confirmations: number | null }>;
      if (rows.some((r) => r.tx_hash === txId && (r.num_confirmations ?? 0) >= 1)) return;
      await sleep(this.pollIntervalMs);
    }
    throw new Error(`KoiosProvider.awaitConfirmation: tx ${txId} not seen after ${timeoutMs}ms`);
  }

  async getReferenceUtxo(nftPolicy: Hex28, nftAssetNameHex: string): Promise<Utxo> {
    const asset = `${nftPolicy}${nftAssetNameHex}`;
    const rows = await this.postPaged<KoiosUtxoRow>("/asset_utxos", {
      _asset_list: [[nftPolicy, nftAssetNameHex]],
      _extended: true,
    });
    const carriers = rows
      .filter((r) => r.is_spent !== true)
      .map(koiosRowToUtxo)
      .filter((u) => u.assets[asset] === 1n);
    if (carriers.length !== 1) {
      throw new Error(
        `KoiosProvider.getReferenceUtxo: NFT ${asset} present in ${carriers.length} UTxOs (expected 1)`,
      );
    }
    return carriers[0]!;
  }

  async getProtocolParameters(): Promise<NetworkProtocolParameters> {
    const p = expectObject(await this.get("/cli_protocol_params"), "cli_protocol_params");
    const exUnits = expectObject(p.maxTxExecutionUnits, "maxTxExecutionUnits");
    const prices = expectObject(p.executionUnitPrices, "executionUnitPrices");
    const costModels: Record<string, number[]> = {};
    for (const [version, model] of Object.entries(expectObject(p.costModels, "costModels"))) {
      if (Array.isArray(model)) costModels[version] = model as number[];
    }
    return {
      minFeeA: Number(p.txFeePerByte),
      minFeeB: Number(p.txFeeFixed),
      maxTxSize: Number(p.maxTxSize),
      utxoCostPerByte: BigInt(p.utxoCostPerByte as number),
      maxTxExSteps: BigInt(exUnits.steps as number),
      maxTxExMem: BigInt(exUnits.memory as number),
      pricesStep: Number(prices.priceSteps),
      pricesMem: Number(prices.priceMemory),
      costModels,
      network: networkFromBaseUrl(this.baseUrl),
      slotLength: 1_000,
    };
  }

  // ---------------------------------------------------------------------------
  // Shared with the mesh sibling
  // ---------------------------------------------------------------------------

  /** Every output of a confirmed tx, in mesh's shape. */
  async txOutputs(txHash: string): Promise<MeshUtxo[]> {
    const rows = expectArray(
      await this.post("/tx_info", {
        _tx_hashes: [txHash],
        _inputs: false,
        _metadata: false,
        // Required: without it Koios returns every output's asset_list empty,
        // and mesh would rebuild token inputs as ADA-only.
        _assets: true,
        _withdrawals: false,
        _certs: false,
        _scripts: true,
        _bytecode: true,
        _governance: false,
      }),
      "tx_info",
    ) as Array<{ tx_hash: string; outputs: KoiosTxOutput[] }>;
    const tx = rows.find((r) => r.tx_hash === txHash);
    if (!tx) return [];
    return tx.outputs.map((o) => koiosRowToMesh({ ...o, address: o.payment_addr.bech32 }));
  }

  /** Ogmios v6 protocol parameters through the Koios passthrough. */
  async ogmiosProtocolParameters(): Promise<OgmiosV6Params> {
    const body = await this.ogmios({
      jsonrpc: "2.0",
      method: "queryLedgerState/protocolParameters",
    });
    if (!body.result) {
      throw new Error(
        `KoiosProvider: Ogmios protocolParameters failed: ${JSON.stringify(body.error ?? body)}`,
      );
    }
    return body.result as OgmiosV6Params;
  }

  /**
   * Ogmios v6 `evaluateTransaction`. Throws with Ogmios' reason (including
   * the per-validator failure data) when a script fails, so callers see why.
   */
  async evaluate(
    cborHex: string,
    additionalUtxos?: ReadonlyArray<AdditionalUtxo>,
  ): Promise<MeshAction[]> {
    const request = {
      jsonrpc: "2.0",
      method: "evaluateTransaction",
      params: {
        transaction: { cbor: cborHex },
        ...(additionalUtxos && additionalUtxos.length > 0
          ? { additionalUtxo: additionalUtxos }
          : {}),
      },
    };
    for (let attempt = 0; ; attempt++) {
      const body = await this.ogmios(request);
      if (Array.isArray(body.result)) {
        return (
          body.result as Array<{
            validator: { purpose: string; index: number };
            budget: { memory: number; cpu: number };
          }>
        ).map((r) => ({
          tag: PURPOSE_TO_TAG[r.validator.purpose] ?? r.validator.purpose,
          index: r.validator.index,
          budget: { mem: r.budget.memory, steps: r.budget.cpu },
        }));
      }
      const reason = body.error
        ? `${body.error.message} (code ${body.error.code})\n${JSON.stringify(body.error.data, null, 2)}`
        : JSON.stringify(body).slice(0, 500);
      if (
        attempt < this.evaluateRetries &&
        /unknown.{0,24}(input|output ?ref|utxo)/i.test(reason)
      ) {
        await sleep(this.evaluateRetryDelayMs);
        continue;
      }
      throw new Error(`Koios Ogmios evaluateTransaction rejected the tx: ${reason}`);
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------

  /**
   * Ogmios JSON-RPC through Koios. Errors can arrive as HTTP 200 with an
   * `error` member or as HTTP 4xx with the same body, so both are returned
   * to the caller as a parsed body.
   */
  private async ogmios(request: unknown): Promise<{
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  }> {
    const res = await this.fetchFn(`${this.baseUrl}/ogmios`, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: stringifyWithBigints(request),
    });
    const text = await res.text();
    try {
      return JSON.parse(text) as { result?: unknown; error?: { code: number; message: string } };
    } catch {
      throw new Error(
        `KoiosProvider /ogmios (${res.status} ${res.statusText}): ${text.slice(0, 500)}`,
      );
    }
  }

  private async get(path: string): Promise<unknown> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: this.headers,
    });
    if (!res.ok) {
      throw new Error(
        `KoiosProvider GET ${path} failed (${res.status} ${res.statusText}): ${await res.text()}`,
      );
    }
    return res.json();
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(
        `KoiosProvider POST ${path} failed (${res.status} ${res.statusText}): ${await res.text()}`,
      );
    }
    return res.json();
  }

  /** POST a UTxO-returning endpoint and walk every page in a stable order. */
  private async postPaged<T>(path: string, body: unknown): Promise<T[]> {
    const out: T[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = expectArray(
        await this.post(
          `${path}?offset=${offset}&limit=${PAGE_SIZE}&order=tx_hash.asc,tx_index.asc`,
          body,
        ),
        path,
      ) as T[];
      out.push(...page);
      if (page.length < PAGE_SIZE) return out;
    }
  }
}

/** Mesh-shaped view of a {@link KoiosProvider}. Every call goes through the parent. */
class KoiosMeshProvider implements MeshFetcherSubmitter {
  constructor(private readonly koios: KoiosProvider) {}

  async fetchUTxOs(hash: string, index?: number): Promise<MeshUtxo[]> {
    const outputs = await this.koios.txOutputs(hash);
    return index === undefined ? outputs : outputs.filter((u) => u.input.outputIndex === index);
  }

  async fetchAddressUTxOs(address: string, asset?: string): Promise<MeshUtxo[]> {
    const utxos = (await this.koios.getUtxos(address)).map(utxoToMesh);
    return asset === undefined
      ? utxos
      : utxos.filter((u) => u.output.amount.some((a) => a.unit === asset));
  }

  async fetchProtocolParameters(_epoch?: number): Promise<MeshProtocolParameters> {
    return ogmiosV6ToMeshProtocol(await this.koios.ogmiosProtocolParameters());
  }

  async submitTx(tx: string): Promise<string> {
    return this.koios.submitTx(tx);
  }

  async evaluateTx(cbor: string): Promise<MeshAction[]> {
    return this.koios.evaluate(cbor);
  }

  async evaluateTxWithAdditionalUtxos(
    cbor: string,
    additionalUtxos: ReadonlyArray<AdditionalUtxo>,
  ): Promise<MeshAction[]> {
    return this.koios.evaluate(cbor, additionalUtxos);
  }
}

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

function koiosRowToUtxo(row: KoiosUtxoRow): Utxo {
  const assets: AssetMap = {};
  for (const a of row.asset_list ?? []) {
    const unit = `${a.policy_id}${a.asset_name ?? ""}`;
    assets[unit] = (assets[unit] ?? 0n) + BigInt(a.quantity);
  }
  return {
    ref: { txId: row.tx_hash, outputIndex: Number(row.tx_index) },
    address: row.address,
    lovelace: BigInt(row.value),
    assets,
    inlineDatum: row.inline_datum?.bytes ?? null,
    referenceScript: row.reference_script?.bytes ? koiosScriptRefCbor(row.reference_script) : null,
  };
}

function koiosRowToMesh(row: KoiosUtxoRow): MeshUtxo {
  const out = utxoToMesh(koiosRowToUtxo(row));
  if (row.datum_hash) out.output.dataHash = row.datum_hash;
  if (row.reference_script?.hash) out.output.scriptHash = row.reference_script.hash;
  return out;
}

function utxoToMesh(u: Utxo): MeshUtxo {
  const amount = [{ unit: "lovelace", quantity: u.lovelace.toString() }];
  for (const [unit, quantity] of Object.entries(u.assets)) {
    amount.push({ unit, quantity: quantity.toString() });
  }
  const out: MeshUtxo = {
    input: { txHash: u.ref.txId, outputIndex: u.ref.outputIndex },
    output: { address: u.address, amount },
  };
  if (u.inlineDatum) out.output.plutusData = u.inlineDatum;
  if (u.referenceScript) out.output.scriptRef = u.referenceScript;
  return out;
}

const PLUTUS_LANGUAGE_TAG: Record<string, number> = { plutusV1: 1, plutusV2: 2, plutusV3: 3 };

/**
 * Rebuild the `UTxO.output.scriptRef` mesh expects from Koios'
 * `reference_script`: the CBOR `[language, script]` array, without the
 * ledger's tag-24 wrapper (what mesh's own `toScriptRef(...).toCbor()`
 * yields; mesh sizes reference scripts from its length). For a Plutus script
 * Koios' `bytes` are the script bytes the ledger hashes (the CBOR-wrapped
 * flat program); for a native script they are its CBOR.
 */
export function koiosScriptRefCbor(script: { type: string; bytes: string | null }): string {
  if (!script.bytes) throw new Error(`koiosScriptRefCbor: ${script.type} script has no bytes`);
  const language = PLUTUS_LANGUAGE_TAG[script.type];
  if (language !== undefined) {
    return `820${language}${cborBytesHeader(script.bytes.length / 2)}${script.bytes}`;
  }
  if (script.type === "timelock" || script.type === "multisig") return `8200${script.bytes}`;
  throw new Error(`koiosScriptRefCbor: unknown script type ${script.type}`);
}

function cborBytesHeader(length: number): string {
  if (length < 24) return (0x40 + length).toString(16).padStart(2, "0");
  if (length < 0x100) return `58${length.toString(16).padStart(2, "0")}`;
  if (length < 0x10000) return `59${length.toString(16).padStart(4, "0")}`;
  return `5a${length.toString(16).padStart(8, "0")}`;
}

/**
 * JSON with bigints written as exact integer literals. Ogmios parses JSON
 * numbers at arbitrary precision, so token quantities above 2^53 in an
 * `additionalUtxo` value reach it intact (the Blockfrost path has to refuse
 * them because its replacer converts to `number`).
 */
export function stringifyWithBigints(value: unknown): string {
  const marker = "__lovejoin_bigint__";
  return JSON.stringify(value, (_k, v: unknown) =>
    typeof v === "bigint" ? `${marker}${v.toString()}` : v,
  ).replace(new RegExp(`"${marker}(-?\\d+)"`, "g"), "$1");
}

function expectObject(x: unknown, ctx: string): Record<string, unknown> {
  if (x === null || typeof x !== "object" || Array.isArray(x)) {
    throw new Error(`KoiosProvider: expected object for ${ctx}, got ${typeof x}`);
  }
  return x as Record<string, unknown>;
}

function expectArray(x: unknown, ctx: string): unknown[] {
  if (!Array.isArray(x)) {
    throw new Error(
      `KoiosProvider: expected array for ${ctx}, got ${JSON.stringify(x)?.slice(0, 200)}`,
    );
  }
  return x;
}

function networkFromBaseUrl(baseUrl: string): string {
  if (baseUrl.includes("preprod")) return "preprod";
  if (baseUrl.includes("preview")) return "preview";
  if (baseUrl.includes("api.koios.rest")) return "mainnet";
  return "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("KoiosProvider: tx CBOR must be even-length hex");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
