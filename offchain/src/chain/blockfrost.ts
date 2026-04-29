// Blockfrost-backed implementation of `ChainProvider`.
//
// Spec: docs/spec/09-milestones.md M2 notes — Blockfrost is the v1 chain
// provider; the same interface gets a second self-hosted implementation in M5.
//
// Why hand-rolled vs mesh's `BlockfrostProvider`: we need a stable, narrow
// interface (`ChainProvider`) that downstream SDK code can depend on, and that
// we can test under mocked HTTP without dragging in mesh's full surface.
//
// One-provider story: callers (CLI, UI, integration tests) only ever construct
// our `BlockfrostProvider`. For the Lovejoin-specific queries
// (`getReferenceUtxo`, `getProtocolParams`, `getUtxoByRef`, ...) we use the
// hand-rolled fetch path. For mesh's tx-builder needs (`fetchUTxOs`,
// `fetchProtocolParameters`, `submitTx` with mesh shapes) we lazily build a
// mesh `BlockfrostProvider` and expose it via `.mesh`. Tx builders pull
// `provider.mesh` and pass it as `fetcher`/`submitter` to `MeshTxBuilder`.
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
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
  },
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

/**
 * Minimum mesh-shaped surface our tx builders pass to `MeshTxBuilder`.
 * Mesh's actual `IFetcher` + `ISubmitter` + `IEvaluator` interfaces have
 * many more methods, but the tx builders only ever call a handful.
 * Narrow type so callers don't have to import mesh.
 */
export interface MeshFetcherSubmitter {
  fetchUTxOs(hash: string, index?: number): Promise<unknown>;
  fetchProtocolParameters(epoch?: number): Promise<MeshProtocolParameters>;
  submitTx(tx: string): Promise<string>;
  /**
   * Mesh's `IEvaluator.evaluateTx` — script execution-unit budget.
   * Without this MeshTxBuilder falls back to coarse upper-bound defaults
   * that inflate the fee 10x or worse.
   */
  evaluateTx(cbor: string): Promise<unknown>;
}

/**
 * The fields of mesh's `Protocol` shape we care about. Mesh's full type
 * has ~25 fields; we only ever read / patch one (the Conway reference-
 * script fee parameter), but `Record<string, unknown>` lets us return
 * mesh's full object unchanged after augmenting it.
 */
export type MeshProtocolParameters = Record<string, unknown> & {
  minFeeRefScriptCostPerByte?: number;
};

export class BlockfrostProvider implements ChainProvider {
  private readonly baseUrl: string;
  private readonly projectId: string;
  private readonly fetchFn: FetchFn;
  private readonly pollIntervalMs: number;
  /**
   * Lazily-constructed mesh `BlockfrostProvider`. We don't build it eagerly
   * because importing `@meshsdk/provider` pulls libsodium and the rest of
   * mesh's stack — unnecessary cost for callers (most unit tests; the M2
   * provider tests) that only need the chain queries.
   */
  private _mesh: MeshFetcherSubmitter | null = null;

