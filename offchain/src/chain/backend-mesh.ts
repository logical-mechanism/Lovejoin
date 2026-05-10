// BackendMeshProvider — mesh-shaped fetcher + submitter + evaluator
// backed by the self-hosted lovejoin backend (db-sync + ogmios) instead
// of Blockfrost.
//
// What MeshTxBuilder actually invokes (the wider IFetcher / ISubmitter /
// IEvaluator interfaces declare ~20 methods total, but the tx-builders
// in this repo only end up at four of them; duck typing is sufficient):
//
//   - fetchUTxOs(txHash, index?)        → resolves a tx's outputs (ref inputs)
//   - fetchAddressUTxOs(address)        → wallet coin selection
//   - fetchProtocolParameters(epoch?)   → fee math, ex-unit caps, ref-script cost
//   - evaluateTx(cborHex)               → script ex-unit budgets
//   - submitTx(cborHex)                 → final broadcast
//
// Endpoint mapping (all backend routes added on this same branch):
//   fetchUTxOs / fetchAddressUTxOs  → GET /tx/:hash/utxos | GET /utxos/:address
//   fetchProtocolParameters         → GET /protocol-params (ogmios v6)
//   evaluateTx                      → POST /evaluate     (ogmios v6 → mesh Action[])
//   submitTx                        → POST /submit       (ogmios SubmitTransaction)
//
// Translation notes (ogmios v6 → mesh Protocol shape):
//   - mesh wants flat numbers + a few stringified bigints; ogmios wraps
//     monetary fields in `{ ada: { lovelace } }` and rationals as
//     "num/den" strings. We unwrap both.
//   - Cost models do not live in mesh's Protocol type — mesh uses pinned
//     DEFAULT_V*_COST_MODEL_LIST internally. The backend still serves
//     them on /protocol-params for callers that want them (the SDK's
//     `getProtocolParameters` translator does pick them up); they just
//     aren't part of this mesh-shape translation.
//   - Conway's `minFeeRefScriptCostPerByte` is the single field mesh's
//     own BlockfrostProvider drops; we populate it from ogmios v6's
//     `minFeeReferenceScripts.base`.

import type { MeshAction, MeshFetcherSubmitter, MeshProtocolParameters } from "./blockfrost.js";
import type { AdditionalUtxo } from "./ogmios-utxo.js";

/**
 * Fetch surface — kept structurally identical to BackendChainProvider's
 * FetchFn so the mesh provider can share its parent's fetchFn unchanged.
 * Both clients only send string bodies (JSON-stringified), so `body` is
 * just `string`.
 */
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

export interface BackendMeshProviderConfig {
  /** Base URL of the lovejoin backend (e.g. http://localhost:3001). */
  baseUrl: string;
  fetchFn?: FetchFn;
  /**
   * Optional fallback mesh provider. When the backend's tx-build path
   * throws (network error, 5xx, parse failure) we fall back to this
   * provider so a brief backend hiccup doesn't break tx submission. The
   * fallback is typically the user's BlockfrostProvider's mesh sibling.
   */
  fallback?: MeshFetcherSubmitter | null;
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

interface OgmiosV6Params {
  minFeeCoefficient?: number;
  minFeeConstant?: { ada?: { lovelace?: number | string } };
  minFeeReferenceScripts?: {
    range?: number;
    base?: number;
    multiplier?: number;
  };
  maxBlockBodySize?: { bytes?: number };
  maxBlockHeaderSize?: { bytes?: number };
  maxTransactionSize?: { bytes?: number };
  maxValueSize?: { bytes?: number };
  stakeCredentialDeposit?: { ada?: { lovelace?: number | string } };
  stakePoolDeposit?: { ada?: { lovelace?: number | string } };
  minStakePoolCost?: { ada?: { lovelace?: number | string } };
  minUtxoDepositCoefficient?: number | string;
  scriptExecutionPrices?: { memory?: string; cpu?: string };
  maxExecutionUnitsPerTransaction?: { memory?: number; cpu?: number };
  maxExecutionUnitsPerBlock?: { memory?: number; cpu?: number };
  collateralPercentage?: number;
  maxCollateralInputs?: number;
}

export class BackendMeshProvider implements MeshFetcherSubmitter {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly fallback: MeshFetcherSubmitter | null;

