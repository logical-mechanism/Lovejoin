// Unit tests for tx/params.ts.
//
// Two surfaces under test: (1) `parseUtxoRef` round-trips with `formatUtxoRef`
// and rejects malformed strings; (2) `decodeReferenceDatum` decodes the
// canonical Plutus-Data CBOR produced by the bootstrap ceremony into a typed
// ProtocolParams. The fixture below is the actual datum from
// artifacts/preprod/reference_datum.json — encoding it via cbor-x with the
// Plutus tag 121 simulates exactly what the chain provider returns.

import { describe, expect, it } from "vitest";
import { Encoder, Tag } from "cbor-x";

import {
  decodeReferenceDatum,
  fetchProtocolParams,
  formatUtxoRef,
  parseUtxoRef,
} from "../../src/tx/params.js";
import type { LovejoinAddresses } from "../../src/tx/params.js";
import type { ChainProvider, Utxo } from "../../src/chain/provider.js";

function bytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`bad hex length ${hex.length}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Build the canonical Plutus-Data CBOR for the reference datum. */
function buildReferenceDatumCborHex(fields: unknown[]): string {
  const enc = new Encoder();
  const tagged = new Tag(fields, 121);
  return bytesToHex(enc.encode(tagged));
}

const SAMPLE_FIELDS = [
  10_000_000n,
  800_000n,
  bytes("ba176a7604f3e062a7ed315780801495ed0ffb0191c6f8e7d88362e2"), // mix_box
  bytes("ca2d95fe9fe368e8ad1c89e2009a5ad292ff016e353144ea0ef829ff"), // mix_logic
  bytes("5efd8fdd7e4d35b04de427337220dcb30352136d739055b305dd2d66"), // fee_contract
];

describe("tx/params — parseUtxoRef / formatUtxoRef", () => {
  it("round-trips a valid <txid>#<index>", () => {
    const s = "b809b4e363067886174b57fd04101eb2e59f654220b6c11530c77b75f25ec945#0";
    expect(formatUtxoRef(parseUtxoRef(s))).toBe(s);
  });

  it("supports non-zero output indexes", () => {
    const s = "5d9a9e2c26aeffcddb0d0f6e4cc07b62df546a8615bd5bd2aca673561e3600b6#42";
    const ref = parseUtxoRef(s);
    expect(ref.outputIndex).toBe(42);
  });

  it.each([
    "no-hash",
    "abc#",
    "#0",
    "deadbeef#0", // tx hash is too short
    "5d9a9e2c26aeffcddb0d0f6e4cc07b62df546a8615bd5bd2aca673561e3600b6#-1",
    "5d9a9e2c26aeffcddb0d0f6e4cc07b62df546a8615bd5bd2aca673561e3600b6#abc",
  ])("rejects malformed input %s", (s) => {
    expect(() => parseUtxoRef(s)).toThrow();
  });

  it("normalizes mixed-case txids to lowercase", () => {
    const upper = "B809B4E363067886174B57FD04101EB2E59F654220B6C11530C77B75F25EC945#0";
    expect(parseUtxoRef(upper).txId).toBe(upper.split("#")[0]!.toLowerCase());
  });
});

describe("tx/params — decodeReferenceDatum", () => {
  it("decodes the canonical Plutus-Data CBOR", () => {
    const hex = buildReferenceDatumCborHex(SAMPLE_FIELDS);
    const params = decodeReferenceDatum(hex);
    expect(params.denomLovelace).toBe(10_000_000n);
    expect(params.maxFeePerMixLovelace).toBe(800_000n);
    expect(params.mixScriptHash).toBe("ba176a7604f3e062a7ed315780801495ed0ffb0191c6f8e7d88362e2");
    expect(params.mixLogicScriptHash).toBe("ca2d95fe9fe368e8ad1c89e2009a5ad292ff016e353144ea0ef829ff");
    expect(params.feeScriptHash).toBe("5efd8fdd7e4d35b04de427337220dcb30352136d739055b305dd2d66");
  });

  it("rejects non-Constr-0 datums", () => {
    const enc = new Encoder();
    const hex = bytesToHex(enc.encode(new Tag(SAMPLE_FIELDS, 122))); // Constr 1
    expect(() => decodeReferenceDatum(hex)).toThrow(/Constr 0/);
  });

  it("rejects field-count mismatches", () => {
    const fields = SAMPLE_FIELDS.slice(0, 4); // missing fee_script_hash
    const hex = buildReferenceDatumCborHex(fields);
    expect(() => decodeReferenceDatum(hex)).toThrow(/5 fields/);
  });

  it("rejects malformed script-hash bytes", () => {
    const fields = [...SAMPLE_FIELDS];
    fields[2] = bytes("00"); // 1-byte hash; should be 28 bytes
    const hex = buildReferenceDatumCborHex(fields);
    expect(() => decodeReferenceDatum(hex)).toThrow(/28 bytes/);
  });
});

describe("tx/params — fetchProtocolParams", () => {
  const addresses: LovejoinAddresses = {
    network: "preprod",
    protocol: { denom_lovelace: 10_000_000, max_fee_per_mix_lovelace: 800_000 },
    referenceNftPolicy: "310d0d4ff25e73a4a0442eac873e68810e11c824aa0e858acc56f1df",
    referenceNftAssetName: "6c6f76656a6f696e",
    referenceUtxoRef: "b809b4e363067886174b57fd04101eb2e59f654220b6c11530c77b75f25ec945#0",
    referenceHolderScriptHash: "b58b5869a956266f5a55265829963064cabfeac4dab3c28f46dbc1cc",
    mixLogicScriptHash: "ca2d95fe9fe368e8ad1c89e2009a5ad292ff016e353144ea0ef829ff",
    mixBoxScriptHash: "ba176a7604f3e062a7ed315780801495ed0ffb0191c6f8e7d88362e2",
    feeScriptHash: "5efd8fdd7e4d35b04de427337220dcb30352136d739055b305dd2d66",
    feeShardUtxos: ["34a117d9699e8537529aa093943cdeda6f525fd167a74e6f1bd9229ef805a080#0"],
    referenceScriptUtxos: { mix_box: "ref#0", mix_logic: "ref#1", fee_contract: "ref#2" },
  };

  function utxoWith(datumCborHex: string | null): Utxo {
    return {
      ref: { txId: "b809b4e363067886174b57fd04101eb2e59f654220b6c11530c77b75f25ec945", outputIndex: 0 },
      address: "addr_test1...",
      lovelace: 5_000_000n,
      assets: { ["310d0d4ff25e73a4a0442eac873e68810e11c824aa0e858acc56f1df6c6f76656a6f696e"]: 1n },
      inlineDatum: datumCborHex,
      referenceScript: null,
    };
  }

  function fakeProvider(referenceUtxo: Utxo): ChainProvider {
    return {
      submitTx: async () => "deadbeef",
      getUtxos: async () => [],
      getUtxoByRef: async () => null,
      awaitConfirmation: async () => undefined,
      getReferenceUtxo: async () => referenceUtxo,
      getProtocolParameters: async () => ({} as never),
    };
  }

  it("returns ProtocolParams + the reference UTxO", async () => {
    const datumHex = buildReferenceDatumCborHex(SAMPLE_FIELDS);
    const utxo = utxoWith(datumHex);
    const result = await fetchProtocolParams(addresses, fakeProvider(utxo));
    expect(result.params.denomLovelace).toBe(10_000_000n);
    expect(result.referenceUtxo).toBe(utxo);
  });

  it("throws if the reference UTxO has no inline datum", async () => {
    await expect(fetchProtocolParams(addresses, fakeProvider(utxoWith(null)))).rejects.toThrow(/no inline datum/);
  });

  it("throws on script-hash mismatch between datum and addresses.json", async () => {
    const tampered = [...SAMPLE_FIELDS];
    tampered[2] = bytes("00".repeat(28));
    const utxo = utxoWith(buildReferenceDatumCborHex(tampered));
    await expect(fetchProtocolParams(addresses, fakeProvider(utxo))).rejects.toThrow(/mix_box hash mismatch/);
  });
});
