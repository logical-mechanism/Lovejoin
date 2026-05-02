// Unit tests for tx/address.ts.
//
// The reference vectors below come from cardano-cli `address build
// --payment-script-file` output for two real script hashes from
// artifacts/preprod/addresses.json. If the bech32 implementation diverges
// from cardano-cli's, these tests fail loudly — and "diverges by one byte"
// is the kind of bug that silently routes funds to the wrong address.

import { describe, expect, it } from "vitest";

import { buildEnterpriseScriptAddress, buildScriptAddress } from "../../src/tx/address.js";

describe("tx/address — buildEnterpriseScriptAddress", () => {
  it("encodes a preprod fee_contract enterprise address", () => {
    // Reference: cardano-cli conway address build --payment-script-file
    //   artifacts/preprod/fee_contract.plutus --testnet-magic 1
    // Script hash from artifacts/preprod/addresses.json.
    const scriptHash = "5efd8fdd7e4d35b04de427337220dcb30352136d739055b305dd2d66";
    const expected = "addr_test1wp00mr7a0exntvzdusnnxu3qmjesx5snd4eeq4dnqhwj6esn2pdrd";
    expect(buildEnterpriseScriptAddress(scriptHash, 0)).toBe(expected);
  });

  it("encodes a preprod mix_box enterprise address", () => {
    // Reference: cardano-cli conway address build --payment-script-file
    //   artifacts/preprod/mix_box.plutus --testnet-magic 1
    const scriptHash = "ba176a7604f3e062a7ed315780801495ed0ffb0191c6f8e7d88362e2";
    const expected = "addr_test1wzapw6nkqne7qc48a5c40qyqzj276rlmqxgud788mzpk9csxv0enu";
    expect(buildEnterpriseScriptAddress(scriptHash, 0)).toBe(expected);
  });

  it("encodes a preprod reference_holder enterprise address", () => {
    // Reference: cardano-cli conway address build --payment-script-file
    //   artifacts/preprod/reference_holder.plutus --testnet-magic 1
    const scriptHash = "b58b5869a956266f5a55265829963064cabfeac4dab3c28f46dbc1cc";
    const expected = "addr_test1wz6ckkrf49tzvm6625n9s2vkxpjv40l2cndt8s50gmdurnqhmdez7";
    expect(buildEnterpriseScriptAddress(scriptHash, 0)).toBe(expected);
  });

  it("uses the mainnet HRP when networkId=1", () => {
    const scriptHash = "5efd8fdd7e4d35b04de427337220dcb30352136d739055b305dd2d66";
    const out = buildEnterpriseScriptAddress(scriptHash, 1);
    expect(out.startsWith("addr1")).toBe(true);
  });

  it("rejects script hashes with the wrong byte length", () => {
    expect(() => buildEnterpriseScriptAddress("ab".repeat(20), 0)).toThrow(/28 bytes/);
    expect(() => buildEnterpriseScriptAddress("ab".repeat(32), 0)).toThrow(/28 bytes/);
  });

  it("tolerates 0x prefix on input", () => {
    const scriptHash = "0x5efd8fdd7e4d35b04de427337220dcb30352136d739055b305dd2d66";
    expect(buildEnterpriseScriptAddress(scriptHash, 0)).toBe(
      "addr_test1wp00mr7a0exntvzdusnnxu3qmjesx5snd4eeq4dnqhwj6esn2pdrd",
    );
  });
});

describe("tx/address — buildScriptAddress (with optional stake key)", () => {
  // Reference vector: cardano-cli conway address build
  //   --payment-script-file artifacts/preprod/fee_contract.plutus
  //   --stake-verification-key-hash 1e3105f23f2ac91b3fb4c35fa4fe301421028e356e114944e902005b
  //   --testnet-magic 1
  // Re-run that command on a Preprod-tooled box to regenerate.
  const FEE_SCRIPT = "5efd8fdd7e4d35b04de427337220dcb30352136d739055b305dd2d66";
  const PREPROD_STAKE = "1e3105f23f2ac91b3fb4c35fa4fe301421028e356e114944e902005b";

  it("falls back to enterprise when no stake hash is given", () => {
    expect(buildScriptAddress(FEE_SCRIPT, 0)).toBe(buildEnterpriseScriptAddress(FEE_SCRIPT, 0));
  });

  it("treats null + undefined as 'no stake' for ergonomics", () => {
    const enterprise = buildEnterpriseScriptAddress(FEE_SCRIPT, 0);
    expect(buildScriptAddress(FEE_SCRIPT, 0, null)).toBe(enterprise);
    expect(buildScriptAddress(FEE_SCRIPT, 0, undefined)).toBe(enterprise);
  });

  it("emits an addr_test1z… base address on testnet when stake hash is set", () => {
    const out = buildScriptAddress(FEE_SCRIPT, 0, PREPROD_STAKE);
    // Type 0001 + network 0 = header 0x10 → bech32 first data char is 'z'.
    expect(out.startsWith("addr_test1z")).toBe(true);
    // Differs from the enterprise variant.
    expect(out).not.toBe(buildEnterpriseScriptAddress(FEE_SCRIPT, 0));
  });

  it("emits an addr1z… base address on mainnet when stake hash is set", () => {
    const mainnetStake = "07ac7dee6c82177096b70ccf21cfb8965c1fb08e079f9ca4af4b2b3e";
    const out = buildScriptAddress(FEE_SCRIPT, 1, mainnetStake);
    expect(out.startsWith("addr1z")).toBe(true);
  });

  it("rejects stake hashes with the wrong byte length", () => {
    expect(() => buildScriptAddress(FEE_SCRIPT, 0, "ab".repeat(20))).toThrow(
      /stake-key hash must be 28 bytes/,
    );
    expect(() => buildScriptAddress(FEE_SCRIPT, 0, "ab".repeat(32))).toThrow(
      /stake-key hash must be 28 bytes/,
    );
  });
});
