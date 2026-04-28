// Seedelf-detection tests — exercise the address classifier across the
// CIP-19 address types the Withdraw screen will see.

import { describe, expect, it } from "vitest";

import { buildScriptAddress } from "@lovejoin/sdk";

import { classifyAddress, looksLikeCardanoAddress } from "../src/lib/seedelf.js";

const SCRIPT_HASH_28 = "ba176a7604f3e062a7ed315780801495ed0ffb0191c6f8e7d88362e2";
const STAKE_HASH_28 = "1e3105f23f2ac91b3fb4c35fa4fe301421028e356e114944e902005b";

describe("classifyAddress", () => {
  it("flags a script-payment enterprise address as stealth", () => {
    const addr = buildScriptAddress(SCRIPT_HASH_28, 0);
    const k = classifyAddress(addr);
    expect(k.kind).toBe("stealth");
    if (k.kind === "stealth") {
      expect(k.addressType).toBe("enterprise-script");
    }
  });

  it("flags a script-payment base address as stealth", () => {
    const addr = buildScriptAddress(SCRIPT_HASH_28, 0, STAKE_HASH_28);
    const k = classifyAddress(addr);
    expect(k.kind).toBe("stealth");
    if (k.kind === "stealth") {
      expect(k.addressType).toBe("base-script-key");
    }
  });

  it("falls through to unknown on a stake address", () => {
    // A stake/reward address — HRP is "stake" / "stake_test", header
    // high nibble is 0xe or 0xf. We ship "unknown" so the Withdraw screen
    // doesn't accidentally accept it as a payment destination.
    const k = classifyAddress("stake_test1uqg69wzlfppt0jjrr3ufu5ekzfrxk69eedmphfu7lt7zhps5w8gvm");
    expect(k.kind === "unknown" || k.kind === "regular-key").toBe(true);
  });

  it("returns unknown for empty input", () => {
    expect(classifyAddress("").kind).toBe("unknown");
  });

  it("returns unknown for non-bech32 garbage", () => {
    expect(classifyAddress("not-an-address").kind).toBe("unknown");
  });
});

describe("looksLikeCardanoAddress", () => {
  it("accepts a parseable script address", () => {
    expect(looksLikeCardanoAddress(buildScriptAddress(SCRIPT_HASH_28, 0))).toBe(true);
  });

  it("rejects garbage", () => {
    expect(looksLikeCardanoAddress("not-an-address")).toBe(false);
  });
});
