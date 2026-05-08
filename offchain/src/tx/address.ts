// Cardano address construction — bech32 encoding for script addresses.
//
// Spec: CIP-19 (Cardano addresses), BIP-173 (bech32). Lovejoin parks every
// dApp UTxO at a CIP-19 *enterprise* script address (payment = script
// hash, no stake credential). The on-chain validator perimeter
// (audit H-01, May 2026) rejects any continuing protocol output whose
// `stake_credential` is anything other than `None`, so the SDK MUST emit
// enterprise addresses — anything else would be rejected at submission.
//
// Pre-H-01 the SDK emitted *base* script-key addresses with a configured
// dApp stake key, which let the protocol's pool delegate to a chosen
// pool. That capability is gone deliberately: with a payment-only
// address, no party can ever earn rewards from the pool's principal.
//
// Computing addresses off-chain from the script hashes lets the SDK avoid
// eagerly importing mesh's CSL bindings, which fail to load under the
// test harness.
//
// Address format (CIP-19, enterprise + script payment):
//   header   = 0b0111 0000 | networkId
//   payload  = header (1) || scriptHash (28)             → 29 bytes
//   bech32 HRP: "addr_test" for testnet, "addr" for mainnet.
//
// Hand-rolled rather than pulling the `bech32` npm package as a direct dep —
// it's a 60-line algorithm and the spec calls for keeping the SDK
// dependency surface minimal.

const HRP_TESTNET = "addr_test";
const HRP_MAINNET = "addr";
const ENTERPRISE_SCRIPT_HEADER_HIGH_NIBBLE = 0x70; // 0b0111_0000

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/**
 * Build a CIP-19 enterprise script address (payment = script hash, no
 * stake credential).
 *
 * The validator perimeter pins `stake_credential == None` for every
 * continuing protocol output, so this is the only address shape the
 * protocol will accept.
 *
 * @param scriptHashHex 28-byte payment script hash, lowercase hex.
 * @param networkId 0 for testnet (preprod/preview), 1 for mainnet.
 */
export function buildScriptAddress(scriptHashHex: string, networkId: 0 | 1): string {
  const scriptHash = hexToBytes(scriptHashHex);
  if (scriptHash.length !== 28) {
    throw new Error(
      `script address: payment-script hash must be 28 bytes, got ${scriptHash.length}`,
    );
  }
  const hrp = networkId === 0 ? HRP_TESTNET : HRP_MAINNET;
  const header = ENTERPRISE_SCRIPT_HEADER_HIGH_NIBBLE | networkId;
  const payload = new Uint8Array(29);
  payload[0] = header;
  payload.set(scriptHash, 1);
  return bech32Encode(hrp, payload);
}

// ---------------------------------------------------------------------------
// bech32 (BIP-173) — encode-only.
// ---------------------------------------------------------------------------

function bech32Encode(hrp: string, data: Uint8Array): string {
  // Convert raw bytes into 5-bit groups, then bech32-encode them.
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
      throw new Error(`convertBits: value ${value} out of range for ${fromBits}-bit input`);
    }
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    throw new Error("convertBits: lossy conversion without padding");
  }
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
  if (cleaned.length % 2 !== 0) {
    throw new Error("hex string must have even length");
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(v)) throw new Error(`bad hex byte at offset ${i * 2}`);
    out[i] = v;
  }
  return out;
}
