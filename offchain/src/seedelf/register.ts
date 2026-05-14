// Seedelf Register datum + re-randomization.
//
// Spec: Seedelf-Wallet contracts/lib/schnorr.ak (`Register { generator,
// public_value }`) and core/src/register.rs.
//
// A Seedelf register is the pair `(generator, public_value)` where
// `public_value = generator^x` for some secret scalar `x`. Compared to a
// Lovejoin mix-box's `MixDatum { a, b }`:
//   - Datum shape is structurally identical (Constr 0 with two 48-byte
//     compressed G1 elements), but the field role is different: the
//     "generator" is itself re-randomized on each transfer, not held
//     fixed to the canonical G1 base.
//   - Ownership check is the same equation `[x]·generator == public_value`,
//     so `pointEqual(scalarMul(x, g), u)` from offchain/src/crypto/bls.ts
//     is the test.
//
// Re-randomization: given a register `(g, u)` and a fresh scalar `d`,
// produce `(g^d, u^d)`. The result is a valid register for the same secret
// scalar `x` (since `(g^d)^x = (g^x)^d = u^d`). ECDDH protects the link.

import { Encoder, Tag, decode as cborDecode } from "cbor-x";

import {
  G1_COMPRESSED_BYTES,
  type G1Point,
  type Scalar,
  generator,
  isIdentity,
  pointEqual,
  pointFromBytes,
  pointToBytes,
  scalarMul,
} from "../crypto/bls.js";

const cborEncoder = new Encoder();

/**
 * The on-chain `Register` datum, mirroring the Aiken type:
 *
 *   pub type Register {
 *     generator: ByteArray,
 *     public_value: ByteArray,
 *   }
 *
 * Both fields are 48-byte compressed G1 elements.
 */
export interface SeedelfRegister {
  /** Compressed G1 element (48 bytes). */
  generator: Uint8Array;
  /** Compressed G1 element (48 bytes); `generator^x` for owner secret x. */
  publicValue: Uint8Array;
}

export const REGISTER_FIELD_BYTES = G1_COMPRESSED_BYTES;

function assertRegisterBytes(r: SeedelfRegister): void {
  if (r.generator.length !== REGISTER_FIELD_BYTES) {
    throw new Error(
      `seedelf register: generator must be ${REGISTER_FIELD_BYTES} bytes, got ${r.generator.length}`,
    );
  }
  if (r.publicValue.length !== REGISTER_FIELD_BYTES) {
    throw new Error(
      `seedelf register: public_value must be ${REGISTER_FIELD_BYTES} bytes, got ${r.publicValue.length}`,
    );
  }
}

/**
 * Build a fresh register for owner secret `x`. The generator is the
 * canonical G1 base. The caller normally re-randomizes the result before
 * publishing on-chain — see {@link rerandomizeRegister} — so the canonical
 * generator is never observed in the wild.
 */
export function createRegister(x: Scalar): SeedelfRegister {
  const g = generator();
  const u = scalarMul(x, g);
  if (isIdentity(u)) {
    // x = 0 mod r would produce identity. deriveSeedelfSecret already
    // rejects zero, but defense-in-depth — a zero u is unspendable.
    throw new Error("seedelf register: public_value is identity (x must not be zero)");
  }
  return { generator: pointToBytes(g), publicValue: pointToBytes(u) };
}

/**
 * Re-randomize a register: `(g, u) → (g^d, u^d)`. The result holds the
 * same secret `x` (since `(g^d)^x = u^d`) but the pair is computationally
 * unlinkable to the original under ECDDH.
 *
 * `d` must be a non-zero scalar in `[1, r)`. The Sigmajoin/Seedelf threat
 * model treats `d` as toxic waste — the caller must drop it after use
 * (don't log, don't persist).
 */
export function rerandomizeRegister(reg: SeedelfRegister, d: Scalar): SeedelfRegister {
  assertRegisterBytes(reg);
  if (d === 0n) {
    throw new Error("seedelf register: rerandomization scalar must be non-zero");
  }
  const g: G1Point = pointFromBytes(reg.generator);
  const u: G1Point = pointFromBytes(reg.publicValue);
  const gd = scalarMul(d, g);
  const ud = scalarMul(d, u);
  if (isIdentity(gd) || isIdentity(ud)) {
    // Only reachable if d is congruent to 0 mod r — already guarded
    // above but kept as a belt-and-braces check.
    throw new Error("seedelf register: re-randomized element is identity");
  }
  return { generator: pointToBytes(gd), publicValue: pointToBytes(ud) };
}

/**
 * True iff the supplied secret unlocks the register: `[x]·g == u`. This is
 * the same predicate the on-chain Schnorr verifier ultimately enforces,
 * so a `false` result here means a spend attempt would fail validation.
 */
export function ownsSeedelfRegister(reg: SeedelfRegister, x: Scalar): boolean {
  assertRegisterBytes(reg);
  let g: G1Point;
  let u: G1Point;
  try {
    g = pointFromBytes(reg.generator);
    u = pointFromBytes(reg.publicValue);
  } catch {
    return false;
  }
  return pointEqual(scalarMul(x, g), u);
}

/**
 * Encode a register as canonical Plutus-Data CBOR (Constr 0 [bytes(48),
 * bytes(48)]). This is the bytes that go into the UTxO's inline datum.
 *
 * Layout matches Aiken's `serialise_data(Register { generator,
 * public_value })`. CBOR tag 121 + 0 = 121 for Plutus Constr 0.
 */
export function encodeRegisterDatum(reg: SeedelfRegister): string {
  assertRegisterBytes(reg);
  const tag = new Tag([Buffer.from(reg.generator), Buffer.from(reg.publicValue)], 121);
  return bytesToHex(cborEncoder.encode(tag));
}

/**
 * Decode a Plutus-Data CBOR-hex inline datum into a register. Returns
 * null on any structural defect (wrong tag, wrong field count, wrong
 * field length) — Seedelf's spend validator tolerates malformed datums
 * by simply refusing to spend them, so an off-chain decoder mirrors
 * that by returning null rather than throwing for "this UTxO isn't a
 * register".
 */
export function decodeRegisterDatum(cborHex: string): SeedelfRegister | null {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(cborHex);
  } catch {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = cborDecode(bytes);
  } catch {
    return null;
  }
  if (decoded === null || typeof decoded !== "object") return null;
  const tag = (decoded as { tag?: number }).tag;
  const fields = (decoded as { value?: unknown }).value;
  if (tag !== 121) return null;
  if (!Array.isArray(fields) || fields.length !== 2) return null;
  const [g, u] = fields as [unknown, unknown];
  if (!(g instanceof Uint8Array) || !(u instanceof Uint8Array)) return null;
  if (g.length !== REGISTER_FIELD_BYTES || u.length !== REGISTER_FIELD_BYTES) {
    return null;
  }
  return { generator: g, publicValue: u };
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
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
