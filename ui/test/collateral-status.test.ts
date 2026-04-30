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
    const r = await probeCollateralProvider("https://www.giveme.my/preprod/collateral/", fetchFn);
    expect(r.status).toBe("online");
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]![0]).toBe("https://www.giveme.my/known_hosts/");
  });

  it("reports 'down' on a 503", async () => {
    const fetchFn = vi.fn(
      async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response,
    );
    const r = await probeCollateralProvider("https://www.giveme.my/preprod/collateral/", fetchFn);
    expect(r.status).toBe("down");
    expect(r.errorMessage).toContain("503");
  });

  it("reports 'down' on a network error and surfaces the message", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await probeCollateralProvider("https://www.giveme.my/preprod/collateral/", fetchFn);
    expect(r.status).toBe("down");
    expect(r.errorMessage).toBe("ECONNREFUSED");
  });

  it("probes the host root's known_hosts/, ignoring per-network sub-paths", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
    );
    await probeCollateralProvider("https://www.giveme.my/preprod/collateral/", fetchFn);
    expect(fetchFn.mock.calls[0]![0]).toBe("https://www.giveme.my/known_hosts/");
  });

  it("reports 'down' when the configured endpoint isn't a parseable URL", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    const r = await probeCollateralProvider("not-a-url", fetchFn);
    expect(r.status).toBe("down");
    expect(r.errorMessage).toBe("endpoint is not a valid URL");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
