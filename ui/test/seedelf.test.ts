// Seedelf-detection tests — exercise the address classifier across the
// CIP-19 address types the Withdraw screen will see.
//
// The classifier ships in the UI because the Withdraw screen accepts a
// user-supplied destination, which can be any CIP-19 shape. The SDK only
// builds enterprise script addresses (the protocol perimeter pins
// `stake_credential == None`), so the base-script-key fixture below is
// hand-rolled rather than borrowed from the SDK builder.

import { describe, expect, it } from "vitest";

import { buildScriptAddress } from "@lovejoin/sdk";

import {
  classifyAddress,
  looksLikeCardanoAddress,
  validateDestination,
} from "../src/lib/seedelf.js";

const SCRIPT_HASH_28 = "ba176a7604f3e062a7ed315780801495ed0ffb0191c6f8e7d88362e2";

// CIP-19 base address (header type 0001) for SCRIPT_HASH_28 paired with
// stake-key hash 1e3105f23f2ac91b3fb4c35fa4fe301421028e356e114944e902005b
// on testnet, computed via the standard bech32 encode of:
//   header (0x10) || script_hash (28) || stake_hash (28).
// Verified against `cardano-cli conway address build
//   --payment-script-hash <SCRIPT_HASH_28>
//   --stake-verification-key-hash <STAKE_HASH_28>
//   --testnet-magic 1`.
const PREPROD_BASE_SCRIPT_KEY_ADDR =
  "addr_test1zzapw6nkqne7qc48a5c40qyqzj276rlmqxgud788mzpk9cs7xyzly0e2eydnldxrt7j0uvq5yypgudtwz9y5f6gzqpdsnh3uy4";

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
    // Withdraw destinations can still be base-script-key shapes even
    // though the SDK never produces them — the classifier must keep
    // recognising the shape so withdraws to such addresses work.
    const k = classifyAddress(PREPROD_BASE_SCRIPT_KEY_ADDR);
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

describe("validateDestination", () => {
  it("returns empty for an empty input", () => {
    expect(validateDestination("", "preprod").status).toBe("empty");
    expect(validateDestination("   ", "preprod").status).toBe("empty");
  });

  it("returns invalid for non-bech32 garbage", () => {
    const r = validateDestination("not-an-address", "preprod");
    expect(r.status).toBe("invalid");
  });

  it("returns invalid for a stake address (can't receive payments)", () => {
    const r = validateDestination(
      "stake_test1uqg69wzlfppt0jjrr3ufu5ekzfrxk69eedmphfu7lt7zhps5w8gvm",
      "preprod",
    );
    expect(r.status).toBe("invalid");
  });

  it("returns ok for a testnet address on preprod", () => {
    const addr = buildScriptAddress(SCRIPT_HASH_28, 0);
    const r = validateDestination(addr, "preprod");
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.kind.kind).toBe("stealth");
  });

  it("flags a testnet address as wrong-network when mainnet expected", () => {
    const addr = buildScriptAddress(SCRIPT_HASH_28, 0);
    const r = validateDestination(addr, "mainnet");
    expect(r.status).toBe("wrong-network");
    if (r.status === "wrong-network") {
      expect(r.addressNetwork).toBe("testnet");
      expect(r.expected).toBe("mainnet");
    }
  });

  it("flags a mainnet address as wrong-network when preprod expected", () => {
    const addr = buildScriptAddress(SCRIPT_HASH_28, 1);
    const r = validateDestination(addr, "preprod");
    expect(r.status).toBe("wrong-network");
    if (r.status === "wrong-network") {
      expect(r.addressNetwork).toBe("mainnet");
    }
  });

  it("treats preview as testnet (same HRP family as preprod)", () => {
    const addr = buildScriptAddress(SCRIPT_HASH_28, 0);
    expect(validateDestination(addr, "preview").status).toBe("ok");
  });
});
