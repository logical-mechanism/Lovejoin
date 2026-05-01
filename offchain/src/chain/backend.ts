// BackendChainProvider — ChainProvider implementation that talks to the
// self-hosted lovejoin backend (db-sync + ogmios) instead of Blockfrost.
//
// Architecture per /home/logic/Documents/LogicalMechanism/lovejoin/CLAUDE.md
// "ChainProvider abstraction" — same surface as BlockfrostProvider; UI and
// SDK swap implementations with no other code changes. Mesh integration
// is layered on top (offchain/src/tx/mesh-bridge.ts) and is unchanged
// here; mesh sees a `ChainProvider` instance and reuses whichever one is
// configured.
//
// Endpoint mapping:
//   submitTx                → POST /submit
//   getUtxos                → GET  /utxos/:address
//   getUtxoByRef            → GET  /tx/:hash/utxos        (filter by index)
//   awaitConfirmation       → poll GET /tx/:hash
//   getReferenceUtxo        → GET  /params + GET /tx/:hash/utxos
//   getProtocolParameters   → GET  /protocol-params       (ogmios v6 shape)
//
// Optional fallback: passing a `fallback` ChainProvider (typically
// BlockfrostProvider) makes any method that throws or 5xxs from the
// backend fall through to the fallback. This is the "Blockfrost is the
// safety net" deployment posture — your own stack handles the request,
// Blockfrost catches the rare backend hiccup.

import {
  type ChainProvider,
  type Hex28,
  type Hex32,
  type NetworkProtocolParameters,
  type Utxo,
  type UtxoRef,
} from "./provider.js";
import { BackendMeshProvider } from "./backend-mesh.js";
import type { MeshFetcherSubmitter } from "./blockfrost.js";

/** Subset of `fetch` we depend on. Tests inject a fake. */
export type FetchFn = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface BackendChainProviderConfig {
  /** Base URL of the lovejoin backend, e.g. `http://localhost:3001`. */
  baseUrl: string;
  /**
   * Optional fallback provider. Each method tries the backend first; on
   * any thrown error (network, 5xx, parse failure) it logs and tries
   * the fallback. Pass `BlockfrostProvider` here for the recommended
   * "self-hosted primary, Blockfrost safety net" deployment.
   */
  fallback?: ChainProvider | null;
  fetchFn?: FetchFn;
  /** Polling interval for `awaitConfirmation`, default 5000ms. */
  pollIntervalMs?: number;
}

interface UtxoWire {
  txHash: string;
  outputIndex: number;
  address: string;
  lovelace: string;
  assets: Record<string, string>;
  inlineDatum: string | null;
  datumHash: string | null;
  referenceScriptCbor: string | null;
  referenceScriptHash: string | null;
}

interface ParamsResponse {
  network: string;
  referenceUtxo: { txHash: string; outputIndex: number };
}

/**
 * Lightweight subset of ogmios v6's `protocolParameters` result. We only
 * pull fields the SDK's `NetworkProtocolParameters` actually consumes —
 * other fields pass through ignored. Field names are ogmios's; the
 * translator below maps them to mesh / Blockfrost-friendly names.
 */
interface OgmiosV6Params {
  minFeeCoefficient?: number;
  minFeeConstant?: { ada?: { lovelace?: number | string } };
  maxTransactionSize?: { bytes?: number };
  minUtxoDepositCoefficient?: number | string;
  maxExecutionUnitsPerTransaction?: { memory?: number; cpu?: number };
  scriptExecutionPrices?: { memory?: string; cpu?: string };
  plutusCostModels?: Record<string, number[]>;
  network?: string;
  slotLength?: { milliseconds?: number };
}

export class BackendChainProvider implements ChainProvider {
  private readonly baseUrl: string;
  private readonly fallback: ChainProvider | null;
  private readonly fetchFn: FetchFn;
  private readonly pollIntervalMs: number;

