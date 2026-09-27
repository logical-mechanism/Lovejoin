// Spend-from-Seedelf planning helper.
//
// Spec: Seedelf-Wallet contracts/validators/wallet.ak (`spend`) +
// platform/seedelf-cli/src/commands/transfer.rs (the spend mechanics).
//
// On-chain rules:
//
//   1. Each spent UTxO carries an inline datum decoded as
//      `Register { generator, public_value }`.
//   2. For each, the redeemer carries `Proof { z_b, g_r_b, vkh }`. The
//      validator verifies `g^z == g^r · u^c` with
//      `c = blake2b_224(generator || g_r || public_value || vkh)`.
//   3. `vkh` MUST appear in `tx.extra_signatories`. The signer is a fresh
//      ephemeral key the client generates per tx — never the user's
//      connected wallet. The one-time-pad role of `vkh` prevents replay
//      against a rolled-back duplicate input.
//
// Off-chain dance:
//
//   - Generate one fresh Ed25519 key per spend; its blake2b_224 hash is the
//     `vkh` baked into every proof. Discard the key after submission.
//   - Build proofs for each input (this module).
//   - Drive mesh with: external collateral via `GivemeMyProvider`, the
//     ephemeral pkh in `required_signers`, the wallet reference script
//     as a `txInScript`/`spendingTxInReference`, the proofs as
//     per-input redeemers, and any leftover funds re-randomized back to
//     a new Register (output at the wallet contract, no script runs).
//   - Sign the assembled body with the ephemeral key; merge the
//     collateral-provider's witness. Submit.
//
// This file produces the cryptographic plan only — mesh wiring is
// caller-side, mirroring deposit.ts/withdraw.ts/mix.ts.

import type { Lovelace, UtxoRef } from "../chain/provider.js";
import { SCALAR_ORDER, type Scalar } from "../crypto/bls.js";
import {
  encodeRegisterDatum,
  ownsSeedelfRegister,
  rerandomizeRegister,
  type SeedelfRegister,
} from "./register.js";
import { proveSeedelfSchnorr, type SeedelfProof, SEEDELF_VKH_BYTES } from "./schnorr.js";
import { encodeSpendRedeemer } from "./redeemer.js";
import { seedelfWalletAddressBech32, type SeedelfAddresses } from "./addresses.js";

/** One Seedelf UTxO the spend tx will consume. */
export interface SeedelfSpendInput {
  /** Chain ref of the UTxO. */
  ref: UtxoRef;
  /** Decoded inline datum from the UTxO. */
  register: SeedelfRegister;
  /** Owner secret that unlocks this register. */
  secret: Scalar;
  /** Lovelace the UTxO carries (used by the planner for change accounting). */
  lovelace: Lovelace;
}

/** One per-input redeemer slot — the Plutus CBOR plus the proof bytes. */
export interface SeedelfSpendRedeemerPlan {
  /** Chain ref of the input the redeemer belongs to. */
  inputRef: UtxoRef;
  /** Plutus-Data CBOR hex of the per-input Proof redeemer. */
  redeemerCborHex: string;
  /** Raw proof bytes — exposed for tests / debugging. */
  proof: SeedelfProof;
}

export interface PlanSeedelfSpendArgs {
  /** Seedelf protocol addresses on the active network. */
  addresses: SeedelfAddresses;
  /** UTxOs being consumed, in lex-sorted order matching how mesh will pass them. */
  inputs: ReadonlyArray<SeedelfSpendInput>;
  /**
   * 28-byte verification-key hash of the ephemeral signer. Embedded into
   * every proof and asserted in `extra_signatories` by the validator.
   * Caller generates the key + computes the vkh; the signer must sign
   * the final tx body.
   */
  ephemeralSignerVkh: Uint8Array;
  /**
   * Where the spent funds go.
   *   - {kind: "external", addressBech32, lovelace}: a plain payment
   *     (e.g. exiting Seedelf to a normal wallet, or to a Lovejoin
   *     mix-box). No re-randomization.
   *   - {kind: "internal", changeRegister, rerandomizeScalar, lovelace}:
   *     keep the funds inside Seedelf at a fresh re-randomized register
   *     (typical "spend just enough; rotate the rest"). The change
   *     register is the sender's own root register (or any owned
   *     register) re-randomized again.
   */
  output:
    | { kind: "external"; addressBech32: string; lovelace: Lovelace }
    | {
        kind: "internal";
        changeRegister: SeedelfRegister;
        rerandomizeScalar: Scalar;
        lovelace: Lovelace;
      };
}

