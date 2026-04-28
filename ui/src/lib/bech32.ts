// bech32 (BIP-173) decoder — verifies the checksum and returns the raw bytes.
//
// We hand-roll this rather than depend on a separate npm `bech32` package
// for the same reason the SDK does (offchain/src/tx/address.ts): the
// algorithm is ~60 lines and the spec calls for a minimal dependency surface.
// We only need *decode* here; the SDK's address.ts owns the encoding side.

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

const CHARSET_INDEX: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  for (let i = 0; i < BECH32_CHARSET.length; i++) {
    out[BECH32_CHARSET[i]!] = i;
  }
  return out;
})();

export interface DecodedBech32 {
  hrp: string;
  bytes: Uint8Array;
}

/**
 * Decode a bech32 / bech32m string. Returns null on any malformation —
 * checksum mismatch, illegal characters, mixed case, length out of range.
 *
 * Bech32m and plain bech32 share the same character set + group structure.
 * Cardano addresses use plain bech32 (constant 1) — bech32m's constant
 * is 0x2bc830a3. We only return success on plain bech32 so a stray
 * SegWit-style address can't sneak through as a Cardano payment target.
 */
export function bech32Decode(input: string): DecodedBech32 | null {
  if (input.length < 8 || input.length > 1023) return null;
  const lower = input.toLowerCase();
  const upper = input.toUpperCase();
  if (input !== lower && input !== upper) return null; // mixed case is invalid
  const s = lower;
  const sep = s.lastIndexOf("1");
  if (sep < 1 || sep + 7 > s.length) return null;
  const hrp = s.slice(0, sep);
  const dataPart = s.slice(sep + 1);
  for (let i = 0; i < hrp.length; i++) {
    const c = hrp.charCodeAt(i);
    if (c < 33 || c > 126) return null;
  }
  const data: number[] = [];
  for (let i = 0; i < dataPart.length; i++) {
    const ch = dataPart[i]!;
    const v = CHARSET_INDEX[ch];
    if (v === undefined) return null;
    data.push(v);
  }
  if (!verifyChecksum(hrp, data)) return null;
  const payloadGroups = data.slice(0, data.length - 6);
  const bytes = convertBits(payloadGroups, 5, 8, false);
  if (!bytes) return null;
  return { hrp, bytes: new Uint8Array(bytes) };
}

function verifyChecksum(hrp: string, data: number[]): boolean {
  return polymod([...hrpExpand(hrp), ...data]) === 1;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 0x1f);
  return out;
}

function polymod(values: number[]): number {
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

function convertBits(
  data: number[],
  fromBits: number,
  toBits: number,
  pad: boolean,
): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) return null;
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
    return null;
  }
  return out;
}
