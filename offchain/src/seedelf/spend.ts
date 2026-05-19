// Spend-from-Seedelf planning + tx builder.
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
// Spend model (issue #155 follow-up): a spend has exactly one
// destination — a plain Cardano address OR another Seedelf register —
// plus an optional `amountLovelace`. Whatever is left after
// `amount + fee` becomes a CHANGE output: a re-randomized register the
// spender owns, emitted only when it clears the chain min-UTxO. There is
// no separate "rotate / churn" mode: rotating funds into a register you
// own is just a spend whose destination is your own register.
//
// Off-chain dance:
//
//   - Generate one fresh Ed25519 key per spend; its blake2b_224 hash is
//     the `vkh` baked into every proof. Discard the key after submission.
//   - Build proofs for each input (the planner below).
//   - Drive mesh with: external collateral via `GivemeMyProvider`, the
//     ephemeral pkh in `required_signers`, the wallet reference script as
//     a `spendingTxInReference`, the proofs as per-input redeemers, the
//     destination output, and (when there's a remainder) the change
//     output as a re-randomized register.
//   - Sign the assembled body with the ephemeral key; merge the
//     collateral-provider's witness. Submit.

import type { ChainProvider, Hex32, Lovelace, UtxoRef } from "../chain/provider.js";
import { type Scalar } from "../crypto/bls.js";
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
  /** Lovelace the UTxO carries. */
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
  /** UTxOs being consumed. ≥ 1. */
  inputs: ReadonlyArray<SeedelfSpendInput>;
  /**
   * 28-byte verification-key hash of the ephemeral signer. Embedded into
   * every proof and asserted in `extra_signatories` by the validator.
   * Caller generates the key + computes the vkh; the signer must sign
   * the final tx body.
   */
  ephemeralSignerVkh: Uint8Array;
}

export interface SeedelfSpendPlan {
  /** Per-input redeemer plans, parallel to `args.inputs`. */
  redeemers: SeedelfSpendRedeemerPlan[];
  /** Reference UTxO for the wallet validator. */
  walletReferenceUtxoRef: UtxoRef;
  /** Wallet validator script hash (mesh needs this for tx-fee accounting). */
  walletScriptHashHex: string;
}

/**
 * Plan a Seedelf spend. Pure: validates each input owns its register and
 * generates one Schnorr proof + redeemer per input.
 *
 * The Seedelf proof binds only to `(generator, public_value, vkh)` — NOT
 * to the tx outputs — so the proofs are stable regardless of how the
 * destination / change outputs are sized. Output construction is entirely
 * the builder's job.
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

  return {
    redeemers,
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
 * Where the spent funds are delivered. Exactly one destination per spend:
 *
 *   * `external` — a plain payment to any Cardano address (exiting
 *     Seedelf to a normal wallet, an exchange, etc.).
 *   * `seedelf` — a payment into a Seedelf register (someone else's, or
 *     one of your own — the latter is the "rotate funds" case). The
 *     recipient register is re-randomized into the output's inline datum
 *     so the payment is unlinkable to the register the recipient shared.
 *
 * Any remainder after `amountLovelace + fee` is returned as a separate
 * CHANGE output — see {@link BuildSeedelfSpendArgs.changeRegister}.
 */
export type SeedelfSpendDestination =
  | { kind: "external"; addressBech32: string }
  | { kind: "seedelf"; recipientRegister: SeedelfRegister };