  constructor(config: BackendChainProviderConfig) {
    if (!/^https?:\/\//.test(config.baseUrl)) {
      throw new Error(
        `BackendChainProvider: baseUrl must include scheme, got ${config.baseUrl}`,
      );
    }
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.fallback = config.fallback ?? null;
    const injected = config.fetchFn;
    const globalFetch = (globalThis as { fetch?: FetchFn }).fetch;
    if (!injected && !globalFetch) {
      throw new Error(
        "BackendChainProvider: no fetch implementation. Pass fetchFn explicitly.",
      );
    }
    this.fetchFn = injected ?? (globalFetch!.bind(globalThis) as FetchFn);
    this.pollIntervalMs = config.pollIntervalMs ?? 5000;
  }

  async submitTx(signedTxCborHex: string): Promise<Hex32> {
    return this.tryWithFallback(
      "submitTx",
      async () => {
        const res = await this.fetchFn(`${this.baseUrl}/submit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cbor: signedTxCborHex }),
        });
        const body = await readJson(res);
        if (!res.ok) {
          throw new Error(
            `BackendChainProvider.submitTx (${res.status}): ${
              (body as { message?: string })?.message ?? res.statusText
            }`,
          );
        }
        const txHash = (body as { txHash?: string }).txHash;
        if (typeof txHash !== "string" || !/^[0-9a-f]{64}$/i.test(txHash)) {
          throw new Error(
            `BackendChainProvider.submitTx: malformed response ${JSON.stringify(body)}`,
          );
        }
        return txHash.toLowerCase();
      },
      (fallback) => fallback.submitTx(signedTxCborHex),
    );
  }

  async getUtxos(address: string): Promise<Utxo[]> {
    return this.tryWithFallback(
      "getUtxos",
      async () => {
        const res = await this.fetchFn(`${this.baseUrl}/utxos/${address}`, {});
        const body = await readJson(res);
        if (!res.ok) {
          throw new Error(
            `BackendChainProvider.getUtxos (${res.status}): ${
              (body as { message?: string })?.message ?? res.statusText
            }`,
          );
        }
        const utxos = (body as { utxos?: UtxoWire[] }).utxos;
        if (!Array.isArray(utxos)) {
          throw new Error(
            `BackendChainProvider.getUtxos: malformed response (no utxos array)`,
          );
        }
        return utxos.map(wireToUtxo);
      },
      (fallback) => fallback.getUtxos(address),
    );
  }

  async getUtxoByRef(ref: UtxoRef): Promise<Utxo | null> {
    return this.tryWithFallback(
      "getUtxoByRef",
      async () => {
        const res = await this.fetchFn(
          `${this.baseUrl}/tx/${ref.txId}/utxos`,
          {},
        );
        if (res.status === 404) return null;
        const body = await readJson(res);
        if (!res.ok) {
          throw new Error(
            `BackendChainProvider.getUtxoByRef (${res.status}): ${
              (body as { message?: string })?.message ?? res.statusText
            }`,
          );
        }
        const utxos = (body as { utxos?: UtxoWire[] }).utxos;
        if (!Array.isArray(utxos)) return null;
        const found = utxos.find((u) => u.outputIndex === ref.outputIndex);
        return found ? wireToUtxo(found) : null;
      },
      (fallback) => fallback.getUtxoByRef(ref),
    );
  }

  async awaitConfirmation(txId: Hex32, timeoutMs = 120_000): Promise<void> {
    // No try-fallback wrap: confirmation is a polling loop, and if the
    // backend is briefly unreachable mid-poll the fallback would race.
    // We keep the poll cheap and just retry against the backend.
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await this.fetchFn(`${this.baseUrl}/tx/${txId}`, {});
        if (res.ok) return;
        if (res.status !== 404 && this.fallback) {
          // Backend is sick (5xx). Hand off the rest of the wait to the
          // fallback, which has its own timeout budget.
          return this.fallback.awaitConfirmation(txId, timeoutMs);
        }
      } catch (e) {
        if (this.fallback) {
          return this.fallback.awaitConfirmation(txId, timeoutMs);
        }
        // No fallback — surface the network error so the caller can decide.
        throw e;
      }
      await sleep(this.pollIntervalMs);
    }
    throw new Error(
      `BackendChainProvider.awaitConfirmation: tx ${txId} not seen after ${timeoutMs}ms`,
    );
  }

  async getReferenceUtxo(
    nftPolicy: Hex28,
    nftAssetNameHex: string,
  ): Promise<Utxo> {
    return this.tryWithFallback(
      "getReferenceUtxo",
      async () => {
        const paramsRes = await this.fetchFn(`${this.baseUrl}/params`, {});
        const paramsBody = await readJson(paramsRes);
        if (!paramsRes.ok) {
          throw new Error(
            `BackendChainProvider.getReferenceUtxo (/params ${paramsRes.status}): ${
              (paramsBody as { message?: string })?.message ?? paramsRes.statusText
            }`,
          );
        }
        const params = paramsBody as ParamsResponse;
        const ref = params?.referenceUtxo;
        if (!ref || typeof ref.txHash !== "string") {
          throw new Error(
            "BackendChainProvider.getReferenceUtxo: /params returned no referenceUtxo",
          );
        }
        const utxo = await this.getUtxoByRef({
          txId: ref.txHash,
          outputIndex: ref.outputIndex,
        });
        if (!utxo) {
          throw new Error(
            `BackendChainProvider.getReferenceUtxo: reference UTxO ${ref.txHash}#${ref.outputIndex} not found on chain`,
          );
        }
        const unit = `${nftPolicy}${nftAssetNameHex}`;
        if (utxo.assets[unit] !== 1n) {
          throw new Error(
            `BackendChainProvider.getReferenceUtxo: UTxO ${ref.txHash}#${ref.outputIndex} doesn't carry NFT ${unit}`,
          );
        }
        return utxo;
      },
      (fallback) => fallback.getReferenceUtxo(nftPolicy, nftAssetNameHex),
    );
  }

  async getProtocolParameters(): Promise<NetworkProtocolParameters> {
    return this.tryWithFallback(
      "getProtocolParameters",
      async () => {
        const res = await this.fetchFn(`${this.baseUrl}/protocol-params`, {});
        const body = await readJson(res);
        if (!res.ok) {
          throw new Error(
            `BackendChainProvider.getProtocolParameters (${res.status}): ${
              (body as { message?: string })?.message ?? res.statusText
            }`,
          );
        }
        return ogmiosV6ParamsToNetwork(body as OgmiosV6Params);
      },
      (fallback) => fallback.getProtocolParameters(),
    );
  }

  /**
   * Mesh-compatible IFetcher + ISubmitter + IEvaluator, used by
   * `MeshTxBuilder`. Returns a `BackendMeshProvider` that hits the same
   * backend endpoints we use for the SDK's ChainProvider methods —
   * everything the tx-builder needs (UTxOs, protocol params, ex-units,
   * submit) goes through our own stack.
   *
   * Falls back to the configured Blockfrost provider's mesh sibling on
   * any per-method error so a flaky backend doesn't block tx submission.
   * Cached per provider instance — mesh's BlockfrostProvider is not
   * cheap to instantiate (lazy libsodium import), so we don't want to
   * pay the cost on every tx-build.
   */
  async meshProvider(): Promise<MeshFetcherSubmitter> {
    if (this._mesh) return this._mesh;
    const fbMesh = this.fallback
      ? await getMeshFromProvider(this.fallback)
      : null;
    this._mesh = new BackendMeshProvider({
      baseUrl: this.baseUrl,
      fetchFn: this.fetchFn,
      fallback: fbMesh,
    });
    return this._mesh;
  }
  private _mesh: MeshFetcherSubmitter | null = null;

  /**
   * Run `primary`. If it throws AND a fallback is configured, log + run
   * the fallback. If no fallback, rethrow.
   */
  private async tryWithFallback<T>(
    method: string,
    primary: () => Promise<T>,
    fallback: (provider: ChainProvider) => Promise<T>,
  ): Promise<T> {
    try {
      return await primary();
    } catch (err) {
      if (!this.fallback) throw err;
       
      console.warn(
        `[BackendChainProvider] ${method} fell back to Blockfrost: ${(err as Error).message}`,
      );
      return await fallback(this.fallback);
    }
  }
}