  constructor(config: BackendMeshProviderConfig) {
    if (!/^https?:\/\//.test(config.baseUrl)) {
      throw new Error(`BackendMeshProvider: baseUrl must include scheme, got ${config.baseUrl}`);
    }
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    const injected = config.fetchFn;
    const globalFetch = (globalThis as { fetch?: FetchFn }).fetch;
    if (!injected && !globalFetch) {
      throw new Error(
        "BackendMeshProvider: no fetch implementation available. Pass fetchFn explicitly.",
      );
    }
    this.fetchFn = injected ?? (globalFetch!.bind(globalThis) as FetchFn);
    this.fallback = config.fallback ?? null;
  }

  // -------------------------------------------------------------------
  // IFetcher methods
  // -------------------------------------------------------------------

  /**
   * MeshTxBuilder calls this to resolve the outputs of a specific tx
   * (typically when a script tx-in-reference points at a published
   * Plutus script). When `index` is provided, return only that one
   * output — otherwise return every output the tx produced.
   */
  async fetchUTxOs(txHash: string, index?: number): Promise<MeshUtxo[]> {
    return this.tryWithFallback(
      "fetchUTxOs",
      async () => {
        const res = await this.fetchFn(`${this.baseUrl}/tx/${txHash}/utxos`, {});
        if (res.status === 404) return [];
        const body = await readJson(res);
        if (!res.ok) {
          throw new Error(
            `BackendMeshProvider.fetchUTxOs (${res.status}): ${
              (body as { message?: string })?.message ?? res.statusText
            }`,
          );
        }
        const utxos = (body as { utxos?: UtxoWire[] }).utxos ?? [];
        const filtered =
          typeof index === "number" ? utxos.filter((u) => u.outputIndex === index) : utxos;
        return filtered.map(wireToMeshUtxo);
      },
      (fb) => fb.fetchUTxOs(txHash, index) as Promise<MeshUtxo[]>,
    );
  }

  /**
   * Wallet coin selection path. Mesh's `IFetcher.fetchAddressUTxOs` —
   * MeshTxBuilder calls this when picking inputs for a wallet-paid tx.
   */
  async fetchAddressUTxOs(address: string): Promise<MeshUtxo[]> {
    return this.tryWithFallback(
      "fetchAddressUTxOs",
      async () => {
        const res = await this.fetchFn(`${this.baseUrl}/utxos/${address}`, {});
        const body = await readJson(res);
        if (!res.ok) {
          throw new Error(
            `BackendMeshProvider.fetchAddressUTxOs (${res.status}): ${
              (body as { message?: string })?.message ?? res.statusText
            }`,
          );
        }
        const utxos = (body as { utxos?: UtxoWire[] }).utxos ?? [];
        return utxos.map(wireToMeshUtxo);
      },
      // The fallback's IFetcher uses the same name; cast keeps us out of
      // the wider IFetcher type so callers don't need to import it.
      (fb) =>
        (fb as unknown as { fetchAddressUTxOs(a: string): Promise<MeshUtxo[]> }).fetchAddressUTxOs(
          address,
        ),
    );
  }

  async fetchProtocolParameters(_epoch?: number): Promise<MeshProtocolParameters> {
    return this.tryWithFallback(
      "fetchProtocolParameters",
      async () => {
        const res = await this.fetchFn(`${this.baseUrl}/protocol-params`, {});
        const body = await readJson(res);
        if (!res.ok) {
          throw new Error(
            `BackendMeshProvider.fetchProtocolParameters (${res.status}): ${
              (body as { message?: string })?.message ?? res.statusText
            }`,
          );
        }
        return ogmiosV6ToMeshProtocol(body as OgmiosV6Params);
      },
      (fb) => fb.fetchProtocolParameters(_epoch),
    );
  }

  // -------------------------------------------------------------------
  // ISubmitter
  // -------------------------------------------------------------------