  constructor(config: BlockfrostConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.projectId = config.projectId;
    const injected = config.fetchFn;
    const globalFetch = (globalThis as { fetch?: FetchFn }).fetch;
    if (!injected && !globalFetch) {
      throw new Error(
        "BlockfrostProvider: no fetch implementation available. Pass `fetchFn` explicitly.",
      );
    }
    // Bind the global `fetch` to its owner before stashing — calling
    // `window.fetch` with `this === BlockfrostProvider` throws
    // "Illegal invocation" in the browser. Test injections are passed
    // through unmodified so mocks see their normal `this`.
    this.fetchFn = injected ?? (globalFetch!.bind(globalThis) as FetchFn);
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /**
   * Mesh-shaped fetcher + submitter, suitable for `new MeshTxBuilder({
   * fetcher, submitter })`. Lazily constructed on first access.
   *
   * Not awaited because callers want a sync handle they can drop straight
   * into MeshTxBuilder; the underlying mesh class loads its axios + shape
   * helpers up front but defers any network I/O until a method is called.
   */
  async meshProvider(): Promise<MeshFetcherSubmitter> {
    if (this._mesh) return this._mesh;
    // Lazy import — see file-header comment on the libsodium / bundle cost.
    // We pull from `@meshsdk/core` (which re-exports `@meshsdk/provider`)
    // so we don't need a separate workspace dep on the provider package.
    const { BlockfrostProvider: MeshBlockfrost } = await import(
      "@meshsdk/core"
    );
    // Mesh's BlockfrostProvider(projectId) infers the network from the
    // project id prefix ("preprod...", "preview...", "mainnet..."), which
    // matches what we already require callers to set.
    const meshBf = new MeshBlockfrost(
      this.projectId,
    ) as MeshFetcherSubmitter & {
      evaluateTx: (tx: string) => Promise<unknown>;
      fetchProtocolParameters: (epoch?: number) => Promise<MeshProtocolParameters>;
    };

    // Mesh's BlockfrostProvider.fetchProtocolParameters strips
    // `min_fee_ref_script_cost_per_byte` from the Blockfrost response — it
    // never made it into mesh's `castProtocol6` mapping. Conway charges
    // `total_ref_script_size × min_fee_ref_script_cost_per_byte` lovelace
    // per tx that consumes reference scripts (currently 15 lovelace/byte
    // on Preprod / mainnet). For a withdraw tx that pulls mix_box +
    // mix_logic via `spendingTxInReference` / `withdrawalTxInReference`,
    // that's ~3 KB × 15 ≈ 45 k lovelace mesh under-counts. Result:
    // chain rejects with `FeeTooSmallUTxO`.
    //
    // Re-fetch the raw Blockfrost response and patch the field through.
    // Same shape as the evaluateTx override above.
    const originalFetchParams =
      meshBf.fetchProtocolParameters.bind(meshBf);
    const get = this.get.bind(this);
    meshBf.fetchProtocolParameters = async (epoch?: number) => {
      const params = await originalFetchParams(epoch);
      const path = `/epochs/${epoch === undefined || Number.isNaN(epoch) ? "latest" : epoch}/parameters`;
      const raw = (await get(path)) as
        | Record<string, unknown>
        | null;
      // Blockfrost has shipped this field under both conventions across
      // versions; accept either. Also tolerate stringified numbers.
      const rawRefScriptCost =
        raw?.["min_fee_ref_script_cost_per_byte"] ??
        raw?.["minFeeRefScriptCostPerByte"];
      const refScriptCost =
        typeof rawRefScriptCost === "number"
          ? rawRefScriptCost
          : typeof rawRefScriptCost === "string"
            ? Number.parseFloat(rawRefScriptCost)
            : undefined;
      if (typeof refScriptCost === "number" && refScriptCost > 0 && !Number.isNaN(refScriptCost)) {
        params.minFeeRefScriptCostPerByte = refScriptCost;
        // eslint-disable-next-line no-console
        console.log(
          `[lovejoin/params] patched minFeeRefScriptCostPerByte=${refScriptCost} ` +
            `into mesh protocol params (mesh's caster drops this Conway field)`,
        );
      } else if (refScriptCost !== undefined) {
        // eslint-disable-next-line no-console
        console.warn(
          `[lovejoin/params] Blockfrost returned min_fee_ref_script_cost_per_byte=` +
            `${JSON.stringify(refScriptCost)}; expected a positive number — ` +
            `tx fee may under-count Conway reference-script cost.`,
        );
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          `[lovejoin/params] Blockfrost did not return min_fee_ref_script_cost_per_byte; ` +
            `mesh will fall back to its built-in default (likely 15 lovelace/byte).`,
        );
      }
      return params;
    };
    // Mesh's BlockfrostProvider posts to /utils/txs/evaluate without a
    // `version` query param, which makes Blockfrost route the request
    // through ogmios v5. v5 predates Conway and doesn't know
    // `xor_bytearray` (builtin 77) — the moment the sigma-OR verifier
    // tries to XOR a per-branch challenge, the script aborts. v5
    // surfaces that as `EvaluationFailure: ScriptFailures: {}` (empty
    // failure map) which masks the real cause.
    //
    // Override `evaluateTx` to hit `?version=6` instead. The request
    // body shape is the same; the response is JSON-RPC 2.0 instead of
    // jsonwsp. We translate it to the mesh `Action[]` shape MeshTxBuilder
    // expects.
    const baseUrl = this.baseUrl;
    const projectId = this.projectId;
    const fetchFn = this.fetchFn;
    meshBf.evaluateTx = async (tx: string) => {
      // eslint-disable-next-line no-console
      console.log(
        `[lovejoin/evaluator] POST ${baseUrl}/utils/txs/evaluate?version=6 (txHex ${tx.length / 2} bytes)`,
      );
      let body: {
        result?: Array<{
          validator: { index: number; purpose: string };
          budget: { memory: number; cpu: number };
        }>;
        error?: { code: number; message: string; data?: unknown };
      };
      try {
        const res = await fetchFn(
          `${baseUrl}/utils/txs/evaluate?version=6`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/cbor",
              project_id: projectId,
            },
            body: tx,
          },
        );
        // eslint-disable-next-line no-console
        console.log(`[lovejoin/evaluator] HTTP ${res.status} ${res.statusText}`);
        body = (await res.json()) as typeof body;
      } catch (networkErr) {
        // eslint-disable-next-line no-console
        console.error(`[lovejoin/evaluator] network error:`, networkErr);
        throw networkErr;
      }
      if (body.error) {
        // eslint-disable-next-line no-console
        console.error(
          `[lovejoin/evaluator] BLOCKFROST RETURNED ERROR — populate-time exUnits will ride into the final tx:`,
          body.error,
        );
        throw new Error(
          `Blockfrost ogmios v6 evaluator rejected the tx: ` +
            `${body.error.message} ` +
            `(code ${body.error.code})\n${JSON.stringify(body.error.data, null, 2)}`,
        );
      }
      if (!body.result) {
        // eslint-disable-next-line no-console
        console.error(
          `[lovejoin/evaluator] BLOCKFROST RETURNED NO RESULT — populate-time exUnits will ride:`,
          body,
        );
        throw new Error(
          `Blockfrost ogmios v6 evaluator returned no result: ${JSON.stringify(body).slice(0, 300)}`,
        );
      }
      // eslint-disable-next-line no-console
      console.log(
        `[lovejoin/evaluator] BLOCKFROST RETURNED ${body.result.length} redeemer budget(s):`,
        body.result.map((e) => ({
          purpose: e.validator.purpose,
          index: e.validator.index,
          mem: e.budget.memory,
          cpu: e.budget.cpu,
        })),
      );
      // v6 purposes:    spend | mint | publish | withdraw | vote | propose
      // mesh's Action.tag: SPEND | MINT | CERT  | REWARD   | VOTE | PROPOSE
      const purposeMap: Record<string, string> = {
        spend: "SPEND",
        mint: "MINT",
        publish: "CERT",
        withdraw: "REWARD",
        vote: "VOTE",
        propose: "PROPOSE",
      };
      return body.result.map((entry) => ({
        tag: purposeMap[entry.validator.purpose] ?? entry.validator.purpose,
        index: entry.validator.index,
        budget: { mem: entry.budget.memory, steps: entry.budget.cpu },
      }));
    };
    this._mesh = meshBf;
    return this._mesh;
  }

  async submitTx(signedTxCborHex: string): Promise<Hex32> {
    // Blockfrost's `Content-Type: application/cbor` endpoint expects raw
    // bytes — a Uint8Array body. Earlier we passed the hex string itself
    // and let `fetch` send it; the browser UTF-8-encoded the string and
    // mangled the CBOR (Blockfrost rejected with "expected list len or
    // indef" on the first byte). Decode the hex to bytes here.
    // eslint-disable-next-line no-console
    console.log(
      `[lovejoin/submit] POST ${this.baseUrl}/tx/submit (txCbor=${signedTxCborHex.length / 2} bytes)`,
    );
    // eslint-disable-next-line no-console
    console.log(`[lovejoin/submit] signed tx hex: ${signedTxCborHex}`);
    const res = await this.fetchFn(`${this.baseUrl}/tx/submit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/cbor",
        project_id: this.projectId,
      },
      body: hexToBytes(signedTxCborHex),
    });
    // eslint-disable-next-line no-console
    console.log(`[lovejoin/submit] HTTP ${res.status} ${res.statusText}`);
    if (!res.ok) {
      const body = await res.text();
      // eslint-disable-next-line no-console
      console.error(`[lovejoin/submit] body:`, body);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
