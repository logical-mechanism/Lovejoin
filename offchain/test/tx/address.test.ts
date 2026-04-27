// Unit tests for tx/address.ts.
//
// The reference vectors below come from cardano-cli `address build
// --payment-script-file` output for two real script hashes from
// artifacts/preprod/addresses.json. If the bech32 implementation diverges
// from cardano-cli's, these tests fail loudly — and "diverges by one byte"
// is the kind of bug that silently routes funds to the wrong address.

import { describe, expect, it } from "vitest";

import { buildEnterpriseScriptAddress } from "../../src/tx/address.js";

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