  async submitTx(cborHex: string): Promise<string> {
    return this.tryWithFallback(
      "submitTx",
      async () => {
        const res = await this.fetchFn(`${this.baseUrl}/submit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cbor: cborHex }),
        });
        const body = await readJson(res);
        if (!res.ok) {
          throw new Error(
            `BackendMeshProvider.submitTx (${res.status}): ${
              (body as { message?: string })?.message ?? res.statusText
            }`,
          );
        }
        const txHash = (body as { txHash?: string }).txHash;
        if (typeof txHash !== "string" || !/^[0-9a-f]{64}$/i.test(txHash)) {
          throw new Error(
            `BackendMeshProvider.submitTx: malformed response ${JSON.stringify(body)}`,
          );
        }
        return txHash.toLowerCase();
      },
      (fb) => fb.submitTx(cborHex),
    );
  }

  // -------------------------------------------------------------------
  // IEvaluator
  // -------------------------------------------------------------------

  /**
   * Returns the mesh Action[] shape MeshTxBuilder expects. Translation
   * mirrors the BlockfrostProvider's `evaluateTx` override so callers
   * never see the difference between Blockfrost-ogmios-v6 and our own
   * ogmios-v6 — both go through the same purpose-string remapping.
   */
  async evaluateTx(cborHex: string): Promise<MeshAction[]> {
    return this.evaluateTxImpl(cborHex, undefined);
  }

  /**
   * Evaluate a tx with extra `[txin, txout]` pairs spliced into the
   * Ogmios chain state. POSTs to the backend's `/evaluate` with an
   * `additionalUtxoSet` array; the backend forwards it to ogmios as
   * `evaluateTransaction.additionalUtxo`.
   *
   * Used by the Mix tx-builder's chained-Mix path; see
   * `BuildMixArgs.chainFrom`.
   */
  async evaluateTxWithAdditionalUtxos(
    cborHex: string,
    additionalUtxos: ReadonlyArray<AdditionalUtxo>,
  ): Promise<MeshAction[]> {
    return this.evaluateTxImpl(cborHex, additionalUtxos);
  }

  /** Shared body for both evaluator paths; only differs in JSON body shape. */
  private async evaluateTxImpl(
    cborHex: string,
    additionalUtxos: ReadonlyArray<AdditionalUtxo> | undefined,
  ): Promise<MeshAction[]> {
    return this.tryWithFallback(
      "evaluateTx",
      async () => {
        const requestBody: { cbor: string; additionalUtxoSet?: ReadonlyArray<AdditionalUtxo> } = {
          cbor: cborHex,
        };
        if (additionalUtxos && additionalUtxos.length > 0) {
          requestBody.additionalUtxoSet = additionalUtxos;
        }
        const res = await this.fetchFn(`${this.baseUrl}/evaluate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Custom replacer drops bigint values down to numbers; the
          // backend's fastify route forwards verbatim to ogmios which
          // expects numeric quantities (same constraint as the
          // Blockfrost JSON endpoint).
          body: JSON.stringify(requestBody, (_k, v) => {
            if (typeof v === "bigint") {
              if (v > Number.MAX_SAFE_INTEGER) {
                throw new Error(
                  `BackendMeshProvider.evaluateTxWithAdditionalUtxos: bigint ${v} > MAX_SAFE_INTEGER`,
                );
              }
              return Number(v);
            }
            return v;
          }),
        });
        const body = await readJson(res);
        if (!res.ok) {
          throw new Error(
            `BackendMeshProvider.evaluateTx (${res.status}): ${
              (body as { message?: string })?.message ?? res.statusText
            }`,
          );
        }
        const redeemers = (
          body as {
            redeemers?: Array<{
              validator: { purpose: string; index: number };
              budget: { memory: number; cpu: number };
            }>;
          }
        ).redeemers;
        if (!Array.isArray(redeemers)) {
          throw new Error(`BackendMeshProvider.evaluateTx: malformed response (no redeemers)`);
        }
        return redeemers.map((r) => ({
          tag: PURPOSE_TO_TAG[r.validator.purpose] ?? r.validator.purpose,
          index: r.validator.index,
          budget: { mem: r.budget.memory, steps: r.budget.cpu },
        }));
      },
      (fb) => {
        // Fallback path: prefer the additional-utxos sibling on the fallback
        // if the caller asked for one; degrade to the regular evaluator only
        // when the fallback can't handle additional UTxOs.
        if (additionalUtxos && additionalUtxos.length > 0 && fb.evaluateTxWithAdditionalUtxos) {
          return fb.evaluateTxWithAdditionalUtxos(cborHex, additionalUtxos);
        }
        return fb.evaluateTx(cborHex) as Promise<MeshAction[]>;
      },
    );
  }

  // -------------------------------------------------------------------