export interface SeedelfSpendPlan {
  /** Per-input redeemer plans, parallel to `args.inputs`. */
  redeemers: SeedelfSpendRedeemerPlan[];
  /**
   * Output specification. Either an external payment or an internal
   * (re-randomized) Seedelf register output. The mesh driver builds the
   * matching tx output.
   */
  output:
    | {
        kind: "external";
        addressBech32: string;
        lovelace: Lovelace;
      }
    | {
        kind: "internal";
        addressBech32: string;
        lovelace: Lovelace;
        register: SeedelfRegister;
        inlineDatumHex: string;
      };
  /** Reference UTxO for the wallet validator (read-only input). */
  walletReferenceUtxoRef: UtxoRef;
  /** Wallet validator script hash (mesh needs this for tx-fee accounting). */
  walletScriptHashHex: string;
}

/**
 * Plan a Seedelf spend. Pure: validates each input, generates one Schnorr
 * proof per input, encodes the per-input redeemers, and (for internal
 * output) re-randomizes the change register.
 *
 * Mesh-side wiring is the caller's responsibility — see file header.
 */
export function planSeedelfSpendTx(args: PlanSeedelfSpendArgs): SeedelfSpendPlan {
  if (args.inputs.length === 0) {
    throw new Error("seedelf spend: at least one input is required");
  }
  if (args.ephemeralSignerVkh.length !== SEEDELF_VKH_BYTES) {
    throw new Error(`seedelf spend: ephemeralSignerVkh must be ${SEEDELF_VKH_BYTES} bytes`);
  }

  const redeemers: SeedelfSpendRedeemerPlan[] = [];
  for (const input of args.inputs) {
    if (!ownsSeedelfRegister(input.register, input.secret)) {
      throw new Error(
        `seedelf spend: secret does not unlock register at ${input.ref.txId}#${input.ref.outputIndex}`,
      );
    }
    const proof = proveSeedelfSchnorr({
      secret: input.secret,
      generator: input.register.generator,
      publicValue: input.register.publicValue,
      vkh: args.ephemeralSignerVkh,
    });
    redeemers.push({
      inputRef: input.ref,
      redeemerCborHex: encodeSpendRedeemer(proof),
      proof,
    });
  }

  let plannedOutput: SeedelfSpendPlan["output"];
  if (args.output.kind === "external") {
    if (args.output.lovelace <= 0n) {
      throw new Error("seedelf spend: external output lovelace must be positive");
    }
    plannedOutput = {
      kind: "external",
      addressBech32: args.output.addressBech32,
      lovelace: args.output.lovelace,
    };
  } else {
    if (args.output.lovelace <= 0n) {
      throw new Error("seedelf spend: internal output lovelace must be positive");
    }
    if (args.output.rerandomizeScalar <= 0n || args.output.rerandomizeScalar >= SCALAR_ORDER) {
      throw new Error("seedelf spend: rerandomizeScalar must be in [1, r)");
    }
    const changeRegister = rerandomizeRegister(
      args.output.changeRegister,
      args.output.rerandomizeScalar,
    );
    plannedOutput = {
      kind: "internal",
      addressBech32: seedelfWalletAddressBech32(args.addresses),
      lovelace: args.output.lovelace,
      register: changeRegister,
      inlineDatumHex: encodeRegisterDatum(changeRegister),
    };
  }

  return {
    redeemers,
    output: plannedOutput,
    walletReferenceUtxoRef: args.addresses.walletReferenceUtxoRef,
    walletScriptHashHex: args.addresses.walletScriptHash,
  };
}

// The on-the-wire redeemer encoder lives in `./redeemer.ts` so both the
// mint and spend paths share one implementation.
export { encodeSpendRedeemer as encodeSeedelfSpendRedeemer } from "./redeemer.js";
