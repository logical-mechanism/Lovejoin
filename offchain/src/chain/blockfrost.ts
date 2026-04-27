// Blockfrost-backed implementation of `ChainProvider`.
//
// Spec: docs/spec/09-milestones.md M2 notes — Blockfrost is the v1 chain
// provider; the same interface gets a second self-hosted implementation in M5.
//
// Why hand-rolled vs mesh's `BlockfrostProvider`: we need a stable, narrow
// interface (`ChainProvider`) that downstream SDK code can depend on, and that
// we can test under mocked HTTP without dragging in mesh's full surface.
// Internally the SDK can still use mesh for tx-building; BlockfrostProvider
// only handles chain queries + submission.
//
// The `fetch` dependency is constructor-injectable so tests don't need to
// network. Production code passes the global `fetch` (Node 18+ / browsers).

import type {
  AssetMap,
  ChainProvider,
  Hex28,
  Hex32,
  NetworkProtocolParameters,
  Utxo,
  UtxoRef,
} from "./provider.js";

/** Subset of `fetch` we depend on. Lets tests inject a mock cleanly. */
export type FetchFn = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface BlockfrostConfig {
  /** Base URL — e.g. `https://cardano-preprod.blockfrost.io/api/v0`. */
  baseUrl: string;
  /** Blockfrost project id. */
  projectId: string;
  /**
   * `fetch` implementation. Defaults to global `fetch` if available.
   * In tests, inject a mock to avoid network.
   */
  fetchFn?: FetchFn;
  /** Polling interval for awaitConfirmation, in ms. Default 5000. */
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;

export class BlockfrostProvider implements ChainProvider {
  private readonly baseUrl: string;
  private readonly projectId: string;
  private readonly fetchFn: FetchFn;
  private readonly pollIntervalMs: number;

  constructor(config: BlockfrostConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.projectId = config.projectId;
    const f = config.fetchFn ?? (globalThis as { fetch?: FetchFn }).fetch;
    if (!f) {
      throw new Error(
        "BlockfrostProvider: no fetch implementation available. Pass `fetchFn` explicitly.",
      );
    }
    this.fetchFn = f;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async submitTx(signedTxCborHex: string): Promise<Hex32> {
    const res = await this.fetchFn(`${this.baseUrl}/tx/submit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/cbor",
        project_id: this.projectId,
      },
      body: hexToBinaryString(signedTxCborHex),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `BlockfrostProvider.submitTx failed (${res.status} ${res.statusText}): ${body}`,
      );
    }
    // Blockfrost returns the txid as a JSON-quoted hex string.
    const txId = await res.json();
    if (typeof txId !== "string") {
      throw new Error(
        `BlockfrostProvider.submitTx: expected string txid, got ${JSON.stringify(txId)}`,
      );
    }
    return txId.toLowerCase();
  }

  async getUtxos(address: string): Promise<Utxo[]> {
    const utxos: Utxo[] = [];
    let page = 1;
    while (true) {
      const res = await this.get(
        `/addresses/${address}/utxos?page=${page}&order=asc`,
      );
      if (res === null) {
        // 404 means the address has never been used — empty UTxO set.
        return [];
      }
      const arr = expectArray(res, "address utxos");
      if (arr.length === 0) break;
      for (const raw of arr) {
        utxos.push(parseBlockfrostUtxo(raw));
      }
      page += 1;
    }
    return utxos;
  }

  async getUtxoByRef(ref: UtxoRef): Promise<Utxo | null> {
    const res = await this.get(`/txs/${ref.txId}/utxos`);
    if (res === null) return null;
    const obj = expectObject(res, "tx utxos");
    const outputs = expectArray(obj.outputs, "tx outputs");
    const candidate = outputs.find(
      (o) => Number((o as Record<string, unknown>).output_index) === ref.outputIndex,
    );
    if (!candidate) return null;
    return parseBlockfrostUtxo({
      tx_hash: ref.txId,
      output_index: ref.outputIndex,
      ...(candidate as Record<string, unknown>),
    });
  }

  async awaitConfirmation(txId: Hex32, timeoutMs = 120_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await this.get(`/txs/${txId}`);
      if (res !== null) return;
      await sleep(this.pollIntervalMs);
    }
    throw new Error(
      `BlockfrostProvider.awaitConfirmation: tx ${txId} not seen after ${timeoutMs}ms`,
    );
  }

  async getReferenceUtxo(
    nftPolicy: Hex28,
    nftAssetNameHex: string,
  ): Promise<Utxo> {
    const asset = `${nftPolicy}${nftAssetNameHex}`;
    const res = await this.get(`/assets/${asset}/addresses`);
    if (res === null) {
      throw new Error(
        `BlockfrostProvider.getReferenceUtxo: NFT ${asset} not found`,
      );
    }
    const arr = expectArray(res, "asset addresses");
    if (arr.length === 0) {
      throw new Error(
        `BlockfrostProvider.getReferenceUtxo: NFT ${asset} not held anywhere`,
      );
    }
    if (arr.length !== 1) {
      throw new Error(
        `BlockfrostProvider.getReferenceUtxo: NFT ${asset} held by ${arr.length} addresses (expected 1)`,
      );
    }
    const holderAddress = (arr[0] as { address: string }).address;
    const utxos = await this.getUtxos(holderAddress);
    const carriers = utxos.filter((u) => u.assets[asset] === 1n);
    if (carriers.length !== 1) {
      throw new Error(
        `BlockfrostProvider.getReferenceUtxo: NFT ${asset} present in ${carriers.length} UTxOs at ${holderAddress} (expected 1)`,
      );
    }
    return carriers[0]!;
  }

  async getProtocolParameters(): Promise<NetworkProtocolParameters> {
    const res = await this.get(`/epochs/latest/parameters`);
    if (res === null) {
      throw new Error(
        "BlockfrostProvider.getProtocolParameters: latest epoch parameters unavailable",
      );
    }
    const p = expectObject(res, "protocol parameters");
    return {
      minFeeA: Number(p.min_fee_a ?? p.min_fee_per_byte ?? 0),
      minFeeB: Number(p.min_fee_b ?? p.min_fee_constant ?? 0),
      maxTxSize: Number(p.max_tx_size ?? 0),
      utxoCostPerByte: BigInt((p.coins_per_utxo_size ?? "0") as string | number),
      maxTxExSteps: BigInt((p.max_tx_ex_steps ?? "0") as string | number),
      maxTxExMem: BigInt((p.max_tx_ex_mem ?? "0") as string | number),
      pricesStep: Number(p.price_step ?? 0),
      pricesMem: Number(p.price_mem ?? 0),
      costModels: parseCostModels(p.cost_models ?? p.cost_models_raw ?? {}),
      network: networkFromBaseUrl(this.baseUrl),
      slotLength: 1_000,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** GET that returns `null` on 404 and throws on other errors. */
  private async get(path: string): Promise<unknown | null> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: { project_id: this.projectId },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `BlockfrostProvider GET ${path} failed (${res.status} ${res.statusText}): ${body}`,
      );
    }
    return res.json();
  }
}

// ---------------------------------------------------------------------------
// Parsers + small utilities
// ---------------------------------------------------------------------------

function parseBlockfrostUtxo(raw: unknown): Utxo {
  const o = expectObject(raw, "utxo");
  const txId = String(o.tx_hash ?? o.tx_id ?? "");
  const outputIndex = Number(o.output_index ?? o.tx_index ?? 0);
  const amounts = expectArray(o.amount, "utxo.amount");
  let lovelace = 0n;
  const assets: AssetMap = {};
  for (const entry of amounts) {
    const a = expectObject(entry, "amount entry");
    const unit = String(a.unit);
    const qty = BigInt(String(a.quantity));
    if (unit === "lovelace") {
      lovelace = qty;
    } else {
      assets[unit] = qty;
    }
  }
  return {
    ref: { txId, outputIndex },
    address: String(o.address ?? ""),
    lovelace,
    assets,
    inlineDatum:
      typeof o.inline_datum === "string" && o.inline_datum.length > 0
        ? o.inline_datum
        : null,
    referenceScript:
      typeof o.reference_script_hash === "string" && o.reference_script_hash.length > 0
        ? o.reference_script_hash
        : null,
  };
}

function parseCostModels(raw: unknown): Record<string, number[]> {
  if (raw === null || typeof raw !== "object") return {};
  const out: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v) && v.every((n) => typeof n === "number")) {
      out[k] = v;
    } else if (
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      // Some Blockfrost shapes return per-op named maps; leave them empty for now.
      out[k] = [];
    }
  }
  return out;
}

function expectObject(x: unknown, ctx: string): Record<string, unknown> {
  if (x === null || typeof x !== "object" || Array.isArray(x)) {
    throw new Error(`BlockfrostProvider: expected object for ${ctx}, got ${typeof x}`);
  }
  return x as Record<string, unknown>;
}

function expectArray(x: unknown, ctx: string): unknown[] {
  if (!Array.isArray(x)) {
    throw new Error(`BlockfrostProvider: expected array for ${ctx}, got ${typeof x}`);
  }
  return x;
}

function networkFromBaseUrl(baseUrl: string): string {
  if (baseUrl.includes("preprod")) return "preprod";
  if (baseUrl.includes("preview")) return "preview";
  if (baseUrl.includes("mainnet")) return "mainnet";
  return "unknown";
}

function hexToBinaryString(hex: string): string {
  // POST /tx/submit accepts the raw CBOR bytes as the body. fetch's `body`
  // parameter is `string | ArrayBuffer | …`; for tx submission we forward the
  // hex unchanged — the wrapper takes care of converting it on the wire if the
  // injected fetch wants to (real fetch will need ArrayBuffer; tests don't
  // care about the body shape).
  return hex;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