  private async tryWithFallback<T>(
    method: string,
    primary: () => Promise<T>,
    fallback: (fb: MeshFetcherSubmitter) => Promise<T>,
  ): Promise<T> {
    try {
      return await primary();
    } catch (err) {
      if (!this.fallback) throw err;

      console.warn(
        `[BackendMeshProvider] ${method} fell back to Blockfrost: ${(err as Error).message}`,
      );
      return await fallback(this.fallback);
    }
  }
}

// ---------------------------------------------------------------------
// Translators
// ---------------------------------------------------------------------

/** Ogmios v6 redeemer purpose → mesh Action.tag. */
const PURPOSE_TO_TAG: Record<string, string> = {
  spend: "SPEND",
  mint: "MINT",
  publish: "CERT",
  withdraw: "REWARD",
  vote: "VOTE",
  propose: "PROPOSE",
};

function wireToMeshUtxo(w: UtxoWire): MeshUtxo {
  const amount: { unit: string; quantity: string }[] = [{ unit: "lovelace", quantity: w.lovelace }];
  for (const [unit, qty] of Object.entries(w.assets)) {
    amount.push({ unit, quantity: qty });
  }
  const out: MeshUtxo = {
    input: { txHash: w.txHash.toLowerCase(), outputIndex: w.outputIndex },
    output: { address: w.address, amount },
  };
  if (w.inlineDatum) out.output.plutusData = w.inlineDatum;
  if (w.datumHash) out.output.dataHash = w.datumHash;
  if (w.referenceScriptCbor) out.output.scriptRef = w.referenceScriptCbor;
  if (w.referenceScriptHash) out.output.scriptHash = w.referenceScriptHash;
  return out;
}

/**
 * Translate the ogmios v6 protocolParameters response into mesh's
 * Protocol shape. `epoch` defaults to 0 — mesh doesn't validate the
 * field when consuming params (it's metadata for CIP-30 wallets), and
 * ogmios's params don't carry an epoch number.
 */
function ogmiosV6ToMeshProtocol(p: OgmiosV6Params): MeshProtocolParameters {
  const minFeeA = Number(p.minFeeCoefficient ?? 0);
  const minFeeB = Number(p.minFeeConstant?.ada?.lovelace ?? 0);
  const refScriptCost = Number(p.minFeeReferenceScripts?.base ?? 0);
  const params: MeshProtocolParameters = {
    epoch: 0,
    minFeeA,
    minFeeB,
    maxBlockSize: Number(p.maxBlockBodySize?.bytes ?? 0),
    maxTxSize: Number(p.maxTransactionSize?.bytes ?? 0),
    maxBlockHeaderSize: Number(p.maxBlockHeaderSize?.bytes ?? 0),
    keyDeposit: Number(p.stakeCredentialDeposit?.ada?.lovelace ?? 0),
    poolDeposit: Number(p.stakePoolDeposit?.ada?.lovelace ?? 0),
    decentralisation: 0,
    minPoolCost: String(p.minStakePoolCost?.ada?.lovelace ?? "0"),
    priceMem: parseRatio(p.scriptExecutionPrices?.memory),
    priceStep: parseRatio(p.scriptExecutionPrices?.cpu),
    maxTxExMem: String(p.maxExecutionUnitsPerTransaction?.memory ?? "0"),
    maxTxExSteps: String(p.maxExecutionUnitsPerTransaction?.cpu ?? "0"),
    maxBlockExMem: String(p.maxExecutionUnitsPerBlock?.memory ?? "0"),
    maxBlockExSteps: String(p.maxExecutionUnitsPerBlock?.cpu ?? "0"),
    maxValSize: Number(p.maxValueSize?.bytes ?? 0),
    collateralPercent: Number(p.collateralPercentage ?? 0),
    maxCollateralInputs: Number(p.maxCollateralInputs ?? 0),
    coinsPerUtxoSize: Number(p.minUtxoDepositCoefficient ?? 0),
    minFeeRefScriptCostPerByte:
      refScriptCost > 0 && Number.isFinite(refScriptCost) ? refScriptCost : 15,
  };
  return params;
}

function parseRatio(s: string | undefined): number {
  if (!s) return 0;
  const [num, den] = s.split("/").map(Number);
  if (!Number.isFinite(num!) || !Number.isFinite(den!) || den === 0) return 0;
  return num! / den!;
}

async function readJson(res: {
  json(): Promise<unknown>;
  text(): Promise<string>;
}): Promise<unknown> {
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
