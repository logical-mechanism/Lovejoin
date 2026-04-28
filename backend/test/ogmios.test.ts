// OgmiosClient JSON-RPC handshake + parsing — exercised against an
// in-memory fake socket. Real-network exercise is part of the M5
// Preprod smoke test and isn't run here.

import { describe, expect, it } from "vitest";

import {
  OgmiosClient,
  blockToDiff,
  type OgmiosSocket,
} from "../src/indexer/ogmios.js";
import type { AddressFilter } from "../src/indexer/state.js";

class FakeSocket implements OgmiosSocket {
  private messageHandlers: ((data: string | Buffer) => void)[] = [];
  private openHandlers: (() => void)[] = [];
  closeHandlers: (() => void)[] = [];
  private errorHandlers: ((err: Error) => void)[] = [];
  sent: string[] = [];

  constructor(private onSendCb: (s: FakeSocket, payload: string) => void) {}

  send(data: string): void {
    this.sent.push(data);
    queueMicrotask(() => this.onSendCb(this, data));
  }
  close(): void {
    for (const h of this.closeHandlers) h();
  }
  on(event: string, listener: (...args: unknown[]) => void): void {
    if (event === "open") this.openHandlers.push(listener as () => void);
    else if (event === "message") this.messageHandlers.push(listener as (d: string) => void);
    else if (event === "close") this.closeHandlers.push(listener as () => void);
    else if (event === "error") this.errorHandlers.push(listener as (e: Error) => void);
  }

  open(): void {
    for (const h of this.openHandlers) h();
  }

  emit(payload: string): void {
    for (const h of this.messageHandlers) h(payload);
  }
}

const FILTER: AddressFilter = {
  mixBoxAddress: "addr_test1mix",
  feeContractAddress: "addr_test1fee",
  referenceNftUnit: "deadbeef".repeat(7) + "6c6f76656a6f696e",
};

describe("OgmiosClient", () => {
  it("opens, finds intersection, then pulls a forward block", async () => {
    const responses: Record<string, (id: number) => string> = {
      findIntersection: (id) =>
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            intersection: { slot: 100, id: "ab".repeat(32) },
            tip: { slot: 200, id: "cd".repeat(32), height: 50 },
          },
        }),
      nextBlock: (id) =>
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            direction: "forward",
            block: {
              slot: 101,
              id: "ef".repeat(32),
              height: 49,
              transactions: [
                {
                  id: "11".repeat(32),
                  inputs: [
                    { transaction: { id: "22".repeat(32) }, index: 0 },
                  ],
                  outputs: [
                    {
                      address: "addr_test1mix",
                      value: { ada: { lovelace: 10_000_000 } },
                      datum: "d87980", // unit datum — not a valid mix datum, indexer will skip
                    },
                  ],
                },
              ],
            },
            tip: { slot: 200, id: "cd".repeat(32), height: 50 },
          },
        }),
    };
    let fakeRef: FakeSocket | null = null;
    const factory = (_url: string): OgmiosSocket => {
      const fake = new FakeSocket((s, payload) => {
        const parsed = JSON.parse(payload) as {
          method: string;
          id: number;
        };
        const responder = responses[parsed.method];
        if (!responder) throw new Error(`unmocked method ${parsed.method}`);
        s.emit(responder(parsed.id));
      });
      fakeRef = fake;
      // Defer the open event so connect()'s promise has a microtask to settle.
      queueMicrotask(() => fake.open());
      return fake;
    };
    const client = new OgmiosClient({
      url: "ws://test",
      filter: FILTER,
      socketFactory: factory,
    });
    await client.connect();
    expect(fakeRef).not.toBeNull();
    const inter = await client.findIntersection(["origin"]);
    expect(inter.intersection).toEqual({ slot: 100, id: "ab".repeat(32) });
    expect(inter.tip).toEqual({ slot: 200, blockHash: "cd".repeat(32), height: 50 });
    const event = await client.next();
    expect(event.kind).toBe("forward");
    if (event.kind !== "forward") throw new Error();
    expect(event.block.slot).toBe(101);
    expect(event.block.height).toBe(49);
    expect(event.block.consumed).toEqual([
      { txId: "22".repeat(32), outputIndex: 0 },
    ]);
    // Output is at mix-box address but datum won't decode → produced array still includes
    // it (filtering by address happens here, datum decoding happens later in state.ts).
    expect(event.block.produced).toHaveLength(1);
    expect(event.block.produced[0]?.address).toBe("addr_test1mix");
    client.close();
  });

  it("surfaces JSON-RPC errors", async () => {
    const factory = (_url: string): OgmiosSocket => {
      const fake = new FakeSocket((s, payload) => {
        const parsed = JSON.parse(payload) as { id: number };
        s.emit(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            error: { code: -32602, message: "Invalid params" },
          }),
        );
      });
      queueMicrotask(() => fake.open());
      return fake;
    };
    const client = new OgmiosClient({
      url: "ws://test",
      filter: FILTER,
      socketFactory: factory,
    });
    await client.connect();
    await expect(client.findIntersection(["origin"])).rejects.toThrow(/Invalid params/);
    client.close();
  });
});

describe("blockToDiff", () => {
  it("filters outputs by address + reference NFT", () => {
    const diff = blockToDiff(
      {
        slot: 1,
        id: "aa".repeat(32),
        height: 1,
        transactions: [
          {
            id: "bb".repeat(32),
            inputs: [],
            outputs: [
              { address: "addr_test1unrelated", value: { ada: { lovelace: 1_000_000 } } },
              { address: "addr_test1mix", value: { ada: { lovelace: 10_000_000 } }, datum: "d87980" },
              { address: "addr_test1fee", value: { ada: { lovelace: 5_000_000 } }, datum: "d87980" },
              {
                address: "addr_test1ref",
                value: {
                  ada: { lovelace: 5_000_000 },
                  ["deadbeef".repeat(7)]: { "6c6f76656a6f696e": 1 },
                },
              },
            ],
          },
        ],
      } as Parameters<typeof blockToDiff>[0],
      FILTER,
    );
    expect(diff.produced.map((p) => p.address)).toEqual([
      "addr_test1mix",
      "addr_test1fee",
      "addr_test1ref",
    ]);
    expect(diff.produced[2]?.assets[FILTER.referenceNftUnit]).toBe(1n);
  });

  it("collects every input as consumed, regardless of where it was at", () => {
    const diff = blockToDiff(
      {
        slot: 5,
        id: "aa".repeat(32),
        height: 5,
        transactions: [
          {
            id: "bb".repeat(32),
            inputs: [
              { transaction: { id: "cc".repeat(32) }, index: 0 },
              { transaction: { id: "dd".repeat(32) }, index: 1 },
            ],
            outputs: [],
          },
        ],
      } as Parameters<typeof blockToDiff>[0],
      FILTER,
    );
    expect(diff.consumed).toEqual([
      { txId: "cc".repeat(32), outputIndex: 0 },
      { txId: "dd".repeat(32), outputIndex: 1 },
    ]);
  });
});
