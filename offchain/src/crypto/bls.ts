// BLS12-381 G1 wrappers for Lovejoin's sigma protocols.
//
// Spec: docs/spec/02-cryptography.md
//   - Curve: BLS12-381 G1 (prime-order subgroup; cofactor handled by uncompress' subgroup check).
//   - Compressed group element: 48 bytes.
//   - Scalar: 32 bytes big-endian, value strictly less than r.
//   - r = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001

import { bls12_381, bls12_381_Fr } from "@noble/curves/bls12-381.js";

const Point = bls12_381.G1.Point;

// G1Point exposes both:
//   * a value (the class constructor — used for `G1Point.ZERO`, etc.)
//   * a type alias for instances (used in function signatures).
// TypeScript merges these under one name when value+type share the identifier.
export const G1Point = Point;
export type G1Point = InstanceType<typeof Point>;

// Scalar field order r.
export const SCALAR_ORDER: bigint = bls12_381_Fr.ORDER;

// Compressed group element size (48 bytes) and scalar serialization size (32 bytes).
export const G1_COMPRESSED_BYTES = 48;
export const SCALAR_BYTES = 32;

// Canonical generator g of G1's prime-order subgroup (compressed bytes from spec).
export const GENERATOR_COMPRESSED: Uint8Array = Point.BASE.toBytes();

export type Scalar = bigint;

/** Encode a non-negative integer as a 32-byte big-endian byte array. */
export function scalarToBytes(s: Scalar): Uint8Array {
  if (s < 0n) throw new Error("scalar must be non-negative");
  if (s >= SCALAR_ORDER) throw new Error("scalar must be strictly less than r");
  const out = new Uint8Array(SCALAR_BYTES);
  let x = s;
  for (let i = SCALAR_BYTES - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** Decode a 32-byte big-endian byte array as a scalar in `Z_r`. Rejects values >= r. */
export function scalarFromBytes(bytes: Uint8Array): Scalar {
  if (bytes.length !== SCALAR_BYTES) {
    throw new Error(`scalar must be exactly ${SCALAR_BYTES} bytes, got ${bytes.length}`);
  }
  let x = 0n;
  for (let i = 0; i < SCALAR_BYTES; i++) {
    x = (x << 8n) | BigInt(bytes[i]!);
  }
  if (x >= SCALAR_ORDER) {
    throw new Error("scalar value is not canonical (>= r)");
  }
  return x;
}

/** Modular reduction by the scalar order; for 32-byte challenge bytes that may be >= r. */
export function reduceScalar(x: bigint): Scalar {
  const m = x % SCALAR_ORDER;
  return m >= 0n ? m : m + SCALAR_ORDER;
}

/** Read a 32-byte big-endian byte array as an unbounded integer (no reduction). */
export function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let x = 0n;
  for (let i = 0; i < bytes.length; i++) {
    x = (x << 8n) | BigInt(bytes[i]!);
  }
  return x;
}

/** Decode a 48-byte compressed G1 element. Throws if not in the prime-order subgroup. */
export function pointFromBytes(bytes: Uint8Array): G1Point {
  if (bytes.length !== G1_COMPRESSED_BYTES) {
    throw new Error(`compressed G1 must be exactly ${G1_COMPRESSED_BYTES} bytes`);
  }
  return Point.fromBytes(bytes);
}

/** Compress a G1 point to its 48-byte canonical encoding. */
export function pointToBytes(p: G1Point): Uint8Array {
  return p.toBytes();
}

/** Scalar multiplication: [k]P. Accepts k in `Z_r` (0 ≤ k < r). */
export function scalarMul(k: Scalar, p: G1Point): G1Point {
  if (k === 0n) {
    // noble's `multiply` rejects 0; return the zero element explicitly.
    return Point.ZERO;
  }
  return p.multiply(k);
}

/** Group addition: P + Q. */
export function pointAdd(p: G1Point, q: G1Point): G1Point {
  return p.add(q);
}

/** Group subtraction: P - Q. */
export function pointSub(p: G1Point, q: G1Point): G1Point {
  return p.subtract(q);
}

/** Group equality. */
export function pointEqual(p: G1Point, q: G1Point): boolean {
  return p.equals(q);
}

/**
 * True iff `p` is the group identity (point at infinity).
 *
 * The identity point is reachable only via `[0]·anything`. Lovejoin's
 * deposit path forbids `x = 0` and `d = 0` upstream, so neither `a =
 * [d]·g` nor `b = [x]·a` should ever be the identity. We still expose
 * this so the deposit planner can assert defense-in-depth before the
 * datum hits the chain: if `b == identity` ever slipped through, the
 * Schnorr equation `[z]·a == t + [c]·b` would degenerate to `[z]·a ==
 * t`, letting anyone forge an Owner proof for the box (audit F-3).
 */
export function isIdentity(p: G1Point): boolean {
  return p.equals(Point.ZERO);
}

/** Returns the canonical generator g. */
export function generator(): G1Point {
  return Point.BASE;
}
