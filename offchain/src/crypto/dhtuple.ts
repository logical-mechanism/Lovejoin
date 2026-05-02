// proveDHTuple (Sigmajoin paper §2.2; Lovejoin spec docs/spec/02-cryptography.md).
//
// Statement: prover knows `x ∈ Z_r` such that `u = [x]·g` AND `v = [x]·h`,
// for given `(g, h, u, v)`. In Mix branch terms: g=a, h=b, u=a', v=b', witness y.
//
// Non-interactive (Fiat-Shamir):
//   1. Pick r_p ∈ Z_r (deterministic via RFC 6979).
//   2. (t0, t1) = ([r_p]·g, [r_p]·h).
//   3. c = H(g, h, u, v, t0, t1, ctx) mod r.
//   4. z = r_p + c·x mod r.
//   Proof π = (t0, t1, z).
//
// Verifier: accept iff `[z]·g == t0 + [c]·u` AND `[z]·h == t1 + [c]·v`.

import {
  type G1Point,
  G1_COMPRESSED_BYTES,
  SCALAR_BYTES,
  SCALAR_ORDER,
  type Scalar,
  bytesToBigIntBE,
  pointAdd,
  pointEqual,
  pointFromBytes,
  pointToBytes,
  reduceScalar,
  scalarMul,
  scalarToBytes,
} from "./bls.js";
import { fsHashDHTuple } from "./hash.js";
import { deriveNonce } from "./nonce.js";

export type DHTupleProof = {
  t0: Uint8Array; // 48 bytes ([r_p]·g)
  t1: Uint8Array; // 48 bytes ([r_p]·h)
  z: Uint8Array; // 32 bytes
};

/** Compute the DH-tuple statement points: u = [x]·g, v = [x]·h. */
export function dhPair(g: G1Point, h: G1Point, secret: Scalar): { u: G1Point; v: G1Point } {
  if (secret <= 0n || secret >= SCALAR_ORDER) {
    throw new Error("secret must be in [1, r)");
  }
  return { u: scalarMul(secret, g), v: scalarMul(secret, h) };
}

/**
 * Generate a proveDHTuple proof for (u = [x]·g, v = [x]·h) bound to `ctx`.
 * RFC-6979 deterministic — same (secret, g, h, u, v, ctx) ⇒ byte-identical proof.
 */
export function proveDHTuple(
  g: G1Point,
  h: G1Point,
  secret: Scalar,
  ctx: Uint8Array,
): DHTupleProof {
  const { u, v } = dhPair(g, h, secret);
  const gBytes = pointToBytes(g);
  const hBytes = pointToBytes(h);
  const uBytes = pointToBytes(u);
  const vBytes = pointToBytes(v);

  // Nonce binds to the full statement so distinct (g,h,u,v,ctx) get distinct r_p.
  const msgLen = gBytes.length + hBytes.length + uBytes.length + vBytes.length + ctx.length;
  const nonceMessage = new Uint8Array(msgLen);
  let off = 0;
  nonceMessage.set(gBytes, off);
  off += gBytes.length;
  nonceMessage.set(hBytes, off);
  off += hBytes.length;
  nonceMessage.set(uBytes, off);
  off += uBytes.length;
  nonceMessage.set(vBytes, off);
  off += vBytes.length;
  nonceMessage.set(ctx, off);

  const r_p = deriveNonce(secret, nonceMessage);
  const t0 = scalarMul(r_p, g);
  const t1 = scalarMul(r_p, h);
  const t0Bytes = pointToBytes(t0);
  const t1Bytes = pointToBytes(t1);

  const cBytes = fsHashDHTuple(gBytes, hBytes, uBytes, vBytes, t0Bytes, t1Bytes, ctx);
  const c = reduceScalar(bytesToBigIntBE(cBytes));

  const z = (r_p + ((c * secret) % SCALAR_ORDER)) % SCALAR_ORDER;
  return { t0: t0Bytes, t1: t1Bytes, z: scalarToBytes(z) };
}

/** Verify a proveDHTuple proof. Returns false on any structural defect. */
export function verifyDHTuple(
  g: G1Point,
  h: G1Point,
  u: G1Point,
  v: G1Point,
  proof: DHTupleProof,
  ctx: Uint8Array,
): boolean {
  if (proof.t0.length !== G1_COMPRESSED_BYTES) return false;
  if (proof.t1.length !== G1_COMPRESSED_BYTES) return false;
  if (proof.z.length !== SCALAR_BYTES) return false;

  let t0: G1Point;
  let t1: G1Point;
  try {
    t0 = pointFromBytes(proof.t0);
    t1 = pointFromBytes(proof.t1);
  } catch {
    return false;
  }
  const z = bytesToBigIntBE(proof.z);
  if (z >= SCALAR_ORDER) return false;

  const gBytes = pointToBytes(g);
  const hBytes = pointToBytes(h);
  const uBytes = pointToBytes(u);
  const vBytes = pointToBytes(v);

  const cBytes = fsHashDHTuple(gBytes, hBytes, uBytes, vBytes, proof.t0, proof.t1, ctx);
  const c = reduceScalar(bytesToBigIntBE(cBytes));

  const lhs0 = scalarMul(z, g);
  const rhs0 = pointAdd(t0, scalarMul(c, u));
  if (!pointEqual(lhs0, rhs0)) return false;

  const lhs1 = scalarMul(z, h);
  const rhs1 = pointAdd(t1, scalarMul(c, v));
  return pointEqual(lhs1, rhs1);
}
