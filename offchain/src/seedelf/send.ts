// Send-to-Seedelf planning helper.
//
// Spec: Seedelf-Wallet platform/seedelf-cli/src/commands/transfer.rs
// (the sender-side mechanics) and contracts/lib/schnorr.ak
// (the rerandomization invariant).
//
// Sending into a recipient's Seedelf is a regular payment from the
// sender's wallet to the Seedelf wallet contract address, with the
// recipient's register re-randomized into a fresh inline datum:
//
//   sender wallet UTxO  ->  Seedelf wallet contract UTxO
//                            value:  args.lovelace (+ any tokens)
//                            datum:  Register(g^d, u^d)
//
// No script execution runs on chain — the wallet contract is **spent**
// via Schnorr proof, but **paid into** via a plain payment. The mint
// validator doesn't run either; sending into the contract doesn't mint a
// new locator NFT (the NFT lives on the *receiver's* root register, not
// on the funded UTxOs).
//
// The recipient never sees `d` — it's the sender's responsibility to
// discard it after the tx is broadcast. Persisting `d` anywhere is a
// privacy leak: anyone with `d` and the original register can invert the
// payment back to the source register.

import type { Lovelace } from "../chain/provider.js";
import { SCALAR_ORDER, type Scalar } from "../crypto/bls.js";
import { encodeRegisterDatum, rerandomizeRegister, type SeedelfRegister } from "./register.js";
import { seedelfWalletAddressBech32, type SeedelfAddresses } from "./addresses.js";

export interface PlanSeedelfSendArgs {
  /** Seedelf protocol addresses on the active network. */
  addresses: SeedelfAddresses;
  /**
   * Recipient's register, fetched by scanning the wallet contract for
   * a UTxO holding the recipient's locator NFT and reading its inline
   * datum. Caller does the lookup; this function is pure.
   */
  recipientRegister: SeedelfRegister;
  /**
   * Fresh re-randomization scalar `d` ∈ [1, r) sourced from a CSPRNG by
   * the caller. MUST be discarded after the tx is signed and submitted
   * (see file header).
   */
  rerandomizeScalar: Scalar;
  /** ADA to send (in lovelace). MUST cover the wallet-contract min-UTxO. */
  lovelace: Lovelace;
}

export interface SeedelfSendPlan {
  /** Re-randomized recipient register, on-chain inline datum bytes. */
  outputRegister: SeedelfRegister;
  /** Plutus-Data CBOR hex of the recipient's register inline datum. */
  inlineDatumHex: string;
  /** Bech32 wallet-contract address the payment lands at. */
  outputAddressBech32: string;
  /** Lovelace the payment carries (same as `args.lovelace`). */
  outputLovelace: Lovelace;
}

/**
 * Plan a Send-to-Seedelf tx. Pure: re-randomizes the recipient register
 * and emits the bytes a mesh-driven tx builder needs.
 *
 * The tx itself is a normal wallet-paid payment — no Plutus script
 * runs on chain, so the mesh-side build doesn't need a collateral
 * provider or a reference script. Caller drives mesh with the standard
 * `tx.txOut(addr, [{unit: "lovelace", quantity}]).txOutInlineDatumValue(...)`
 * pattern.
 */
export function planSeedelfSendTx(args: PlanSeedelfSendArgs): SeedelfSendPlan {
  if (args.rerandomizeScalar <= 0n || args.rerandomizeScalar >= SCALAR_ORDER) {
    throw new Error("seedelf send: rerandomizeScalar must be in [1, r)");
  }
  if (args.lovelace <= 0n) {
    throw new Error("seedelf send: lovelace must be positive");
  }
  const outputRegister = rerandomizeRegister(args.recipientRegister, args.rerandomizeScalar);
  return {
    outputRegister,
    inlineDatumHex: encodeRegisterDatum(outputRegister),
    outputAddressBech32: seedelfWalletAddressBech32(args.addresses),
    outputLovelace: args.lovelace,
  };
}
