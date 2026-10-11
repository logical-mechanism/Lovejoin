import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { blake2b } from "@noble/hashes/blake2.js";
import { describe, expect, it } from "vitest";

import {
  type FetchFn,
  KoiosProvider,
  koiosBaseUrl,
  koiosScriptRefCbor,
  type MeshFetcherSubmitter,
} from "../../src/chain/index.js";
import { stringifyWithBigints } from "../../src/chain/koios.js";

// Mocked HTTP layer, same approach as chain-provider.test.ts: pin the wire
// shape (endpoints, bodies, headers) and the Koios → ChainProvider / mesh
// translations without touching the network.

interface MockResponse {
  status?: number;
  json?: unknown;
  text?: string;
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
}

const BASE = koiosBaseUrl("preprod");

function buildFetch(
  respond: (url: string, body: unknown) => MockResponse,
  calls: RecordedCall[],
): FetchFn {
  return async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body,
    });
    const parsed = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    const r = respond(url, parsed);
    const status = r.status ?? 200;
    const text = r.text ?? JSON.stringify(r.json);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };
}

function koios(
  respond: (url: string, body: unknown) => MockResponse,
  extra: { evaluateRetries?: number } = {},
): { provider: KoiosProvider; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const provider = new KoiosProvider({
    baseUrl: BASE,
    fetchFn: buildFetch(respond, calls),
    pollIntervalMs: 1,
    evaluateRetryDelayMs: 1,
    ...extra,
  });
  return { provider, calls };
}

const TX = "ab".repeat(32);
const POLICY = "11".repeat(28);
const BIG_Q = "18446744073709551615"; // 2^64 - 1, above JS safe-integer range

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tx_hash: TX,
    tx_index: 0,
    address: "addr_test1wexample",
    value: "2000000",
    datum_hash: null,
    inline_datum: null,
    asset_list: [],
    reference_script: null,
    is_spent: false,
    ...overrides,
  };
}

// The mainnet mix_box script: its .plutus envelope holds the double-CBOR
// form; Koios reports the inner (single-CBOR) bytes the ledger hashes.
const MAINNET = resolve(__dirname, "../../../artifacts/mainnet");
const mixBoxDouble = JSON.parse(readFileSync(`${MAINNET}/mix_box.plutus`, "utf8"))
  .cborHex as string;
const mixBoxSingle = mixBoxDouble.slice(6); // strip the 59xxxx outer bytestring header
const mixBoxHash = JSON.parse(readFileSync(`${MAINNET}/addresses.json`, "utf8"))
  .mixBoxScriptHash as string;

