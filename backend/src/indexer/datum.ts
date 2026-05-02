// Plutus-Data CBOR decoder for `MixDatum { a, b }`.
//
// Spec: docs/spec/03-contracts.md §"Datums" — `MixDatum` is `Constr 0
// [bytes(48), bytes(48)]`. The off-chain SDK encodes it as definite-length
// CBOR (cbor-x), but the Aiken validator's canonicalisation step (see
// the M4 commits "use canonical indef-length array form for MixDatum in
// Mix ctx" and "pre-uncompress sigma-OR statements in mix_logic")
// produces an indef-length form. Either form may appear on chain
// depending on which path produced the UTxO. The decoder here accepts
// both and reconstructs the same logical (a, b).
//
// We hand-roll the decoder rather than pull cbor-x (the SDK's choice) so
// the backend has zero crypto-stack dependencies. A 100-line decoder is
// cheaper than carrying cbor-x's load + ESM headaches into a long-lived
// service. The supported subset:
//
//   - tag 121 + n (Plutus Constr n) over a definite or indef-length array
//   - byte strings (major type 2)
//   - unsigned ints (major type 0) up to 2^64 — for parser robustness only
//
// Anything outside that subset throws — the caller treats malformed
// datums as "ignore this UTxO" so a single bad datum can't crash the
// indexer.

const MAJOR_UNSIGNED_INT = 0;
const MAJOR_BYTE_STRING = 2;
const MAJOR_ARRAY = 4;
const MAJOR_TAG = 6;
const _MAJOR_FLOAT_OR_BREAK = 7;

const CBOR_BREAK = 0xff;

/** A `MixDatum` decoded from Plutus-Data CBOR. */
export interface DecodedMixDatum {
  a: Uint8Array; // 48 bytes
  b: Uint8Array; // 48 bytes
}

/**
 * Decode a Plutus-Data CBOR `MixDatum`. Returns `null` if the bytes do
 * not parse as `Constr 0 [bytes(48), bytes(48)]` with `a != b`. The
 * indexer treats `null` as "unrecognised box, skip" so the caller can
 * keep going on malformed inputs.
 */
export function tryDecodeMixDatum(cborHex: string): DecodedMixDatum | null {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(cborHex);
  } catch {
    return null;
  }
  try {
    const reader = new CborReader(bytes);
    const value = reader.readValue();
    if (!reader.eof()) return null;
    if (!isConstr0(value)) return null;
    const fields = value.fields;
    if (fields.length !== 2) return null;
    const a = fields[0];
    const b = fields[1];
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return null;
    if (a.length !== 48 || b.length !== 48) return null;
    if (bytesEqual(a, b)) return null;
    return { a, b };
  } catch {
    return null;
  }
}

/** Internal — a Plutus Constr decoded as `{ tag, fields }`. */
interface ConstrValue {
  __plutusConstr: true;
  tag: number;
  fields: unknown[];
}

function isConstr0(v: unknown): v is ConstrValue {
  return (
    v !== null &&
    typeof v === "object" &&
    (v as ConstrValue).__plutusConstr === true &&
    (v as ConstrValue).tag === 0
  );
}

class CborReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  eof(): boolean {
    return this.offset >= this.bytes.length;
  }

  readValue(): unknown {
    const initial = this.peekByte();
    const major = initial >> 5;
    if (major === MAJOR_TAG) {
      return this.readTaggedValue();
    }
    if (major === MAJOR_ARRAY) {
      return this.readArrayValue();
    }
    if (major === MAJOR_BYTE_STRING) {
      return this.readByteString();
    }
    if (major === MAJOR_UNSIGNED_INT) {
      return this.readUnsignedInt();
    }
    throw new Error(`unsupported CBOR major type ${major}`);
  }

  private readTaggedValue(): ConstrValue {
    const tagBig = this.readUnsignedHeaderValue(MAJOR_TAG);
    if (tagBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`CBOR tag ${tagBig} exceeds safe integer range`);
    }
    const tag = Number(tagBig);
    const inner = this.readValue();
    if (!Array.isArray(inner)) {
      throw new Error("Plutus Constr requires array payload");
    }
    if (tag >= 121 && tag <= 127) {
      return { __plutusConstr: true, tag: tag - 121, fields: inner };
    }
    if (tag >= 1280 && tag <= 1400) {
      return { __plutusConstr: true, tag: tag - 1280 + 7, fields: inner };
    }
    if (tag === 102) {
      // Generic Constr — payload is `[tag, [fields...]]`.
      if (inner.length !== 2 || typeof inner[0] !== "number") {
        throw new Error("generic Constr (tag 102) malformed");
      }
      return {
        __plutusConstr: true,
        tag: inner[0],
        fields: inner[1] as unknown[],
      };
    }
    throw new Error(`unsupported CBOR tag ${tag}`);
  }

  private readArrayValue(): unknown[] {
    const initial = this.bytes[this.offset];
    if (initial === undefined) throw new Error("EOF in CBOR array header");
    if (initial === 0x9f) {
      this.offset += 1;
      const out: unknown[] = [];
      while (true) {
        if (this.peekByte() === CBOR_BREAK) {
          this.offset += 1;
          return out;
        }
        out.push(this.readValue());
      }
    }
    const length = this.readUnsignedHeaderValue(MAJOR_ARRAY);
    if (length > Number.MAX_SAFE_INTEGER) {
      throw new Error("array length exceeds safe integer");
    }
    const out: unknown[] = [];
    for (let i = 0; i < Number(length); i++) {
      out.push(this.readValue());
    }
    return out;
  }

  private readByteString(): Uint8Array {
    const initial = this.bytes[this.offset];
    if (initial === undefined) throw new Error("EOF in CBOR bytes header");
    if (initial === 0x5f) {
      // indef-length byte string — concatenate chunks.
      this.offset += 1;
      const chunks: Uint8Array[] = [];
      while (true) {
        if (this.peekByte() === CBOR_BREAK) {
          this.offset += 1;
          let total = 0;
          for (const c of chunks) total += c.length;
          const out = new Uint8Array(total);
          let cursor = 0;
          for (const c of chunks) {
            out.set(c, cursor);
            cursor += c.length;
          }
          return out;
        }
        const chunk = this.readByteString();
        chunks.push(chunk);
      }
    }
    const length = this.readUnsignedHeaderValue(MAJOR_BYTE_STRING);
    if (length > Number.MAX_SAFE_INTEGER) {
      throw new Error("bytes length exceeds safe integer");
    }
    const n = Number(length);
    if (this.offset + n > this.bytes.length) {
      throw new Error("EOF in CBOR byte string body");
    }
    const out = this.bytes.slice(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  private readUnsignedInt(): number | bigint {
    const v = this.readUnsignedHeaderValue(MAJOR_UNSIGNED_INT);
    if (v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(v);
    return v;
  }

  private readUnsignedHeaderValue(expectedMajor: number): bigint {
    const initial = this.bytes[this.offset];
    if (initial === undefined) throw new Error("EOF reading CBOR header");
    const major = initial >> 5;
    if (major !== expectedMajor) {
      throw new Error(`expected major ${expectedMajor}, got ${major}`);
    }
    const additional = initial & 0x1f;
    this.offset += 1;
    if (additional < 24) return BigInt(additional);
    if (additional === 24) return BigInt(this.readBytesBigEndian(1));
    if (additional === 25) return BigInt(this.readBytesBigEndian(2));
    if (additional === 26) return BigInt(this.readBytesBigEndian(4));
    if (additional === 27) return this.readBytesBigEndianBigint(8);
    if (additional === 31) {
      throw new Error("indef-length not allowed in this header context");
    }
    throw new Error(`reserved CBOR additional ${additional}`);
  }

  private readBytesBigEndian(n: number): number {
    if (this.offset + n > this.bytes.length) throw new Error("EOF in CBOR header value");
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v << 8) | this.bytes[this.offset + i]!;
    }
    this.offset += n;
    return v >>> 0;
  }

  private readBytesBigEndianBigint(n: number): bigint {
    if (this.offset + n > this.bytes.length) throw new Error("EOF in CBOR header value");
    let v = 0n;
    for (let i = 0; i < n; i++) {
      v = (v << 8n) | BigInt(this.bytes[this.offset + i]!);
    }
    this.offset += n;
    return v;
  }

  private peekByte(): number {
    const b = this.bytes[this.offset];
    if (b === undefined) throw new Error("EOF peeking CBOR");
    return b;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (cleaned.length % 2 !== 0) throw new Error("hex string must have even length");
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(v)) throw new Error(`bad hex at offset ${i * 2}`);
    out[i] = v;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
