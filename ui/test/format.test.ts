// formatAda — display-time lovelace → ADA conversion with grouping.

import { describe, expect, it } from "vitest";

import { formatAda } from "../src/lib/format.js";

describe("formatAda", () => {
  it("formats a round denomination with two fraction digits", () => {
    expect(formatAda(5_000_000n)).toBe("5.00");
  });

  it("inserts thousands separators above 1000 ADA", () => {
    expect(formatAda(1_234_000_000n)).toBe("1,234.00");
  });

  it("preserves up to 6 fractional digits when present", () => {
    expect(formatAda(1_234_567n)).toBe("1.234567");
  });

  it("accepts a number argument as well as bigint", () => {
    expect(formatAda(2_500_000)).toBe("2.50");
  });

  it("handles zero", () => {
    expect(formatAda(0n)).toBe("0.00");
  });
});
