// RFC 6979 deterministic nonce derivation for the sigma-protocol prover.
//
// Spec: docs/spec/02-cryptography.md §"Nonce generation: RFC 6979 deterministic"
//
//   "r_p = HMAC-SHA256-DRBG(seed = secretKey || H(message) || domain_tag || counter)"
//
// The Lovejoin spec describes the scheme in shorthand. Concretely we implement the
// canonical RFC 6979 §3.2 procedure with HMAC-SHA256 as the PRF, and we domain-
// separate by prepending DOMAIN_TAG_V1_BYTES to the message before hashing — this
// binds the protocol tag into the K/V state via h1 = SHA256(domain_tag || message).
//
// Why deterministic: an attacker who can predict r_p extracts the secret. RFC 6979
// derives r_p from HMAC keyed by the secret, so prediction reduces to breaking
// HMAC-SHA256. A weak / replayed RNG cannot leak secrets here. KAT vectors become
// exact (same `(x, msg)` ⇒ byte-identical proof bytes).
//
// Aiken does NOT generate nonces — it only verifies — so this module is TS-only.

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  SCALAR_BYTES,
  SCALAR_ORDER,
  type Scalar,
  bytesToBigIntBE,
  scalarToBytes,
} from "./bls.js";
import { DOMAIN_TAG_V1_BYTES } from "./hash.js";

// Scalar order r = 0x73ed...01 — first hex nibble 7 = 0b0111, so r occupies bit 254
// but not bit 255. RFC 6979 §2.3.2 says qlen = bit length of q.
const QLEN_BITS = 255;
const HMAC_BLOCK = 32; // SHA-256 output size in bytes
const BLEN_BITS = HMAC_BLOCK * 8; // 256
const BITS2INT_SHIFT = BigInt(BLEN_BITS - QLEN_BITS); // 1n

function hmacSha256(key: Uint8Array, ...data: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const d of data) total += d.length;
  const concatenated = new Uint8Array(total);
  let off = 0;
  for (const d of data) {
    concatenated.set(d, off);
    off += d.length;
  }
  return hmac(sha256, key, concatenated);
}

/// RFC 6979 §2.3.2 bits2int: read the first `qlen` leftmost bits of the input and
/// interpret big-endian as an integer in `[0, 2^qlen)`. For our case (SHA-256 output
/// = 256 bits, qlen = 255 for r) this means a 1-bit right-shift after big-endian
/// decode.
function bits2int(b: Uint8Array): bigint {
  return bytesToBigIntBE(b) >> BITS2INT_SHIFT;
}

/// RFC 6979 §2.3.3 int2octets: encode integer as `rolen` big-endian bytes (here 32).
function int2octets(x: bigint): Uint8Array {
  return scalarToBytes(x);
}

/// RFC 6979 §2.3.4 bits2octets: bits2int(b), reduce mod q, then int2octets. After
/// the qlen-bit truncation `bits2int` returns at most 2^qlen - 1 ≈ 1.10·r, so a
/// single subtraction is enough — but `% SCALAR_ORDER` is just as cheap and is
/// robust if the shift parameters ever change.
function bits2octets(b: Uint8Array): Uint8Array {
  const z1 = bits2int(b);
  const z2 = z1 % SCALAR_ORDER;
  return int2octets(z2);
}

/// Derive an RFC 6979 deterministic nonce in `Z_r \ {0}` for `(secret, message)`.
///
/// `message` is hashed with SHA-256 (after prepending the v1 domain tag) to produce
/// h1; the canonical HMAC-DRBG state is then driven from `(secret, h1)`. The same
/// `(secret, message)` pair ALWAYS yields the same scalar, across processes and
/// platforms — this is what makes KAT vectors byte-exact.
export function deriveNonce(secret: Scalar, message: Uint8Array): Scalar {
  if (secret <= 0n || secret >= SCALAR_ORDER) {
    throw new Error("secret must be in [1, r)");
  }

  // h1 = SHA-256(domain_tag || message)
  const tagged = new Uint8Array(DOMAIN_TAG_V1_BYTES.length + message.length);
  tagged.set(DOMAIN_TAG_V1_BYTES, 0);
  tagged.set(message, DOMAIN_TAG_V1_BYTES.length);
  const h1 = sha256(tagged);

  const xOctets = int2octets(secret);
  const h1Octets = bits2octets(h1);

  // RFC 6979 step b–f.
  let V = new Uint8Array(HMAC_BLOCK).fill(0x01);
  let K = new Uint8Array(HMAC_BLOCK); // zero
  K = hmacSha256(K, V, new Uint8Array([0x00]), xOctets, h1Octets);
  V = hmacSha256(K, V);
  K = hmacSha256(K, V, new Uint8Array([0x01]), xOctets, h1Octets);
  V = hmacSha256(K, V);

  // RFC 6979 step h: generate T, test against rejection criteria, repeat as needed.
  // For SHA-256 + scalar field of size ~256 bits, one HMAC block is enough; we still
  // loop so the construction remains correct if the curve ever changes.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const buf = new Uint8Array(SCALAR_BYTES);
    let off = 0;
    while (off < SCALAR_BYTES) {
      V = hmacSha256(K, V);
      const take = Math.min(HMAC_BLOCK, SCALAR_BYTES - off);
      buf.set(V.subarray(0, take), off);
      off += take;
    }
    const k = bits2int(buf);
    if (k > 0n && k < SCALAR_ORDER) return k;
    K = hmacSha256(K, V, new Uint8Array([0x00]));
    V = hmacSha256(K, V);
  }
}
