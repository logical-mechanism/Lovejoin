// Unit tests for BlockfrostHistoryClient — the HTTP-shape parsing layer
// that translates Blockfrost's `/addresses/{addr}/transactions` +
// `/txs/{tx}/utxos` into the `DbSyncClient.addressHistory` shape.

import { describe, expect, it } from "vitest";

import {
  BlockfrostHistoryClient,
  type FetchFn,
} from "../src/db/blockfrost-history.js";

const ADDR = "addr_test1qprx";
const PROJECT_ID = "preprodtestkey";
const BASE_URL = "https://cardano-preprod.blockfrost.io/api/v0";

interface Routes {
  [path: string]: { status: number; body: unknown };
}

function mockFetch(routes: Routes, calls: string[] = []): FetchFn {
  return async (input, init) => {
    calls.push(input);
    expect(init?.headers?.["project_id"]).toBe(PROJECT_ID);
    const path = input.replace(BASE_URL, "");
    const route = routes[path];
    if (!route) {
      return {
        ok: false,
        status: 500,
        statusText: "no route",
        async text() {
          return `unmocked path ${path}`;
        },
        async json() {
          throw new Error(`unmocked path ${path}`);
        },
      };
    }
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      statusText: "",
      async text() {
        return typeof route.body === "string" ? route.body : JSON.stringify(route.body);
      },
      async json() {
        return route.body;
      },
    };
  };
}

describe("BlockfrostHistoryClient.addressHistory", () => {
  it("returns Blockfrost results in db-sync shape, sorted desc by tx", async () => {
    const calls: string[] = [];
    const routes: Routes = {
      [`/addresses/${ADDR}/transactions?count=5&order=desc`]: {
        status: 200,
        body: [
          {
            tx_hash: "aa".repeat(32),
            tx_index: 0,
            block_height: 200,
            block_time: 1_750_000_000,
          },
          {
            tx_hash: "bb".repeat(32),
            tx_index: 1,
            block_height: 199,
            block_time: 1_749_900_000,
          },
        ],
      },
      [`/txs/${"aa".repeat(32)}/utxos`]: {
        status: 200,
        body: {
          outputs: [
            // Output to our address: 7 ADA, in two amounts.
            {
              address: ADDR,
              amount: [
                { unit: "lovelace", quantity: "5000000" },
                { unit: "lovelace", quantity: "2000000" },
              ],
            },
            // Output to someone else: ignored.
            {
              address: "addr_test1other",
              amount: [{ unit: "lovelace", quantity: "1000000000" }],
            },
            // Native asset on our address: ignored (only lovelace counted).
            {
              address: ADDR,
              amount: [{ unit: "lovelace", quantity: "1500000" }, { unit: "deadbeef", quantity: "10" }],
            },
          ],
        },
      },
      [`/txs/${"bb".repeat(32)}/utxos`]: {
        status: 200,
        body: {
          outputs: [
            { address: ADDR, amount: [{ unit: "lovelace", quantity: "12345678" }] },
          ],
        },
      },
    };
    const client = new BlockfrostHistoryClient({
      baseUrl: BASE_URL,
      projectId: PROJECT_ID,
      fetchFn: mockFetch(routes, calls),
    });
    const rows = await client.addressHistory(ADDR, 5);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.txHash).toBe("aa".repeat(32));
    expect(rows[0]?.blockHeight).toBe(200);
    expect(rows[0]?.blockTime).toBe(new Date(1_750_000_000_000).toISOString());
    // 5_000_000 + 2_000_000 + 1_500_000 = 8_500_000 lovelace at our address.
    expect(rows[0]?.lovelaceReceived).toBe(8_500_000n);
    expect(rows[1]?.txHash).toBe("bb".repeat(32));
    expect(rows[1]?.lovelaceReceived).toBe(12_345_678n);
    // 1 list + 2 per-tx detail = 3 calls.
    expect(calls).toHaveLength(3);
  });

  it("treats 404 from address-tx endpoint as empty history", async () => {
    const routes: Routes = {
      [`/addresses/${ADDR}/transactions?count=10&order=desc`]: { status: 404, body: { error: "Not Found" } },
    };
    const client = new BlockfrostHistoryClient({
      baseUrl: BASE_URL,
      projectId: PROJECT_ID,
      fetchFn: mockFetch(routes),
    });
    const rows = await client.addressHistory(ADDR, 10);
    expect(rows).toEqual([]);
  });

  it("rejects out-of-range limit before issuing any HTTP call", async () => {
    const calls: string[] = [];
    const client = new BlockfrostHistoryClient({
      baseUrl: BASE_URL,
      projectId: PROJECT_ID,
      fetchFn: mockFetch({}, calls),
    });
    await expect(client.addressHistory(ADDR, 0)).rejects.toThrow(/limit/);
    await expect(client.addressHistory(ADDR, 501)).rejects.toThrow(/limit/);
    expect(calls).toHaveLength(0);
  });

  it("propagates non-2xx errors from list endpoint", async () => {
    const routes: Routes = {
      [`/addresses/${ADDR}/transactions?count=5&order=desc`]: {
        status: 429,
        body: { error: "Too many requests" },
      },
    };
    const client = new BlockfrostHistoryClient({
      baseUrl: BASE_URL,
      projectId: PROJECT_ID,
      fetchFn: mockFetch(routes),
    });
    await expect(client.addressHistory(ADDR, 5)).rejects.toThrow(/429/);
  });
});
