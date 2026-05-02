// BackendClient unit tests — pure HTTP-shape assertions against a stubbed
// fetch. No live backend is touched.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackendClient } from "../src/lib/backend.js";

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(value: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        ({
          ok: status >= 200 && status < 300,
          status,
          json: async () => value,
        }) as unknown as Response,
    ),
  );
}

describe("BackendClient", () => {
  it("rejects bare URLs without a scheme", () => {
    expect(() => new BackendClient("localhost:3001")).toThrow(/baseUrl/);
  });

  it("returns the parsed health body on 200", async () => {
    const body = {
      ok: true,
      tip: { slot: 1, hash: "ab", blockNo: 2 },
      chainTip: null,
      lagSeconds: 0,
      referenceUtxoOk: true,
      runtimeRunning: true,
      runtimeError: null,
    };
    stubFetch(body);
    const client = new BackendClient("https://example.test");
    expect(await client.health()).toEqual(body);
  });

  it("returns null on a 5xx", async () => {
    stubFetch({}, 500);
    const client = new BackendClient("https://example.test");
    expect(await client.health()).toBeNull();
  });

  it("returns null on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const client = new BackendClient("https://example.test");
    expect(await client.pool()).toBeNull();
  });

  it("appends cursor + limit to /pool when provided", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ tip: null, size: 0, cursor: 0, nextCursor: null, boxes: [] }),
        } as unknown as Response;
      }),
    );
    const client = new BackendClient("https://example.test/");
    await client.pool({ cursor: 100, limit: 50 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/pool?");
    expect(seen[0]).toContain("cursor=100");
    expect(seen[0]).toContain("limit=50");
  });
});
