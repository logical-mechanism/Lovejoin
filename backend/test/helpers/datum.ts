// Test helpers — encode `MixDatum { a, b }` to Plutus-Data CBOR. Two
// flavours: the canonical definite-length form the SDK emits, and the
// indefinite-length form Aiken's canonicalisation step produces. The
// indexer's decoder must accept both (see datum.ts).

/**
 * Encode `Constr 0 [bytes(48), bytes(48)]` as definite-length CBOR.
 *
 * Layout (bytes):
 *   d8 79               -- tag 121 (Plutus Constr 0)
 *   82                  -- array(2)
 *   58 30 <48 bytes>    -- byte string of length 48
 *   58 30 <48 bytes>    -- byte string of length 48
 */
export function encodeMixDatumDef(a: Uint8Array, b: Uint8Array): string {
  if (a.length !== 48 || b.length !== 48) throw new Error("a/b must be 48 bytes");
  const out: number[] = [];
  out.push(0xd8, 0x79); // tag 121
  out.push(0x82); // array(2)
  out.push(0x58, 0x30); // bytes(48)
  for (const byte of a) out.push(byte);
  out.push(0x58, 0x30); // bytes(48)
  for (const byte of b) out.push(byte);
  return Buffer.from(out).toString("hex");
}

/**
 * Encode `Constr 0 [bytes(48), bytes(48)]` with an indef-length array
 * (the canonical form Aiken's `canonical_mix_datum` builds when computing
 * the FS context — see contracts/lib/lovejoin/canonical.ak / mix_logic.ak).
 *
 * Layout:
 *   d8 79               -- tag 121
 *   9f                  -- array, indef-length
 *   58 30 <48 bytes>    -- bytes(48)
 *   58 30 <48 bytes>    -- bytes(48)
 *   ff                  -- break
 */
export function encodeMixDatumIndef(a: Uint8Array, b: Uint8Array): string {
  if (a.length !== 48 || b.length !== 48) throw new Error("a/b must be 48 bytes");
  const out: number[] = [];
  out.push(0xd8, 0x79); // tag 121
  out.push(0x9f); // array indef
  out.push(0x58, 0x30);
  for (const byte of a) out.push(byte);
  out.push(0x58, 0x30);
  for (const byte of b) out.push(byte);
  out.push(0xff); // break
  return Buffer.from(out).toString("hex");
}
