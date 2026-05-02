// CIP-19 script-address derivation. Standalone copy of the SDK helper —
// kept here so the backend doesn't import `@lovejoin/sdk` and pull mesh
// + cbor-x into the indexer process. The SDK version is the source of
// truth at offchain/src/tx/address.ts; if behaviour ever drifts, the
// SDK wins (because the SDK is what builds the actual on-chain
// addresses we're trying to recognise here).

const HRP_TESTNET = "addr_test";
const HRP_MAINNET = "addr";
const ENTERPRISE_SCRIPT_HEADER_HIGH_NIBBLE = 0x70;
const BASE_SCRIPT_KEY_HEADER_HIGH_NIBBLE = 0x10;
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

export function buildScriptAddress(
  scriptHashHex: string,
  networkId: 0 | 1,
  stakeKeyHashHex?: string | null,
): string {
  const scriptHash = hexToBytes(scriptHashHex);
  if (scriptHash.length !== 28) {
    throw new Error(
      `script address: payment-script hash must be 28 bytes, got ${scriptHash.length}`,
    );
  }
  const hrp = networkId === 0 ? HRP_TESTNET : HRP_MAINNET;
  if (!stakeKeyHashHex) {
    const header = ENTERPRISE_SCRIPT_HEADER_HIGH_NIBBLE | networkId;
    const payload = new Uint8Array(29);
    payload[0] = header;
    payload.set(scriptHash, 1);
    return bech32Encode(hrp, payload);
  }
  const stakeHash = hexToBytes(stakeKeyHashHex);
  if (stakeHash.length !== 28) {
    throw new Error(`script address: stake-key hash must be 28 bytes, got ${stakeHash.length}`);
  }
  const header = BASE_SCRIPT_KEY_HEADER_HIGH_NIBBLE | networkId;
  const payload = new Uint8Array(57);
  payload[0] = header;
  payload.set(scriptHash, 1);
  payload.set(stakeHash, 29);
  return bech32Encode(hrp, payload);
}

function bech32Encode(hrp: string, data: Uint8Array): string {
  const groups = convertBits(data, 8, 5, true);
  const checksum = bech32CreateChecksum(hrp, groups);
  let out = `${hrp}1`;
  for (const g of groups) out += BECH32_CHARSET[g];
  for (const g of checksum) out += BECH32_CHARSET[g];
  return out;
}

function convertBits(data: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) {
      throw new Error(`convertBits: ${value} out of range for ${fromBits}-bit input`);
    }
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) out.push((acc << (toBits - bits)) & maxv);
  return out;
}

function bech32Polymod(values: number[]): number {
  const generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= generator[i]!;
    }
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 0x1f);
  return out;
}

function bech32CreateChecksum(hrp: string, data: number[]): number[] {
  const values = [...bech32HrpExpand(hrp), ...data];
  const polymod = bech32Polymod([...values, 0, 0, 0, 0, 0, 0]) ^ 1;
  const out: number[] = [];
  for (let i = 0; i < 6; i++) out.push((polymod >> (5 * (5 - i))) & 0x1f);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (cleaned.length % 2 !== 0) throw new Error("hex string must have even length");
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(v)) throw new Error(`bad hex byte at offset ${i * 2}`);
    out[i] = v;
  }
  return out;
}