export interface BuildSeedelfSpendArgs {
  network: "preprod" | "preview" | "test" | "mainnet";
  addresses: SeedelfAddresses;
  provider: ChainProvider;
  /**
   * Optional wallet. Required only when the chosen collateral provider
   * needs a wallet signature (the `WalletProvider` fallback on networks
   * without a pinned giveme.my host). The canonical `GivemeMyProvider`
   * path is wallet-anonymous.
   */
  wallet?: LovejoinWallet;
  /** Seedelf UTxOs being consumed. ≥ 1. Funds, not registers (see SeedelfPanel). */
  inputs: ReadonlyArray<SeedelfSpendInput>;
  /** Where the payment goes. See {@link SeedelfSpendDestination}. */
  destination: SeedelfSpendDestination;
  /**
   * Lovelace to deliver to `destination`. Omit to deliver everything
   * (`sum(inputs) − fee`) with no change output. When set, the remainder
   * `sum(inputs) − amountLovelace − fee` becomes a change output (when it
   * clears the chain min-UTxO; see {@link SEEDELF_MIN_CHANGE_LOVELACE}).
   */
  amountLovelace?: Lovelace;
  /**
   * The register the change output re-randomizes back to — must be one
   * the spender owns so they can spend the change later. Omit to let the
   * SDK pick one of the input UTxOs' registers at random and re-randomize
   * that. Ignored when no change output is emitted.
   */
  changeRegister?: SeedelfRegister;
  /**
   * Optional ephemeral signer. Auto-generated when omitted. Caller-
   * supplied keys are useful for tests; in production let the SDK
   * generate (and forget) a fresh key per tx.
   */
  ephemeralKey?: SeedelfEphemeralKey;
  /**
   * Collateral provider. Defaults to `GivemeMyProvider` for the active
   * network — the protocol's stealth guarantee depends on no wallet input
   * appearing on the tx. Falls back to `WalletProvider` only when the
   * network has no pinned host (e.g. `preview`).
   */
  collateralProvider?: CollateralProvider;
  /**
   * Initial fee estimate for the first build pass. The evaluator returns
   * real exec units; the second pass re-balances output value against the
   * actual minimum fee. Default 1.0 ADA — above the empirical Seedelf
   * spend fee so the first pass coin-balance is feasible.
   */
  feeEstimateLovelace?: Lovelace;
  /** If true, sign but don't submit. */
  signOnly?: boolean;
}

export interface SeedelfSpendResult {
  signedTxHex: string;
  /** Tx id; empty when `signOnly` skipped submission. */
  txId: Hex32;
  /** The plan (proofs) the tx was built from. */
  plan: SeedelfSpendPlan;
  /** Final fee paid (in lovelace). */
  feeLovelace: Lovelace;
  /** Lovelace delivered to the destination. */
  destinationLovelace: Lovelace;
  /** Change returned to a re-randomized register, or null when none was emitted. */
  changeLovelace: Lovelace | null;
}

const DEFAULT_FEE_ESTIMATE_LOVELACE: Lovelace = 1_000_000n;

/**
 * Conservative lower bound for a change output's lovelace. A Seedelf
 * register output (enterprise script address + ada-only value + a
 * `Constr 0 [bytes(48), bytes(48)]` inline datum) needs roughly 1.3 ADA
 * of min-UTxO under Conway's `coinsPerUtxoByte = 4310`. We pin a 1.5 ADA
 * floor so a change output is never built below the real chain minimum;
 * a remainder between the real min and this floor surfaces as an explicit
 * "adjust the amount" error rather than a silent mesh-csl rejection.
 */
export const SEEDELF_MIN_CHANGE_LOVELACE: Lovelace = 1_500_000n;

/** Resolved per-pass output sizing. */
interface SpendOutputs {
  /** Lovelace on the destination output. */
  destinationLovelace: Lovelace;
  /** Lovelace on the change output, or null when no change is emitted. */
  changeLovelace: Lovelace | null;
}

