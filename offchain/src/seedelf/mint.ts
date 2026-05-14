// Seedelf mint tx — pure planning helpers.
//
// Spec: Seedelf-Wallet contracts/validators/seedelf.ak (mint validator)
// + platform/seedelf-cli/src/commands/create.rs.
//
// The mint validator's only rule, when `amt == 1`, is:
//
//   token_name == generate(tx.inputs[0].output_reference.tx_id,
//                          tx.inputs[0].output_reference.idx,
//                          5eed0e1f, personal_tag)
//
// i.e. the asset name must equal the canonical seedelf-token-name derived
// from the first ledger-sorted input + the redeemer's `personal_tag`. The
// validator does NOT constrain the inline datum or the destination
// address; in practice the only sensible tx shape is:
//
//   - Wallet UTxO inputs to fund the mint + the minimum-ADA output.
//   - One output at the Seedelf wallet script address carrying:
//     - the freshly-minted 1 × Seedelf NFT
//     - an inline-datum Register = (g^d, [x·d]·g) for a fresh secret x and
//       a fresh re-randomization scalar d
//   - The Seedelf mint reference UTxO read as `reference_input`.
//   - The mint redeemer is a Plutus `BoundedBytes(personal_tag)`.
//
// Mesh sequencing for the actual build belongs in the UI/integration test
// layer — this file produces the bytes mesh consumes.

import type { Lovelace, UtxoRef } from "../chain/provider.js";
import {
  type G1Point,
  type Scalar,
  SCALAR_ORDER,
  pointEqual,
  pointFromBytes,
  scalarMul,
} from "../crypto/bls.js";
import {
  createRegister,
  encodeRegisterDatum,
  rerandomizeRegister,
  type SeedelfRegister,
} from "./register.js";
import { buildSeedelfTokenName, SEEDELF_TOKEN_PREFIX_HEX } from "./token.js";
import { encodeMintRedeemer } from "./redeemer.js";
import type { SeedelfAddresses } from "./addresses.js";
import { seedelfWalletAddressBech32 } from "./addresses.js";

/** Inputs needed to plan a mint. */
export interface PlanSeedelfMintArgs {
  /** Seedelf protocol addresses on the active network. */
  addresses: SeedelfAddresses;
  /**
   * Lex-smallest input the mint tx will consume — the validator binds the
   * token name to this exact `output_reference`. Caller picks any wallet
   * UTxO that mesh will include; we don't require a specific one.
   */
  smallestInputRef: UtxoRef;
  /** New secret scalar `x` that controls the freshly-minted register. */
  ownerSecret: Scalar;
  /**
   * Fresh re-randomization scalar `d` ∈ [1, r). Must come from a CSPRNG
   * — the Seedelf threat model treats `d` as toxic waste, and a small or
   * predictable `d` lets an attacker invert the register back to the
   * canonical generator. Caller is responsible for sourcing and
   * destroying `d`.
   */
  rerandomizeScalar: Scalar;
  /** Optional user-supplied personal tag (display label). UTF-8, up to 15 bytes. */
  personalTag?: string | Uint8Array;
  /** Minimum ADA the mint output must carry (calculator output, ≈ 1.5 ADA). */
  outputLovelace: Lovelace;
}

/** What the mint tx will commit, in plan form. */
export interface SeedelfMintPlan {
  /** Token name to mint, 32 raw bytes. */
  assetName: Uint8Array;
  /** Token name as lowercase hex (convenience for mesh). */
  assetNameHex: string;
  /** Compressed re-randomized register `(g^d, u^d)` to publish on-chain. */
  register: SeedelfRegister;
  /** Plutus-Data CBOR hex of the register inline datum. */
  inlineDatumHex: string;
  /** Plutus-Data CBOR hex of the mint redeemer (BoundedBytes(personal_tag)). */
  mintRedeemerCborHex: string;
  /** Bech32 wallet-contract address where the new register UTxO sits. */
  mintOutputAddressBech32: string;
  /** Lovelace the mint output carries (same as `args.outputLovelace`). */
  mintOutputLovelace: Lovelace;
  /** Reference UTxO for the seedelf mint script (read-only input). */
  mintReferenceUtxoRef: UtxoRef;
  /** 28-byte mint policy id. */
  mintPolicyIdHex: string;
}

