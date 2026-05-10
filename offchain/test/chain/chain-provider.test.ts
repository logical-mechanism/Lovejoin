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
  body: string | Uint8Array | undefined;
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

function provider(responses: Map<string, MockResponseBody | MockResponseBody[]>): {
  provider: ChainProvider;
  calls: RecordedCall[];
} {
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
      [
        `${BASE}/tx/submit`,
        { json: "deadbeefcafedeadbeefcafedeadbeefcafedeadbeefcafedeadbeefcafe1234" },
      ],
    ]);
    const { provider: p, calls } = provider(responses);
    const id = await p.submitTx("84a3");
    expect(id).toBe("deadbeefcafedeadbeefcafedeadbeefcafedeadbeefcafedeadbeefcafe1234");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers).toEqual({
      "Content-Type": "application/cbor",
      project_id: "preprod_TEST",
    });
    // Regression guard: the body must be raw bytes (Uint8Array), not the
    // hex string. Browser fetch UTF-8-encodes string bodies, which mangled
    // the CBOR and made Blockfrost reject with "expected list len or
    // indef" on the very first byte.
    expect(calls[0]!.body).toBeInstanceOf(Uint8Array);
    expect(Array.from(calls[0]!.body as Uint8Array)).toEqual([0x84, 0xa3]);
  });

  it("throws on non-ok submit responses", async () => {
    const responses = new Map([
      [
        `${BASE}/tx/submit`,
        { status: 400, statusText: "Bad Request", text: "tx failed validation" },
      ],
    ]);
    const { provider: p } = provider(responses);
    await expect(p.submitTx("84a3")).rejects.toThrow(/400 Bad Request/);
    await expect(p.submitTx("84a3")).rejects.toThrow(/tx failed validation/);
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
      [`${BASE}/addresses/addr_test1xyz/utxos?page=2&order=asc`, { json: [] }],
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
                  unit: "abababababababababababababababababababababababababababab6c6f76656a6f696e",
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
      utxo!.assets["abababababababababababababababababababababababababababab6c6f76656a6f696e"],
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
        [{ status: 404, text: "" }, { status: 404, text: "" }, { json: { hash: txId } }],
      ],
    ]);
    const { provider: p } = provider(responses);
    await expect(p.awaitConfirmation(txId, 1_000)).resolves.toBeUndefined();
  });

  it("awaitConfirmation rejects after timeoutMs", async () => {
    const txId = "00".repeat(32);
    // Use a single MockResponseBody (not an array) so the mock returns
    // the same 404 for every poll iteration — this test only cares
    // that the timeout fires with the right message, not how many
    // polls happened. A finite array was racy on fast CI runners,
    // which could squeeze in one more poll than the array's length.
    const responses = new Map<string, MockResponseBody | MockResponseBody[]>([
      [`${BASE}/txs/${txId}`, { status: 404, text: "" }],
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
      expect(
        () =>
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

describe("BlockfrostProvider.evaluateTxWithAdditionalUtxos", () => {
  // Issue #127: chained-Mix needs the LOCAL evaluator to see in-flight
  // parent outputs. The standard /utils/txs/evaluate?version=6 endpoint
  // doesn't accept additional UTxOs; we route through
  // /utils/txs/evaluate/utxos?version=6 (JSON body) instead.

  const EVAL_JSON_URL = `${BASE}/utils/txs/evaluate/utxos?version=6`;

  it("POSTs cbor + additionalUtxoSet as JSON and translates the response to mesh Action[]", async () => {
    const responses = new Map<string, MockResponseBody | MockResponseBody[]>([
      [
        EVAL_JSON_URL,
        {
          json: {
            result: [
              {
                validator: { purpose: "spend", index: 0 },
                budget: { memory: 1_000_000, cpu: 10_000_000 },
              },
              {
                validator: { purpose: "withdraw", index: 0 },
                budget: { memory: 2_500_000, cpu: 25_000_000 },
              },
            ],
          },
        },
      ],
    ]);
    const { provider: p, calls } = provider(responses);
    const additional = [
      [
        { transaction: { id: "ab".repeat(32) }, index: 0 },
        {
          address: "addr_test1qparent",
          value: { ada: { lovelace: 7_500_000n } },
          datum: "d87980",
        },
      ],
    ] as const;
    const actions = await (p as BlockfrostProvider).evaluateTxWithAdditionalUtxos(
      "84aa00deadbeef",
      additional,
    );
    expect(actions).toEqual([
      { tag: "SPEND", index: 0, budget: { mem: 1_000_000, steps: 10_000_000 } },
      { tag: "REWARD", index: 0, budget: { mem: 2_500_000, steps: 25_000_000 } },
    ]);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe(EVAL_JSON_URL);
    expect(call!.method).toBe("POST");
    expect(call!.headers["Content-Type"]).toBe("application/json");
    expect(call!.headers["project_id"]).toBe("preprod_TEST");
    // Body is the JSON body the upstream Blockfrost endpoint expects.
    const parsed = JSON.parse(call!.body as string);
    expect(parsed.cbor).toBe("84aa00deadbeef");
    expect(parsed.additionalUtxoSet).toEqual([
      [
        { transaction: { id: "ab".repeat(32) }, index: 0 },
        {
          address: "addr_test1qparent",
          value: { ada: { lovelace: 7_500_000 } }, // bigint serialised to number
          datum: "d87980",
        },
      ],
    ]);
  });

  it("surfaces upstream evaluator errors verbatim", async () => {
    const responses = new Map<string, MockResponseBody | MockResponseBody[]>([
      [
        EVAL_JSON_URL,
        {
          json: {
            error: {
              code: 3010,
              message: "missing required scripts",
              data: { missing: ["abc"] },
            },
          },
        },
      ],
    ]);
    const { provider: p } = provider(responses);
    await expect(
      (p as BlockfrostProvider).evaluateTxWithAdditionalUtxos("deadbeef", []),
    ).rejects.toThrow(/missing required scripts/);
  });

  it("throws when an additionalUtxoSet value exceeds Number.MAX_SAFE_INTEGER", async () => {
    // Ogmios serialises out-of-range bigints with a tag rather than a JSON
    // number, but our wire layer uses plain numbers; bail loudly instead
    // of silently truncating.
    const responses = new Map<string, MockResponseBody | MockResponseBody[]>([
      [EVAL_JSON_URL, { json: { result: [] } }],
    ]);
    const { provider: p } = provider(responses);
    await expect(
      (p as BlockfrostProvider).evaluateTxWithAdditionalUtxos("deadbeef", [
        [
          { transaction: { id: "ab".repeat(32) }, index: 0 },
          {
            address: "addr_test1qparent",
            value: { ada: { lovelace: 2n ** 60n } },
          },
        ],
      ]),
    ).rejects.toThrow(/MAX_SAFE_INTEGER/);
  });

  // The "exposed on the mesh sibling" wiring isn't unit-tested because
  // `meshProvider()` triggers the libsodium-wrappers-sumo ESM import,
  // which crashes under pnpm's strict node_modules layout (see
  // CLAUDE.md "Local-dev gotchas"). The attachment is a one-line
  // delegate to the top-level method exercised above; integration tests
  // on Preprod cover the end-to-end mesh path.
});