/**
 * Build, sign, and (optionally) submit a Seedelf spend tx.
 *
 * Wiring mirrors Lovejoin's Mix flow: external collateral via giveme.my,
 * no wallet input or signature on the tx, an ephemeral Ed25519 key signs
 * the body, one `Proof` redeemer per input.
 *
 * Two-pass: pass 1 sizes the body with the caller's fee estimate; the
 * evaluator returns real exec units and the embedded fee is the chain
 * minimum for that body; pass 2 rebuilds with that fee pinned so the
 * destination + change outputs balance the tx exactly. Schnorr proofs and
 * the re-randomization scalars are fixed across passes, so only the
 * lovelace amounts move.
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
  if (args.amountLovelace !== undefined && args.amountLovelace <= 0n) {
    throw new Error("Seedelf spend: amountLovelace must be positive when set");
  }

  // Toxic-waste re-randomization scalars, drawn once and reused across
  // both build passes so the output datum bytes are stable:
  //   * `dDest`  re-randomizes the recipient register (seedelf destination).
  //   * `dChange` re-randomizes the change register.
  const dDest = args.destination.kind === "seedelf" ? drawRerandomizationScalar() : null;
  const dChange = drawRerandomizationScalar();

  // The change register: caller-supplied, or a random input's register.
  // Either way it's re-randomized before it hits the chain, so the change
  // UTxO is unlinkable to the register it derived from.
  const changeBaseRegister =
    args.changeRegister ?? args.inputs[randomIndex(args.inputs.length)]!.register;

  // Resolve destination + change lovelace for a given fee. The remainder
  // rule: `sum(inputs) − amount − fee` is the change; it is only emitted
  // when it clears SEEDELF_MIN_CHANGE_LOVELACE. A remainder strictly
  // between zero and that floor is an error — the caller must spend all
  // (omit amountLovelace) or pick a different amount.
  const resolveOutputs = (fee: Lovelace): SpendOutputs => {
    if (args.amountLovelace === undefined) {
      const destinationLovelace = totalInputLovelace - fee;
      if (destinationLovelace <= 0n) {
        throw new Error(
          `Seedelf spend: inputs (${totalInputLovelace}) cannot cover the fee (${fee})`,
        );
      }
      return { destinationLovelace, changeLovelace: null };
    }
    const amount = args.amountLovelace;
    const remainder = totalInputLovelace - amount - fee;
    if (remainder < 0n) {
      throw new Error(
        `Seedelf spend: inputs (${totalInputLovelace}) cannot cover amount (${amount}) + fee (${fee})`,
      );
    }
    if (remainder === 0n) {
      return { destinationLovelace: amount, changeLovelace: null };
    }
    if (remainder < SEEDELF_MIN_CHANGE_LOVELACE) {
      throw new Error(
        `Seedelf spend: change would be ${remainder} lovelace, below the ${SEEDELF_MIN_CHANGE_LOVELACE} ` +
          `min-UTxO floor. Spend the whole input (omit amountLovelace) or pick a different amount.`,
      );
    }
    return { destinationLovelace: amount, changeLovelace: remainder };
  };

  // The proofs are output-independent — plan them once.
  const plan = planSeedelfSpendTx({
    addresses: args.addresses,
    inputs: args.inputs,
    ephemeralSignerVkh: ephemeralKey.vkh,
  });

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
  const walletContractAddress = seedelfWalletAddressBech32(args.addresses);

  // Mesh needs a change address even when no wallet change is emitted.
  // With a wallet present, use it; otherwise the collateral input's
  // address so any (impossible) leftover lands back at the host.
  const changeAddress = args.wallet
    ? await args.wallet.getChangeAddress()
    : preparedCollateral.inputs[0]!.address;

  const populate = (
    tx: InstanceType<typeof MeshTxBuilder>,
    redeemerHexForInput: (i: number) => string,
    fee: Lovelace,
  ) => {
    const outputs = resolveOutputs(fee);

    // NOTE: the wallet validator's reference script lives at
    // `plan.walletReferenceUtxoRef`. We attach it per-input via
    // `spendingTxInReference`, which doubles as the read-only reference
    // declaration. A separate `readOnlyTxInReference` on the SAME UTxO
    // would register it twice with different scriptSize values, tripping
    // mesh-csl's "Different script sizes for the same ref input" error.
    for (let i = 0; i < args.inputs.length; i++) {
      const inp = args.inputs[i]!;
      tx.spendingPlutusScriptV3()
        .txIn(
          inp.ref.txId,
          inp.ref.outputIndex,
          [{ unit: "lovelace", quantity: inp.lovelace.toString() }],
          walletContractAddress,
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

    // Destination output.
    if (args.destination.kind === "external") {
      tx.txOut(args.destination.addressBech32, [
        { unit: "lovelace", quantity: outputs.destinationLovelace.toString() },
      ]);
    } else {
      const recipient = rerandomizeRegister(args.destination.recipientRegister, dDest!);
      tx.txOut(walletContractAddress, [
        { unit: "lovelace", quantity: outputs.destinationLovelace.toString() },
      ]).txOutInlineDatumValue(encodeRegisterDatum(recipient), "CBOR");
    }

    // Change output — a re-randomized register the spender owns.
    if (outputs.changeLovelace !== null) {
      const change = rerandomizeRegister(changeBaseRegister, dChange);
      tx.txOut(walletContractAddress, [
        { unit: "lovelace", quantity: outputs.changeLovelace.toString() },
      ]).txOutInlineDatumValue(encodeRegisterDatum(change), "CBOR");
    }

    // Required signer: the ephemeral pkh must appear in extra_signatories.
    tx.requiredSignerHash(toHex(ephemeralKey.vkh));
    // External host's pkh (when present) must also be in required_signers.
    if (preparedCollateral.requiredSignerPkhHex) {
      tx.requiredSignerHash(preparedCollateral.requiredSignerPkhHex);
    }

    for (const utxo of preparedCollateral.inputs) {
      tx.txInCollateral(
        utxo.ref.txId,
        utxo.ref.outputIndex,
        [{ unit: "lovelace", quantity: utxo.lovelace.toString() }],
        utxo.address,
      );
    }

    // Pin the fee so destination + change balance the inputs exactly.
    tx.setFee(fee.toString());
    tx.changeAddress(changeAddress);
    // No wallet input on a stealth spend — selectUtxosFrom([]) blocks
    // mesh from drawing wallet UTxOs to balance.
    tx.selectUtxosFrom([]);
  };

  const placeholderRedeemerHex = placeholderSpendRedeemerHex();
  const buildOnce = async (
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
    populate(tx, redeemerHexForInput, fee);
    return tx.complete();
  };

  // Pass 1: placeholder proofs (constant-sized so the body is sized
  // correctly for the evaluator), caller's fee estimate.
  let unsignedTxHex = await buildOnce(() => placeholderRedeemerHex, feeEstimate);

  // Pass 2: read the chain-minimum fee mesh assigned, rebuild with the
  // real proofs and that fee pinned.
  const cst = await import("@meshsdk/core-cst");
  const finalFee = extractFeeFromTx(cst, unsignedTxHex);
  unsignedTxHex = await buildOnce((i) => plan.redeemers[i]!.redeemerCborHex, finalFee);
  const finalOutputs = resolveOutputs(finalFee);

  // Sign with the ephemeral key — the on-chain `list.has(extra_signatories,
  // proof.vkh)` check requires a vkey witness for the ephemeral pkh.
  const txHash = String(cst.resolveTxHash(unsignedTxHex));
  const ephemeralSig = ephemeralKey.sign(hexToBytes(txHash));
  let signedTx = await appendVkeyWitness(unsignedTxHex, {
    vkeyHex: toHex(ephemeralKey.publicKey),
    signatureHex: toHex(ephemeralSig),
  });

  // Collateral host witness (when external). With wallet collateral,
  // signTxBody returns null and the wallet signs via the path below.
  if (preparedCollateral.externallySigned) {
    const hostWitness = await collateral.signTxBody(signedTx);
    if (!hostWitness) {
      throw new Error(
        "Seedelf spend: collateral provider claimed externallySigned but signTxBody() returned null",
      );
    }
    signedTx = await appendVkeyWitness(signedTx, hostWitness);
  } else {
    if (!args.wallet) {
      throw new Error("Seedelf spend: wallet collateral was selected but no wallet was supplied");
    }
    signedTx = await args.wallet.signTx(signedTx, true);
  }

  const result: Omit<SeedelfSpendResult, "txId"> = {
    signedTxHex: signedTx,
    plan,
    feeLovelace: finalFee,
    destinationLovelace: finalOutputs.destinationLovelace,
    changeLovelace: finalOutputs.changeLovelace,
  };
  if (args.signOnly) {
    return { ...result, txId: "" };
  }
  const txId = await args.provider.submitTx(signedTx);
  return { ...result, txId };
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
  const fee = tx.body().fee();
  return typeof fee === "bigint" ? fee : BigInt(fee);
}

/** Uniform random index in [0, n). Used to pick a default change register. */
function randomIndex(n: number): number {
  if (n <= 1) return 0;
  const buf = new Uint8Array(4);
  globalThis.crypto.getRandomValues(buf);
  const u = (buf[0]! << 24) | (buf[1]! << 16) | (buf[2]! << 8) | buf[3]!;
  return (u >>> 0) % n;
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
