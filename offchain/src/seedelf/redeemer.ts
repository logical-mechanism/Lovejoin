// Plutus-Data CBOR encoders for the Seedelf validators.
//
// Spec: Seedelf-Wallet contracts/validators/{seedelf,wallet}.ak.
//
//   - **Mint redeemer (seedelf policy):** the personal-tag bytes wrapped
//     directly as `PlutusData::BoundedBytes`. The trim to 15 bytes happens
//     inside the validator via `bytearray.slice(personal, 0, 14)`, so we
//     can send the raw user-supplied bytes through unmodified. The
//     reference Rust implementation truncates the *hex string* to 30
//     characters before re-decoding; we match that semantics here
//     because the on-chain token-name generator only consumes the first
//     15 bytes anyway.
//   - **Spend redeemer (wallet validator):** `Constr 0 [z, g_r, vkh]`
//     mirroring the Aiken `Proof { z_b, g_r_b, vkh }` shape.

import { Encoder, Tag } from "cbor-x";

import { G1_COMPRESSED_BYTES, SCALAR_BYTES } from "../crypto/bls.js";
import { SEEDELF_PERSONAL_MAX_BYTES } from "./token.js";
import { SEEDELF_VKH_BYTES, type SeedelfProof } from "./schnorr.js";

const cborEncoder = new Encoder();

/**
 * Encode the seedelf mint redeemer carrying the user's personal tag.
 *
 * Empty tag is legal — the on-chain `bytearray.slice` returns the empty
 * byte string and the resulting token name is `5eed0e1f || idx_byte ||
 * txid[..27]`, matching the Aiken `no_prefix_token_name` test layout.
 */
export function encodeMintRedeemer(personal: Uint8Array): string {
  if (personal.length > SEEDELF_PERSONAL_MAX_BYTES) {
    // Match the upstream behaviour: trim silently rather than error so a
    // 16-byte personal tag yields the same token as a 15-byte one.
    personal = personal.subarray(0, SEEDELF_PERSONAL_MAX_BYTES);
  }
  return bytesToHex(cborEncoder.encode(Buffer.from(personal)));
}

/**
 * Encode a Seedelf spend redeemer: `Constr 0 [bytes(z), bytes(g_r),
 * bytes(vkh)]`. Field order matches the Aiken `Proof` declaration.
 */
export function encodeSpendRedeemer(proof: SeedelfProof): string {
  if (proof.z.length !== SCALAR_BYTES) {
    throw new Error(`seedelf redeemer: z must be ${SCALAR_BYTES} bytes`);
  }
  if (proof.gR.length !== G1_COMPRESSED_BYTES) {
    throw new Error(`seedelf redeemer: g_r must be ${G1_COMPRESSED_BYTES} bytes`);
  }
  if (proof.vkh.length !== SEEDELF_VKH_BYTES) {
    throw new Error(`seedelf redeemer: vkh must be ${SEEDELF_VKH_BYTES} bytes`);
  }
  const tag = new Tag([Buffer.from(proof.z), Buffer.from(proof.gR), Buffer.from(proof.vkh)], 121);
  return bytesToHex(cborEncoder.encode(tag));
}

/**
 * Pre-sized placeholder for the spend redeemer — same byte-width as a
 * real proof so two-pass tx building (placeholder → real) doesn't shift
 * fees. Use during the first build pass when the real proof depends on
 * outputs that the tx hasn't laid out yet.
 */
export function placeholderSpendRedeemerHex(): string {
  return encodeSpendRedeemer({
    z: new Uint8Array(SCALAR_BYTES),
    gR: new Uint8Array(G1_COMPRESSED_BYTES),
    vkh: new Uint8Array(SEEDELF_VKH_BYTES),
  });
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