/**
 * Plan a Seedelf mint. Pure: computes the canonical asset name from the
 * smallest input + redeemer, builds the inline-datum register from `x` and
 * `d`, and emits all the bytes a mesh-driven tx builder needs.
 *
 * Does NOT do any chain queries. Caller resolves the smallest input ref
 * by sorting wallet UTxOs lex-smallest first and passing in that ref;
 * mesh's coin selection will then pick that UTxO into the tx (the input
 * with the lex-smallest `(txid, idx)` is the one the validator inspects).
 */
export function planSeedelfMintTx(args: PlanSeedelfMintArgs): SeedelfMintPlan {
  if (args.ownerSecret <= 0n || args.ownerSecret >= SCALAR_ORDER) {
    throw new Error("seedelf mint: ownerSecret must be in [1, r)");
  }
  if (args.rerandomizeScalar <= 0n || args.rerandomizeScalar >= SCALAR_ORDER) {
    throw new Error("seedelf mint: rerandomizeScalar must be in [1, r)");
  }
  if (args.outputLovelace <= 0n) {
    throw new Error("seedelf mint: outputLovelace must be positive");
  }

  // Build the re-randomized register: start with (g, g^x), then scale both
  // by d to produce (g^d, [x·d]·g). The result is unlinkable to (g, g^x)
  // under ECDDH.
  const rootRegister = createRegister(args.ownerSecret);
  const register = rerandomizeRegister(rootRegister, args.rerandomizeScalar);

  // Canonical asset name from the lex-smallest input + personal tag.
  const assetName = buildSeedelfTokenName({
    input: args.smallestInputRef,
    ...(args.personalTag !== undefined ? { personal: args.personalTag } : {}),
  });

  return {
    assetName,
    assetNameHex: bytesToHex(assetName),
    register,
    inlineDatumHex: encodeRegisterDatum(register),
    mintRedeemerCborHex: encodeMintRedeemer(personalToBytes(args.personalTag)),
    mintOutputAddressBech32: seedelfWalletAddressBech32(args.addresses),
    mintOutputLovelace: args.outputLovelace,
    mintReferenceUtxoRef: args.addresses.seedelfReferenceUtxoRef,
    mintPolicyIdHex: args.addresses.seedelfPolicyId,
  };
}

/**
 * Cross-check: the re-randomized register really is unlocked by the
 * supplied secret. Catches a swapped `x`/`d` at plan time rather than
 * after the tx is submitted.
 */
export function verifyMintRegister(plan: SeedelfMintPlan, ownerSecret: Scalar): boolean {
  let g: G1Point;
  let u: G1Point;
  try {
    g = pointFromBytes(plan.register.generator);
    u = pointFromBytes(plan.register.publicValue);
  } catch {
    return false;
  }
  return pointEqual(scalarMul(ownerSecret, g), u);
}

/**
 * Default ADA pinned to a fresh mint output. 2 ADA covers the min-UTxO at
 * the wallet contract address for a typical Register datum + NFT under
 * Conway-era params (utxoCostPerByte = 4310).
 */
export const SEEDELF_MINT_DEFAULT_LOVELACE: Lovelace = 2_000_000n;

function personalToBytes(personal?: string | Uint8Array): Uint8Array {
  if (personal === undefined) return new Uint8Array(0);
  if (typeof personal === "string") return new TextEncoder().encode(personal);
  return personal;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

// Re-export for caller convenience.
export { SEEDELF_TOKEN_PREFIX_HEX };
