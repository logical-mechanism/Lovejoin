// Fresh per-tx scalar draws for Seedelf re-randomization.
//
// Spec: issue #155. The mint / send / spend tx builders need a CSPRNG
// scalar `d ∈ [1, r)` per transaction to re-randomize the recipient (send)
// or change (internal spend) register. Seedelf treats `d` as toxic waste:
// the builder draws, uses, and drops it within the function scope. We
// reject zero (would leave the register unchanged) and any value ≥ r
// (illegal scalar).
//
// Implementation mirrors `offchain/src/tx/deposit.ts::drawScalar` byte-for-
// byte: WebCrypto / node-crypto 32-byte BE, mod-reduce, redraw on zero
// after reduction. The redraw probability is ~2^-256 so the loop is a
// formality.

import { SCALAR_ORDER, type Scalar, bytesToBigIntBE, reduceScalar } from "../crypto/bls.js";

/**
 * Draw a fresh re-randomization scalar from the platform CSPRNG. Returns a
 * non-zero scalar in [1, r). Throws if no CSPRNG is available — Seedelf's
 * privacy guarantee assumes the source is unpredictable, so a fallback to a
 * weaker PRNG would be a silent footgun.
 */
export function drawRerandomizationScalar(): Scalar {
  const cs = getCryptoSource();
  // Loop on the astronomically-unlikely zero-after-reduce path.
  for (let i = 0; i < 64; i++) {
    const bytes = new Uint8Array(32);
    cs(bytes);
    const x = reduceScalar(bytesToBigIntBE(bytes));
    if (x !== 0n && x < SCALAR_ORDER) return x;
  }
  throw new Error("drawRerandomizationScalar: 64 redraws all hit zero — CSPRNG broken?");
}

type Filler = (out: Uint8Array) => void;

function getCryptoSource(): Filler {
  // Browser / Web Worker / Node ≥ 19: WebCrypto.
  const g: { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } } =
    globalThis as unknown as {
      crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array };
    };
  if (g.crypto?.getRandomValues) {
    const cw = g.crypto;
    return (out) => {
      cw.getRandomValues!(out);
    };
  }
  throw new Error(
    "drawRerandomizationScalar: no CSPRNG (globalThis.crypto.getRandomValues missing). " +
      "Run on a platform with WebCrypto (browsers, Node ≥ 19, Cloudflare Workers).",
  );
}