describe("KoiosProvider", () => {
  it("submits raw CBOR bytes and returns the txid", async () => {
    const { provider, calls } = koios(() => ({ status: 202, text: `"${TX.toUpperCase()}"` }));
    await expect(provider.submitTx("84a0")).resolves.toBe(TX);
    expect(calls[0]!.url).toBe(`${BASE}/submittx`);
    expect(calls[0]!.headers["Content-Type"]).toBe("application/cbor");
    expect(calls[0]!.body).toEqual(new Uint8Array([0x84, 0xa0]));
  });

  it("surfaces the submit rejection body", async () => {
    const { provider } = koios(() => ({ status: 400, text: "ValueNotConservedUTxO" }));
    await expect(provider.submitTx("84a0")).rejects.toThrow(/ValueNotConservedUTxO/);
  });

  it("pages address_utxos in a stable order until a short page", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => row({ tx_index: i }));
    const { provider, calls } = koios((url) => ({
      json: url.includes("offset=0&") ? full : [row({ tx_index: 1000 })],
    }));
    const utxos = await provider.getUtxos("addr_test1wexample");
    expect(utxos).toHaveLength(1001);
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/address_utxos?offset=0&limit=1000&order=tx_hash.asc,tx_index.asc`,
      `${BASE}/address_utxos?offset=1000&limit=1000&order=tx_hash.asc,tx_index.asc`,
    ]);
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      _addresses: ["addr_test1wexample"],
      _extended: true,
    });
  });

  it("parses inline datums, exact token quantities, and reference scripts", async () => {
    const { provider } = koios(() => ({
      json: [
        row({
          inline_datum: { bytes: "d87980", value: {} },
          datum_hash: "cc".repeat(32),
          asset_list: [{ policy_id: POLICY, asset_name: "746f6b", quantity: BIG_Q }],
          reference_script: { hash: mixBoxHash, type: "plutusV3", bytes: mixBoxSingle },
        }),
      ],
    }));
    const u = await provider.getUtxoByRef({ txId: TX, outputIndex: 0 });
    expect(u).not.toBeNull();
    expect(u!.lovelace).toBe(2_000_000n);
    expect(u!.assets).toEqual({ [`${POLICY}746f6b`]: 18446744073709551615n });
    expect(u!.inlineDatum).toBe("d87980");
    expect(u!.referenceScript).toBe(koiosScriptRefCbor({ type: "plutusV3", bytes: mixBoxSingle }));
  });

  it("returns null for an unknown UTxO ref", async () => {
    const { provider } = koios(() => ({ json: [] }));
    await expect(provider.getUtxoByRef({ txId: TX, outputIndex: 3 })).resolves.toBeNull();
  });

  it("finds the single unspent reference-NFT carrier", async () => {
    const nft = [{ policy_id: POLICY, asset_name: "6c6f76656a6f696e", quantity: "1" }];
    const { provider, calls } = koios(() => ({
      json: [
        row({ tx_index: 0, asset_list: nft, is_spent: true }),
        row({ tx_index: 1, asset_list: nft }),
      ],
    }));
    const u = await provider.getReferenceUtxo(POLICY, "6c6f76656a6f696e");
    expect(u.ref.outputIndex).toBe(1);
    expect(JSON.parse(calls[0]!.body as string)._asset_list).toEqual([
      [POLICY, "6c6f76656a6f696e"],
    ]);
  });

  it("rejects when the reference NFT is not held exactly once", async () => {
    const { provider } = koios(() => ({ json: [] }));
    await expect(provider.getReferenceUtxo(POLICY, "6c6f76656a6f696e")).rejects.toThrow(
      /present in 0 UTxOs/,
    );
  });

  it("awaitConfirmation polls tx_status until the tx has a confirmation", async () => {
    let polls = 0;
    const { provider } = koios(() => ({
      json: [{ tx_hash: TX, num_confirmations: ++polls < 3 ? null : 1 }],
    }));
    await provider.awaitConfirmation(TX, 10_000);
    expect(polls).toBe(3);
  });

  it("awaitConfirmation rejects after timeoutMs", async () => {
    const { provider } = koios(() => ({ json: [{ tx_hash: TX, num_confirmations: null }] }));
    await expect(provider.awaitConfirmation(TX, 5)).rejects.toThrow(/not seen after 5ms/);
  });

  it("maps cli_protocol_params into NetworkProtocolParameters", async () => {
    const { provider } = koios(() => ({
      json: {
        txFeePerByte: 44,
        txFeeFixed: 155381,
        maxTxSize: 16384,
        utxoCostPerByte: 4310,
        maxTxExecutionUnits: { memory: 17500000, steps: 10000000000 },
        executionUnitPrices: { priceMemory: 0.0577, priceSteps: 0.0000721 },
        costModels: { PlutusV3: [1, 2, 3] },
      },
    }));
    await expect(provider.getProtocolParameters()).resolves.toEqual({
      minFeeA: 44,
      minFeeB: 155381,
      maxTxSize: 16384,
      utxoCostPerByte: 4310n,
      maxTxExSteps: 10_000_000_000n,
      maxTxExMem: 17_500_000n,
      pricesStep: 0.0000721,
      pricesMem: 0.0577,
      costModels: { PlutusV3: [1, 2, 3] },
      network: "preprod",
      slotLength: 1_000,
    });
  });
});

describe("KoiosProvider.meshProvider", () => {
  async function mesh(
    respond: (url: string, body: unknown) => MockResponse,
    extra: { evaluateRetries?: number } = {},
  ): Promise<{ mesh: MeshFetcherSubmitter; calls: RecordedCall[] }> {
    const { provider, calls } = koios(respond, extra);
    return { mesh: await provider.meshProvider(), calls };
  }

  it("fetchUTxOs resolves every output of a tx with its real address", async () => {
    const out = (i: number, extra: Record<string, unknown> = {}) => {
      const { address: _address, ...rest } = row({ tx_index: i, ...extra });
      return { ...rest, payment_addr: { bech32: `addr_test1v${i}`, cred: "00" } };
    };
    const { mesh: m, calls } = await mesh(() => ({
      json: [
        {
          tx_hash: TX,
          outputs: [
            out(0, {
              reference_script: { hash: mixBoxHash, type: "plutusV3", bytes: mixBoxSingle },
            }),
            out(1, { inline_datum: { bytes: "d87980" }, datum_hash: "cc".repeat(32) }),
          ],
        },
      ],
    }));
    const all = (await m.fetchUTxOs(TX)) as Array<{
      input: { outputIndex: number };
      output: Record<string, unknown>;
    }>;
    expect(all.map((u) => u.output.address)).toEqual(["addr_test1v0", "addr_test1v1"]);
    expect(all[0]!.output.scriptHash).toBe(mixBoxHash);
    expect(all[1]!.output.plutusData).toBe("d87980");
    expect(all[1]!.output.dataHash).toBe("cc".repeat(32));
    // Koios strips every output's asset_list unless asked for assets, and
    // mesh would then rebuild token inputs as ADA-only.
    expect(JSON.parse(calls[0]!.body as string)).toMatchObject({ _assets: true });
    const one = (await m.fetchUTxOs(TX, 1)) as Array<{ input: { outputIndex: number } }>;
    expect(one.map((u) => u.input.outputIndex)).toEqual([1]);
  });

  it("evaluateTx translates Ogmios budgets into mesh actions", async () => {
    const { mesh: m, calls } = await mesh(() => ({
      json: {
        jsonrpc: "2.0",
        result: [
          { validator: { purpose: "spend", index: 0 }, budget: { memory: 10, cpu: 20 } },
          { validator: { purpose: "withdraw", index: 0 }, budget: { memory: 30, cpu: 40 } },
        ],
      },
    }));
    await expect(m.evaluateTx("84a0")).resolves.toEqual([
      { tag: "SPEND", index: 0, budget: { mem: 10, steps: 20 } },
      { tag: "REWARD", index: 0, budget: { mem: 30, steps: 40 } },
    ]);
    expect(calls[0]!.url).toBe(`${BASE}/ogmios`);
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      jsonrpc: "2.0",
      method: "evaluateTransaction",
      params: { transaction: { cbor: "84a0" } },
    });
  });

  it("evaluateTx surfaces script failures with Ogmios' data", async () => {
    const { mesh: m } = await mesh(() => ({
      status: 400,
      json: {
        jsonrpc: "2.0",
        error: { code: 3010, message: "Some scripts failed", data: [{ error: "expect output" }] },
      },
    }));
    await expect(m.evaluateTx("84a0")).rejects.toThrow(
      /Some scripts failed \(code 3010\)[\s\S]*expect output/,
    );
  });

  it("evaluateTx retries while the Ogmios node has not seen an input", async () => {
    let attempts = 0;
    const { mesh: m } = await mesh(() =>
      ++attempts < 3
        ? { json: { error: { code: 3117, message: "unknown transaction inputs" } } }
        : { json: { result: [] } },
    );
    await expect(m.evaluateTx("84a0")).resolves.toEqual([]);
    expect(attempts).toBe(3);
  });

  it("evaluateTx gives up on unknown inputs after evaluateRetries", async () => {
    const { mesh: m, calls } = await mesh(
      () => ({ json: { error: { code: 3117, message: "unknown transaction inputs" } } }),
      { evaluateRetries: 1 },
    );
    await expect(m.evaluateTx("84a0")).rejects.toThrow(/unknown transaction inputs/);
    expect(calls).toHaveLength(2);
  });

  it("evaluateTxWithAdditionalUtxos sends token quantities above 2^53 exactly", async () => {
    const { mesh: m, calls } = await mesh(() => ({ json: { result: [] } }));
    await m.evaluateTxWithAdditionalUtxos!("84a0", [
      {
        transaction: { id: TX },
        index: 0,
        address: "addr_test1wexample",
        value: { ada: { lovelace: 2_000_000n }, [POLICY]: { "746f6b": BigInt(BIG_Q) } },
      },
    ]);
    const body = calls[0]!.body as string;
    expect(body).toContain(`"746f6b":${BIG_Q}`);
    expect(body).toContain(`"lovelace":2000000`);
  });

  it("fetchProtocolParameters reads Ogmios params through the passthrough", async () => {
    const { mesh: m, calls } = await mesh(() => ({
      json: {
        result: {
          minFeeCoefficient: 44,
          minFeeConstant: { ada: { lovelace: 155381 } },
          minFeeReferenceScripts: { base: 15 },
          minUtxoDepositCoefficient: 4310,
        },
      },
    }));
    const p = await m.fetchProtocolParameters();
    expect(p).toMatchObject({ minFeeA: 44, minFeeB: 155381, coinsPerUtxoSize: 4310 });
    expect(p.minFeeRefScriptCostPerByte).toBe(15);
    expect(JSON.parse(calls[0]!.body as string).method).toBe("queryLedgerState/protocolParameters");
  });
});

describe("koiosScriptRefCbor", () => {
  it("emits mesh's bare [language, script] form for a Plutus V3 script", () => {
    // Pinned against mesh-core-cst's toScriptRef(...).toCbor() for this
    // script: 82 03, then a 629-byte CBOR bytestring of the script bytes.
    // The SDK unit tests stay mesh-free; the token-pool integration test
    // re-checks parity against mesh at runtime.
    expect(mixBoxSingle.length / 2).toBe(629);
    expect(koiosScriptRefCbor({ type: "plutusV3", bytes: mixBoxSingle })).toBe(
      `8203590275${mixBoxSingle}`,
    );
  });

  it("wraps native scripts with language 0", () => {
    expect(koiosScriptRefCbor({ type: "timelock", bytes: "8200581c00" })).toBe("82008200581c00");
  });

  it("Koios' Plutus bytes are the bytes the ledger hashes", () => {
    const tagged = Buffer.concat([Buffer.from([3]), Buffer.from(mixBoxSingle, "hex")]);
    expect(Buffer.from(blake2b(tagged, { dkLen: 28 })).toString("hex")).toBe(mixBoxHash);
  });

  it("rejects unknown script types", () => {
    expect(() => koiosScriptRefCbor({ type: "plutusV9", bytes: "00" })).toThrow(
      /unknown script type/,
    );
  });
});

describe("stringifyWithBigints", () => {
  it("writes bigints as bare integer literals", () => {
    expect(stringifyWithBigints({ a: 1n, b: [BigInt(BIG_Q)], c: "x" })).toBe(
      `{"a":1,"b":[${BIG_Q}],"c":"x"}`,
    );
  });
});
