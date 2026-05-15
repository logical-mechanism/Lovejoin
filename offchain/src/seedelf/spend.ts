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

import type { ChainProvider, Hex32, Lovelace, UtxoRef } from "../chain/provider.js";
import { SCALAR_ORDER, type Scalar } from "../crypto/bls.js";
import {
  encodeRegisterDatum,
  ownsSeedelfRegister,
  rerandomizeRegister,
  type SeedelfRegister,
} from "./register.js";
import { proveSeedelfSchnorr, type SeedelfProof, SEEDELF_VKH_BYTES } from "./schnorr.js";
import { encodeSpendRedeemer, placeholderSpendRedeemerHex } from "./redeemer.js";
import { seedelfWalletAddressBech32, type SeedelfAddresses } from "./addresses.js";
import { generateSeedelfEphemeralKey, type SeedelfEphemeralKey } from "./signer.js";
import { drawRerandomizationScalar } from "./rng.js";
import type { LovejoinWallet } from "../wallet/cip30.js";
import { getMeshProtocolParams, getMeshProvider } from "../tx/mesh-bridge.js";
import { type CollateralProvider, GivemeMyProvider, WalletProvider } from "../tx/collateral.js";
import { appendVkeyWitness } from "../tx/witness-merge.js";

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

// ---------------------------------------------------------------------------
// spendFromSeedelfTx — drives mesh
// ---------------------------------------------------------------------------

/**
 * Optional re-randomization spec for a chained `internal` change output.
 * Caller provides the seed register (one of their own owned registers)
 * and an optional fresh scalar; the SDK draws one if omitted.
 */
export interface SeedelfInternalChange {
  changeRegister: SeedelfRegister;
  rerandomizeScalar?: Scalar;
}

/**
 * Destination of a Seedelf spend. Three legal shapes:
 *
 *   * `external`: pay every leftover lovelace to a plain Cardano address.
 *     Fee comes out of the consumed inputs (no separate change output).
 *   * `internal`: re-randomize the change back to a fresh register at the
 *     wallet contract — typical "rotate the dust" call.
 *   * `split`: pay `externalLovelace` to `externalAddressBech32` AND keep
 *     the remainder (inputs - external - fee) as an internal change at a
 *     fresh re-randomized register.
 */
export type SeedelfSpendDestination =
  | { kind: "external"; addressBech32: string }
  | { kind: "internal"; change: SeedelfInternalChange }
  | {
      kind: "split";
      externalAddressBech32: string;
      externalLovelace: Lovelace;
      change: SeedelfInternalChange;
    };

export interface BuildSeedelfSpendArgs {
  network: "preprod" | "preview" | "test" | "mainnet";
  addresses: SeedelfAddresses;
  provider: ChainProvider;
  /**
   * Optional wallet. Required when no `collateralProvider` is supplied AND
   * the network has no pinned host (the SDK then falls back to
   * `WalletProvider`). Required when the caller explicitly passes
   * `WalletProvider`.
   */
  wallet?: LovejoinWallet;
  /** UTxOs being consumed. ≥ 1. */
  inputs: ReadonlyArray<SeedelfSpendInput>;
  /** Where the funds go. See {@link SeedelfSpendDestination}. */
  destination: SeedelfSpendDestination;
  /**
   * Optional ephemeral signer. Auto-generated when omitted. Caller-supplied
   * keys are useful for tests; in production let the SDK generate (and
   * forget) a fresh key per tx.
   */
  ephemeralKey?: SeedelfEphemeralKey;
  /**
   * Collateral provider. Defaults to `GivemeMyProvider` for the active
   * network — the protocol's stealth guarantee depends on no wallet input
   * appearing on the tx, so wallet collateral leaks the submitter's
   * identity. Falls back to `WalletProvider` only when the network has no
   * pinned host (e.g. `preview`).
   */
  collateralProvider?: CollateralProvider;
  /**
   * Initial fee estimate for the first build pass. The evaluator returns
   * real exec units; the second pass re-balances output value against the
   * actual minimum fee. Default 1.0 ADA — well above the empirical Seedelf
   * spend fee (~0.4 ADA at N=1) so the first pass coin-balance is feasible.
   */
  feeEstimateLovelace?: Lovelace;
  /** If true, sign but don't submit. */
  signOnly?: boolean;
}

export interface SeedelfSpendResult {
  signedTxHex: string;
  /** Tx id; empty when `signOnly` skipped submission. */
  txId: Hex32;
  /** The plan the tx was finally built from (post-fee-discovery). */
  plan: SeedelfSpendPlan;
  /** Final fee paid (in lovelace). */
  feeLovelace: Lovelace;
}

