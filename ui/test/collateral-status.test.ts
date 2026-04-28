// Collateral-provider probe tests.

import { describe, expect, it, vi } from "vitest";

import { probeCollateralProvider } from "../src/lib/collateral-status.js";

describe("probeCollateralProvider", () => {
  it("reports 'unknown' when no endpoint is configured", async () => {
    const r = await probeCollateralProvider(null);
    expect(r.status).toBe("unknown");
  });

  it("reports 'online' on a 200 response", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
    );
    const r = await probeCollateralProvider("https://giveme.my", fetchFn);
    expect(r.status).toBe("online");
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]![0]).toBe("https://giveme.my/health");
  });

  it("reports 'down' on a 503", async () => {
    const fetchFn = vi.fn(
      async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response,
    );
    const r = await probeCollateralProvider("https://giveme.my", fetchFn);
    expect(r.status).toBe("down");
    expect(r.errorMessage).toContain("503");
  });

  it("reports 'down' on a network error and surfaces the message", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await probeCollateralProvider("https://giveme.my", fetchFn);
    expect(r.status).toBe("down");
    expect(r.errorMessage).toBe("ECONNREFUSED");
  });

  it("strips trailing slashes before appending /health", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
    );
    await probeCollateralProvider("https://giveme.my/", fetchFn);
    expect(fetchFn.mock.calls[0]![0]).toBe("https://giveme.my/health");
  });
});
