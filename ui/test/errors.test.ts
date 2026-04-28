// Friendly-error-mapper tests — guard against pattern drift as more
// SDK error strings get added.

import { describe, expect, it } from "vitest";

import { friendlyErrorKey, friendlyErrorMessage } from "../src/lib/errors.js";

describe("friendlyErrorKey", () => {
  it("maps fetch-failed to a network error", () => {
    expect(friendlyErrorKey("fetch failed")).toBe("errors.network");
    expect(friendlyErrorKey("Failed to fetch")).toBe("errors.network");
  });

  it("maps a 401 response to blockfrost auth", () => {
    expect(friendlyErrorKey("HTTP 401 Unauthorized")).toBe("errors.blockfrost_auth");
  });

  it("maps a 429 response to a rate-limit message", () => {
    expect(friendlyErrorKey("HTTP 429 Too Many Requests")).toBe(
      "errors.blockfrost_rate",
    );
  });

  it("maps a Plutus script-eval failure", () => {
    expect(friendlyErrorKey("script evaluation failed at index 0")).toBe(
      "errors.script_eval",
    );
  });

  it("maps a wallet-rejected signing prompt", () => {
    expect(friendlyErrorKey("user declined to sign")).toBe("errors.user_rejected");
    expect(friendlyErrorKey("User rejected the request.")).toBe(
      "errors.user_rejected",
    );
  });

  it("returns null for unmapped messages", () => {
    expect(friendlyErrorKey("totally novel error")).toBeNull();
  });
});

describe("friendlyErrorMessage", () => {
  it("returns the translated string when a pattern matches", () => {
    const t = (k: string) => `[${k}]`;
    expect(friendlyErrorMessage("fetch failed", t)).toBe("[errors.network]");
  });

  it("falls back to the raw message when nothing matches", () => {
    const t = (k: string) => `[${k}]`;
    expect(friendlyErrorMessage("totally novel error", t)).toBe(
      "totally novel error",
    );
  });
});