// ---------------------------------------------------------------------
// Translators
// ---------------------------------------------------------------------

function wireToUtxo(w: UtxoWire): Utxo {
  const assets: Record<string, bigint> = {};
  for (const [unit, qty] of Object.entries(w.assets)) {
    assets[unit] = BigInt(qty);
  }
  return {
    ref: { txId: w.txHash.toLowerCase(), outputIndex: w.outputIndex },
    address: w.address,
    lovelace: BigInt(w.lovelace),
    assets,
    inlineDatum: w.inlineDatum,
    referenceScript: w.referenceScriptCbor,
  };
}

function ogmiosV6ParamsToNetwork(p: OgmiosV6Params): NetworkProtocolParameters {
  // ogmios v6 expresses fee + min-utxo coefficients as flat numbers and
  // most monetary fields as { ada: { lovelace } }. Prices are string
  // ratios like "577/10000" — parse them back into floats.
  const minFeeA = Number(p.minFeeCoefficient ?? 0);
  const minFeeB = Number(p.minFeeConstant?.ada?.lovelace ?? 0);
  const maxTxSize = Number(p.maxTransactionSize?.bytes ?? 0);
  const utxoCostPerByte = BigInt(p.minUtxoDepositCoefficient ?? 0);
  const maxTxExSteps = BigInt(p.maxExecutionUnitsPerTransaction?.cpu ?? 0);
  const maxTxExMem = BigInt(p.maxExecutionUnitsPerTransaction?.memory ?? 0);
  const pricesStep = parseRatio(p.scriptExecutionPrices?.cpu);
  const pricesMem = parseRatio(p.scriptExecutionPrices?.memory);
  const costModels: Record<string, number[]> = {};
  if (p.plutusCostModels) {
    for (const [key, arr] of Object.entries(p.plutusCostModels)) {
      // ogmios uses "plutus:v3"; SDK consumers expect "PlutusV3".
      const normalized = key.replace(/^plutus:v(\d)$/i, (_, n) => `PlutusV${n}`);
      costModels[normalized] = arr;
    }
  }
  return {
    minFeeA,
    minFeeB,
    maxTxSize,
    utxoCostPerByte,
    maxTxExSteps,
    maxTxExMem,
    pricesStep,
    pricesMem,
    costModels,
    network: p.network ?? "unknown",
    slotLength: Number(p.slotLength?.milliseconds ?? 1000),
  };
}

function parseRatio(s: string | undefined): number {
  if (!s) return 0;
  const [num, den] = s.split("/").map(Number);
  if (!Number.isFinite(num!) || !Number.isFinite(den!) || den === 0) return 0;
  return num! / den!;
}

async function readJson(res: { json(): Promise<unknown>; text(): Promise<string> }): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    try {
      return { message: await res.text() };
    } catch {
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pull a mesh-shaped sibling out of a fallback ChainProvider. Mirrors
 * the duck-typing in `tx/mesh-bridge.ts` so a custom ChainProvider that
 * exposes its own `meshProvider()` slots in here too. Returns null if
 * the fallback can't be coerced — BackendMeshProvider treats that as
 * "no fallback" and surfaces the primary error.
 */
async function getMeshFromProvider(
  provider: ChainProvider,
): Promise<MeshFetcherSubmitter | null> {
  const maybe = provider as unknown as {
    meshProvider?: () => Promise<MeshFetcherSubmitter>;
  };
  if (typeof maybe.meshProvider !== "function") return null;
  try {
    return await maybe.meshProvider();
  } catch {
    return null;
  }
}