const DEFAULT_FEE_ESTIMATE_LOVELACE: Lovelace = 1_000_000n;

/**
 * Build, sign, and (optionally) submit a Seedelf spend tx.
 *
 * Wiring mirrors Lovejoin's Mix flow: external collateral via giveme.my,
 * no wallet input or signature on the tx, ephemeral Ed25519 key signs
 * the body, the wallet validator's `Proof` redeemer per input.
 *
 * Two-pass: pass 1 sizes the tx body with the caller's fee estimate; the
 * evaluator returns real per-redeemer exec units, mesh's `complete()`
 * re-derives a precise minimum fee, and pass 2 rebuilds the body with
 * that fee pinned so the output value (= input − fee) balances the tx.
 * Schnorr proofs are stable across passes (they bind to the register +
 * vkh, neither of which depends on the fee).
 */
export async function spendFromSeedelfTx(args: BuildSeedelfSpendArgs): Promise<SeedelfSpendResult> {
  if (args.inputs.length === 0) {
    throw new Error("Seedelf spend: at least one input is required");
  }
  const totalInputLovelace = args.inputs.reduce((s, i) => s + i.lovelace, 0n);
  const ephemeralKey = args.ephemeralKey ?? generateSeedelfEphemeralKey();
  const feeEstimate = args.feeEstimateLovelace ?? DEFAULT_FEE_ESTIMATE_LOVELACE;
  if (feeEstimate <= 0n) {
    throw new Error("Seedelf spend: feeEstimateLovelace must be positive");
  }

  // Resolve destination → planner output spec. Internal/split shares the
  // change register + d so the plan and the rebuild produce the same
  // re-randomized bytes; auto-drawn when caller omits.
  const internalChange = (() => {
    if (args.destination.kind === "internal") return args.destination.change;
    if (args.destination.kind === "split") return args.destination.change;
    return null;
  })();
  const internalD =
    internalChange?.rerandomizeScalar ?? (internalChange ? drawRerandomizationScalar() : undefined);

  // Build the plan twice over: first with the fee estimate to get a tx body
  // we can evaluate, then again with the discovered fee for the final
  // submission. Both planner runs use identical proofs (deterministic via
  // RFC 6979 over the same secret + register + vkh), so the only thing that
  // changes between passes is the output lovelace value.
  const planFor = (fee: Lovelace): SeedelfSpendPlan => {
    const output = computePlannerOutput(args.destination, totalInputLovelace, fee, internalD!);
    return planSeedelfSpendTx({
      addresses: args.addresses,
      inputs: args.inputs,
      ephemeralSignerVkh: ephemeralKey.vkh,
      output,
    });
  };

  const initialPlan = planFor(feeEstimate);

  // Collateral. Default to giveme.my for stealth; fall back to wallet
  // collateral when the network has no pinned host (e.g. `preview`).
  const collateral = args.collateralProvider ?? defaultSpendCollateralProvider(args);
  const preparedCollateral = await collateral.prepareCollateral({
    provider: args.provider,
    collateralAmountLovelace: 5_000_000n,
  });

  const meshCore = await import("@meshsdk/core");
  const { MeshTxBuilder } = meshCore;
  const meshProvider = await getMeshProvider(args.provider);
  const meshParams = await getMeshProtocolParams(args.provider);

  // Mesh needs a change address even when no change is emitted. With a
  // wallet present, use it; otherwise fall back to the collateral input's
  // address so any (impossible) leftover lands back at the host.
  const changeAddress = args.wallet
    ? await args.wallet.getChangeAddress()
    : preparedCollateral.inputs[0]!.address;

  const populate = (
    tx: InstanceType<typeof MeshTxBuilder>,
    plan: SeedelfSpendPlan,
    redeemerHexForInput: (i: number) => string,
    fee: Lovelace,
  ) => {
    // NOTE: the wallet validator's reference script lives at
    // `plan.walletReferenceUtxoRef`. We attach it per-input via
    // `spendingTxInReference` below, which doubles as the read-only
    // reference declaration. Calling `readOnlyTxInReference` on the SAME
    // UTxO would register it twice with different scriptSize values
    // (undefined vs the real size), tripping mesh-csl's "Different
    // script sizes for the same ref input <ref>" rejection.

    for (let i = 0; i < args.inputs.length; i++) {
      const inp = args.inputs[i]!;
      tx.spendingPlutusScriptV3()
        .txIn(
          inp.ref.txId,
          inp.ref.outputIndex,
          [{ unit: "lovelace", quantity: inp.lovelace.toString() }],
          seedelfWalletAddressBech32(args.addresses),
        )
        .txInInlineDatumPresent()
        .txInRedeemerValue(redeemerHexForInput(i), "CBOR")
        .spendingTxInReference(
          plan.walletReferenceUtxoRef.txId,
          plan.walletReferenceUtxoRef.outputIndex,
          args.addresses.walletReferenceScriptSize?.toString(),
          plan.walletScriptHashHex,
        );
    }

    // Outputs. External + internal pieces emitted in destination order.
    if (plan.output.kind === "external") {
      tx.txOut(plan.output.addressBech32, [
        { unit: "lovelace", quantity: plan.output.lovelace.toString() },
      ]);
    } else {
      tx.txOut(plan.output.addressBech32, [
        { unit: "lovelace", quantity: plan.output.lovelace.toString() },
      ]).txOutInlineDatumValue(plan.output.inlineDatumHex, "CBOR");
    }
    // Split: emit the second output (the internal change) — computed via
    // planFor() against the same `fee`, but we need both outputs in the
    // same tx body, so emit it here too.
    if (args.destination.kind === "split") {
      const externalLovelace = args.destination.externalLovelace;
      const internalLovelace = totalInputLovelace - externalLovelace - fee;
      if (internalLovelace <= 0n) {
        throw new Error(
          `Seedelf spend (split): internal change is ${internalLovelace} after deducting external (${externalLovelace}) + fee (${fee}) from inputs (${totalInputLovelace})`,
        );
      }
      const change = rerandomizeRegister(internalChange!.changeRegister, internalD!);
      tx.txOut(seedelfWalletAddressBech32(args.addresses), [
        { unit: "lovelace", quantity: internalLovelace.toString() },
      ]).txOutInlineDatumValue(encodeRegisterDatum(change), "CBOR");
    }

    // Required signer: the ephemeral pkh must appear in extra_signatories.
    tx.requiredSignerHash(toHex(ephemeralKey.vkh));
    // External host's pkh (when present) must also be in required_signers —
    // see Collateral-Provider's `check_signers`.
    if (preparedCollateral.requiredSignerPkhHex) {
      tx.requiredSignerHash(preparedCollateral.requiredSignerPkhHex);
    }

    // Collateral input(s).
    for (const utxo of preparedCollateral.inputs) {
      tx.txInCollateral(
        utxo.ref.txId,
        utxo.ref.outputIndex,
        [{ unit: "lovelace", quantity: utxo.lovelace.toString() }],
        utxo.address,
      );
    }

    // Pin the tx fee so the output value (= input − fee) balances exactly.
    tx.setFee(fee.toString());
    tx.changeAddress(changeAddress);
    // No wallet input on a stealth spend — selectUtxosFrom([]) blocks mesh
    // from drawing wallet UTxOs to balance.
    tx.selectUtxosFrom([]);
  };

  // Pass 1: build with placeholder proofs (constant-sized so the tx body
  // is correctly sized for the evaluator). Real exec units fall out of
  // `tx.complete()`.
  const placeholderRedeemerHex = placeholderSpendRedeemerHex();
  const buildOnce = async (
    plan: SeedelfSpendPlan,
    redeemerHexForInput: (i: number) => string,
    fee: Lovelace,
  ): Promise<string> => {
    const tx = new MeshTxBuilder({
      fetcher: meshProvider as never,
      submitter: meshProvider as never,
      evaluator: meshProvider as never,
      params: meshParams as never,
      verbose: false,
    });
    tx.txEvaluationMultiplier = 1;
    populate(tx, plan, redeemerHexForInput, fee);
    return tx.complete();
  };

  let unsignedTxHex = await buildOnce(initialPlan, () => placeholderRedeemerHex, feeEstimate);

  // Pass 2: derive the real fee. mesh's `tx.complete()` already returned a
  // tx body with evaluator-refined ex-units; the embedded fee field is the
  // chain's minimum for that body. Re-read it, plan with the matching
  // output value, and rebuild with real proofs (the planner produced them
  // up front; they don't depend on fee or output value).
  const cst = await import("@meshsdk/core-cst");
  const meshFee = extractFeeFromTx(cst, unsignedTxHex);
  // Mesh-csl @1.8.14 misses Conway's reference-script fee component for
  // some paths; we recompute against the wallet ref-script size to add it
  // if missing. The result is `max(meshFee, meshFee + refScriptDelta)` —
  // overshooting is fine on chain; undershooting would FeeTooSmall.
  const finalFee = meshFee; // ref-script fee is now accounted for in mesh 1.8.14 mainline.

  const finalPlan = planFor(finalFee);
  unsignedTxHex = await buildOnce(
    finalPlan,
    (i) => finalPlan.redeemers[i]!.redeemerCborHex,
    finalFee,
  );

  // Sign with the ephemeral key — the on-chain `list.has(extra_signatories,
  // proof.vkh)` check requires a vkey witness for the ephemeral pkh.
  const txHash = String(cst.resolveTxHash(unsignedTxHex));
  const txHashBytes = hexToBytes(txHash);
  const ephemeralSig = ephemeralKey.sign(txHashBytes);
  const ephemeralWitness = {
    vkeyHex: toHex(ephemeralKey.publicKey),
    signatureHex: toHex(ephemeralSig),
  };
  let signedTx = await appendVkeyWitness(unsignedTxHex, ephemeralWitness);

  // Collateral host witness (when external). With wallet collateral,
  // signTxBody returns null and we sign via the wallet path below.
  if (preparedCollateral.externallySigned) {
    const hostWitness = await collateral.signTxBody(signedTx);
    if (!hostWitness) {
      throw new Error(
        "Seedelf spend: collateral provider claimed externallySigned but signTxBody() returned null",
      );
    }
    signedTx = await appendVkeyWitness(signedTx, hostWitness);
  } else {
    // Wallet collateral fallback — wallet signs (covers collateral input).
    if (!args.wallet) {
      throw new Error("Seedelf spend: wallet collateral was selected but no wallet was supplied");
    }
    signedTx = await args.wallet.signTx(signedTx, true);
  }

  if (args.signOnly) {
    return { signedTxHex: signedTx, txId: "", plan: finalPlan, feeLovelace: finalFee };
  }
  const txId = await args.provider.submitTx(signedTx);
  return { signedTxHex: signedTx, txId, plan: finalPlan, feeLovelace: finalFee };
}

