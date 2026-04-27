import { describe, expect, it } from "vitest";
import {
  BlockfrostProvider,
  type ChainProvider,
  type FetchFn,
  type Utxo,
} from "../../src/chain/index.js";

// Mocked HTTP layer. The aim of these tests is to nail the wire shape — what
// endpoints get hit, what headers go, how Blockfrost responses get folded into
// the ChainProvider interface — without ever talking to network.

interface MockResponseBody {
  status?: number;
  statusText?: string;
  json?: unknown;
  text?: string;
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function buildFetch(
  responses: Map<string, MockResponseBody | MockResponseBody[]>,
  recorder: RecordedCall[],
): FetchFn {
  return async (url, init) => {
    recorder.push({
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body,
    });
    let body = responses.get(url);
    if (Array.isArray(body)) {
      body = body.shift();
    }
    const status = body?.status ?? 200;
    const statusText = body?.statusText ?? "OK";
    const ok = status >= 200 && status < 300;
    const text = body?.text ?? (body?.json ? JSON.stringify(body.json) : "");
    return {
      ok,
      status,
      statusText,
      async text() {
        return text;
      },
      async json() {
        if (body?.json !== undefined) return body.json;
        if (text.length === 0) {
          throw new Error("mock: no json body");
        }
        return JSON.parse(text);
      },
    };
  };
}

const BASE = "https://cardano-preprod.blockfrost.io/api/v0";

function provider(
  responses: Map<string, MockResponseBody | MockResponseBody[]>,
): { provider: ChainProvider; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const p = new BlockfrostProvider({
    baseUrl: BASE,
    projectId: "preprod_TEST",
    fetchFn: buildFetch(responses, calls),
    pollIntervalMs: 1,
  });
  return { provider: p, calls };
}

describe("BlockfrostProvider", () => {
  it("submits txs and returns the txid", async () => {
    const responses = new Map([
      [`${BASE}/tx/submit`, { json: "deadbeefcafedeadbeefcafedeadbeefcafedeadbeefcafedeadbeefcafe1234" }],
    ]);
    const { provider: p, calls } = provider(responses);
    const id = await p.submitTx("84a3...");
    expect(id).toBe("deadbeefcafedeadbeefcafedeadbeefcafedeadbeefcafedeadbeefcafe1234");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers).toEqual({
      "Content-Type": "application/cbor",
      project_id: "preprod_TEST",
    });
  });

  it("throws on non-ok submit responses", async () => {
    const responses = new Map([
      [
        `${BASE}/tx/submit`,
        { status: 400, statusText: "Bad Request", text: "tx failed validation" },
      ],
    ]);
    const { provider: p } = provider(responses);
    await expect(p.submitTx("84a3...")).rejects.toThrow(/400 Bad Request/);
    await expect(p.submitTx("84a3...")).rejects.toThrow(/tx failed validation/);
  });

  it("paginates getUtxos until an empty page", async () => {
    const responses = new Map<string, MockResponseBody | MockResponseBody[]>([
      [
        `${BASE}/addresses/addr_test1xyz/utxos?page=1&order=asc`,
        {
          json: [
            {
              tx_hash: "11".repeat(32),
              output_index: 0,
              address: "addr_test1xyz",
              amount: [{ unit: "lovelace", quantity: "10000000" }],
            },
          ],
        },
      ],
      [
        `${BASE}/addresses/addr_test1xyz/utxos?page=2&order=asc`,
        { json: [] },
      ],
    ]);
    const { provider: p, calls } = provider(responses);
    const utxos = await p.getUtxos("addr_test1xyz");
    expect(utxos).toHaveLength(1);
    expect(utxos[0]!.lovelace).toBe(10_000_000n);
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/addresses/addr_test1xyz/utxos?page=1&order=asc`,
      `${BASE}/addresses/addr_test1xyz/utxos?page=2&order=asc`,
    ]);
  });

  it("returns an empty array when address has never been used (404)", async () => {
    const responses = new Map<string, MockResponseBody | MockResponseBody[]>([
      [
        `${BASE}/addresses/addr_test1unknown/utxos?page=1&order=asc`,
        { status: 404, text: "not found" },
      ],
    ]);
    const { provider: p } = provider(responses);
    const utxos = await p.getUtxos("addr_test1unknown");
    expect(utxos).toEqual([]);
  });

  it("parses inline datum + asset map in UTxO responses", async () => {
    const responses = new Map([
      [
        `${BASE}/addresses/addr_test1mix/utxos?page=1&order=asc`,
        {
          json: [
            {
              tx_hash: "ab".repeat(32),
              output_index: 0,
              address: "addr_test1mix",
              amount: [
                { unit: "lovelace", quantity: "10000000" },
                {
                  unit:
                    "abababababababababababababababababababababababababababab6c6f76656a6f696e",
                  quantity: "1",
                },
              ],
              inline_datum: "d8799f...some_cbor...",
              reference_script_hash: null,
            },
          ],
        },
      ],
      [`${BASE}/addresses/addr_test1mix/utxos?page=2&order=asc`, { json: [] }],
    ]);
    const { provider: p } = provider(responses);
    const [utxo] = await p.getUtxos("addr_test1mix");
    expect(utxo!.lovelace).toBe(10_000_000n);
    expect(
      utxo!.assets[
        "abababababababababababababababababababababababababababab6c6f76656a6f696e"
      ],
    ).toBe(1n);
    expect(utxo!.inlineDatum).toBe("d8799f...some_cbor...");
    expect(utxo!.referenceScript).toBeNull();
  });

  it("getReferenceUtxo finds the unique NFT-bearing UTxO", async () => {
    const policy = "ab".repeat(28);
    const name = "6c6f76656a6f696e"; // "lovejoin"
    const asset = `${policy}${name}`;
    const responses = new Map<string, MockResponseBody | MockResponseBody[]>([
      [
        `${BASE}/assets/${asset}/addresses`,
        { json: [{ address: "addr_test1ref", quantity: "1" }] },
      ],
      [
        `${BASE}/addresses/addr_test1ref/utxos?page=1&order=asc`,
        {
          json: [
            {
              tx_hash: "ee".repeat(32),
              output_index: 0,
              address: "addr_test1ref",
              amount: [
                { unit: "lovelace", quantity: "2000000" },
                { unit: asset, quantity: "1" },
              ],
              inline_datum: "d87980", // Constr 0 [] — placeholder
              reference_script_hash: null,
            },
          ],
        },
      ],
      [`${BASE}/addresses/addr_test1ref/utxos?page=2&order=asc`, { json: [] }],
    ]);
    const { provider: p } = provider(responses);
    const utxo: Utxo = await p.getReferenceUtxo(policy, name);
    expect(utxo.assets[asset]).toBe(1n);
    expect(utxo.ref.outputIndex).toBe(0);
    expect(utxo.inlineDatum).toBe("d87980");
  });

  it("getReferenceUtxo throws when the NFT isn't held anywhere", async () => {
    const policy = "00".repeat(28);
    const name = "00";
    const asset = `${policy}${name}`;
    const responses = new Map<string, MockResponseBody | MockResponseBody[]>([
      [`${BASE}/assets/${asset}/addresses`, { status: 404, text: "no" }],
    ]);
    const { provider: p } = provider(responses);
    await expect(p.getReferenceUtxo(policy, name)).rejects.toThrow(/not found/);
  });

  it("awaitConfirmation resolves once the tx appears", async () => {
    const txId = "ff".repeat(32);
    const responses = new Map<string, MockResponseBody | MockResponseBody[]>([
      [
        `${BASE}/txs/${txId}`,
        [
          { status: 404, text: "" },
          { status: 404, text: "" },
          { json: { hash: txId } },
        ],
      ],
    ]);
    const { provider: p } = provider(responses);
    await expect(p.awaitConfirmation(txId, 1_000)).resolves.toBeUndefined();
  });

  it("awaitConfirmation rejects after timeoutMs", async () => {
    const txId = "00".repeat(32);
    const responses = new Map<string, MockResponseBody | MockResponseBody[]>([
      [
        `${BASE}/txs/${txId}`,
        [
          { status: 404, text: "" },
          { status: 404, text: "" },
          { status: 404, text: "" },
          { status: 404, text: "" },
          { status: 404, text: "" },
        ],
      ],
    ]);
    const { provider: p } = provider(responses);
    await expect(p.awaitConfirmation(txId, 5)).rejects.toThrow(/not seen/);
  });

  it("getProtocolParameters maps Blockfrost fields into NetworkProtocolParameters", async () => {
    const responses = new Map([
      [
        `${BASE}/epochs/latest/parameters`,
        {
          json: {
            min_fee_a: 44,
            min_fee_b: 155381,
            max_tx_size: 16384,
            coins_per_utxo_size: "4310",
            max_tx_ex_steps: "10000000000",
            max_tx_ex_mem: "14000000",
            price_step: 0.0000721,
            price_mem: 0.0577,
            cost_models: { PlutusV3: [100, 200, 300] },
          },
        },
      ],
    ]);
    const { provider: p } = provider(responses);
    const params = await p.getProtocolParameters();
    expect(params.minFeeA).toBe(44);
    expect(params.minFeeB).toBe(155_381);
    expect(params.utxoCostPerByte).toBe(4_310n);
    expect(params.maxTxExSteps).toBe(10_000_000_000n);
    expect(params.maxTxExMem).toBe(14_000_000n);
    expect(params.costModels.PlutusV3).toEqual([100, 200, 300]);
    expect(params.network).toBe("preprod");
  });

  it("rejects construction when no fetch is available", () => {
    const realFetch = (globalThis as { fetch?: unknown }).fetch;
    delete (globalThis as { fetch?: unknown }).fetch;
    try {
      expect(() =>
        new BlockfrostProvider({
          baseUrl: BASE,
          projectId: "x",
        }),
      ).toThrow(/no fetch implementation/);
    } finally {
      (globalThis as { fetch?: unknown }).fetch = realFetch;
    }
  });
});