/**
 * Compute the planner's `output` field from the user-facing destination
 * spec and the discovered fee. For `split`, the planner only emits the
 * external leg — the internal change is laid down by the builder so the
 * planner shape stays unchanged.
 */
function computePlannerOutput(
  dest: SeedelfSpendDestination,
  totalInput: Lovelace,
  fee: Lovelace,
  d: Scalar,
): PlanSeedelfSpendArgs["output"] {
  if (dest.kind === "external") {
    const lovelace = totalInput - fee;
    if (lovelace <= 0n) {
      throw new Error(
        `Seedelf spend: external output is ${lovelace} after fee (${fee}) from inputs (${totalInput})`,
      );
    }
    return { kind: "external", addressBech32: dest.addressBech32, lovelace };
  }
  if (dest.kind === "internal") {
    const lovelace = totalInput - fee;
    if (lovelace <= 0n) {
      throw new Error(
        `Seedelf spend: internal change is ${lovelace} after fee (${fee}) from inputs (${totalInput})`,
      );
    }
    return {
      kind: "internal",
      changeRegister: dest.change.changeRegister,
      rerandomizeScalar: d,
      lovelace,
    };
  }
  // split: the planner carries the EXTERNAL leg; the builder emits the
  // internal change leg directly.
  return {
    kind: "external",
    addressBech32: dest.externalAddressBech32,
    lovelace: dest.externalLovelace,
  };
}

function defaultSpendCollateralProvider(args: BuildSeedelfSpendArgs): CollateralProvider {
  try {
    return new GivemeMyProvider({ network: args.network });
  } catch (e) {
    if (!args.wallet) {
      throw new Error(
        `Seedelf spend: no pinned collateral host for "${args.network}" and no wallet supplied. Pass an explicit collateralProvider or connect a wallet. Original: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    console.warn(
      `[lovejoin/seedelf] no pinned collateral host for "${args.network}" — falling back to wallet collateral. Spend anonymity is degraded.`,
    );
    return new WalletProvider(args.wallet);
  }
}

function extractFeeFromTx(cst: typeof import("@meshsdk/core-cst"), txCborHex: string): Lovelace {
  const tx = cst.deserializeTx(txCborHex);
  const body = tx.body();
  const fee = body.fee();
  return typeof fee === "bigint" ? fee : BigInt(fee);
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (cleaned.length % 2 !== 0) throw new Error("hex string must have even length");
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
