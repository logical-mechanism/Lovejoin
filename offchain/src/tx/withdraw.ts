// Withdraw tx builder.
//
// Spec:
//   * docs/spec/01-protocol.md §"Withdraw" — tx structure (mix-box input
//     spent via Owner(SchnorrProof), wallet covers fee + collateral).
//   * docs/spec/03-contracts.md §2 (Owner branch) — the on-chain rules.
//   * docs/spec/04-offchain.md §"buildWithdrawTx".
//
// Architecture:
//
//   The Owner Schnorr proof binds to
//
//       ctx = blake2b_256( serialise_data(self.outputs) || mix_script_hash )
//
//   so the proof can only authorize this specific output configuration —
//   substitution invalidates it. That `serialise_data(self.outputs)` is
//   Aiken's canonical Plutus-Data CBOR of the entire tx output list, with
//   change + collateral-return + everything mesh decides to add.
//
//   The build is therefore two-pass:
//     1. Build with a placeholder Schnorr proof of the correct shape.
//        Extract the resulting outputs from the unsigned tx body.
//     2. Compute ctx + the real Schnorr proof against those outputs.
//     3. Rebuild the tx with the real proof. Same inputs, same outputs,
//        same redeemer size → same fee → byte-identical body except for
//        the redeemer field of the withdrawal.
//     4. Sign + submit.
//
//   Because the on-chain validator's `serialise_data` is the Plutus encoding
//   of `tx.outputs` as it appears in the script context, we need an
//   encoder that matches it exactly. We rely on mesh's CST bindings
//   (Cardano-SDK Serialization) to produce the canonical encoding. If
//   encoding parity ever drifts, the integration test on Preprod fails
//   loudly — the localized helper `serializeOutputsForCtx` is the single
//   point to debug.

import { Encoder, Tag } from "cbor-x";

import {
  type G1Point,
  type Scalar,
  blake2b256,
  pointFromBytes,
  pointToBytes,
  proveSchnorr,
  publicPoint,
  SCALAR_BYTES,
  G1_COMPRESSED_BYTES,
  scalarMul,
  pointEqual,
} from "../crypto/index.js";
import type {
  ChainProvider,
  Lovelace,
  Utxo,
  UtxoRef,
} from "../chain/provider.js";
import {
  type CollateralProvider,
  WalletProvider,
} from "./collateral.js";
import { mergeExternalCollateralWitness } from "./witness-merge.js";
import { getMeshProvider } from "./mesh-bridge.js";
import {
  fetchProtocolParams,
  type LovejoinAddresses,
  type ProtocolParams,
  parseUtxoRef,
} from "./params.js";
import {
  type LovejoinNetworkId,
  type LovejoinWallet,
  meshUtxoToLovejoin,
  networkIdFor,
  normalizeWalletUtxos,
} from "../wallet/cip30.js";
import {
  assertOwnerSecret,
  deriveOwner,
  encodeMixDatum,
  type OwnerSecretMaterial,
} from "./deposit.js";

const cborEncoder = new Encoder();

// ---------------------------------------------------------------------------
// Pure planning
// ---------------------------------------------------------------------------

/**
 * The information we know about a Lovejoin mix-box: its on-chain ref + the
 * a/b points from its inline datum. The owner secret is *not* in the box
 * datum (only the public points are).
 */
export interface MixBoxRef {
  ref: UtxoRef;
  a: Uint8Array; // 48-byte compressed BLS12-381 G1
  b: Uint8Array; // 48-byte compressed BLS12-381 G1
  /** Resolved on-chain UTxO; if known, used to fill in mesh's tx-input. */
  utxo?: Utxo;
}

export interface WithdrawPlan {
  /** Destination of the funds (any Cardano address; can be a Seedelf). */
  destinationAddressBech32: string;
  /** Always = denomLovelace from the protocol params. */
  destinationLovelace: Lovelace;
  /** Mix-box input being spent. */
  mixBoxInput: MixBoxRef;
  /** Reference UTxO ref for the protocol params. */
  referenceUtxoRef: UtxoRef;
  /** mix_logic CIP-33 reference-script UTxO ref. */
  mixLogicRefScriptUtxoRef: UtxoRef;
  /** mix_box CIP-33 reference-script UTxO ref. */
  mixBoxRefScriptUtxoRef: UtxoRef;
  /** Bech32 of the mix_logic stake-script reward address (for withdraw-zero). */
  mixLogicRewardAddressBech32: string;
}

export interface PlanWithdrawArgs {
  ownerSecret: Scalar;
  /** Mix-box being spent. The `(a, b)` are mandatory; the `utxo` is optional but recommended. */
  mixBox: MixBoxRef;
  /** Where the denom-ADA goes. */
  destinationAddressBech32: string;
  params: ProtocolParams;
  addresses: LovejoinAddresses;
  networkId: LovejoinNetworkId;
}

/**
 * Validate the owner secret matches the box's `(a, b)` (i.e. `b == [x]·a`)
 * and assemble the static parts of a Withdraw tx. Does NOT compute the
 * Schnorr proof — that requires knowing the final outputs, which depends
 * on mesh's coin selection.
 */
export function planWithdrawTx(args: PlanWithdrawArgs): WithdrawPlan {
  assertOwnerSecret(args.ownerSecret);
  if (args.mixBox.a.length !== G1_COMPRESSED_BYTES) {
    throw new Error(`mixBox.a must be ${G1_COMPRESSED_BYTES} bytes, got ${args.mixBox.a.length}`);
  }
  if (args.mixBox.b.length !== G1_COMPRESSED_BYTES) {
    throw new Error(`mixBox.b must be ${G1_COMPRESSED_BYTES} bytes, got ${args.mixBox.b.length}`);
  }

  const aPoint = pointFromBytes(args.mixBox.a);
  const bPoint = pointFromBytes(args.mixBox.b);
  // Ownership check: b == [x]·a. This is the math the validator's Schnorr
  // verifier is going to enforce. Catch user-error here before submitting.
  if (!pointEqual(scalarMul(args.ownerSecret, aPoint), bPoint)) {
    throw new Error(
      "withdraw: ownerSecret does not unlock this mix-box (b ≠ [x]·a). " +
      "Check that the box ref + secret pair are correct.",
    );
  }
  // The mix_logic stake-script reward address is bech32 with HRP
  // stake_test/stake (testnet/mainnet) and a credential header byte
  // 0xE0/0xE1 for script-stake. Mesh's tx builder takes the reward
  // address bech32 as the `withdrawal` argument.
  const mixLogicRewardAddressBech32 = buildScriptRewardAddress(
    args.params.mixLogicScriptHash,
    args.networkId,
  );

  return {
    destinationAddressBech32: args.destinationAddressBech32,
    destinationLovelace: args.params.denomLovelace,
    mixBoxInput: args.mixBox,
    referenceUtxoRef: parseUtxoRef(args.addresses.referenceUtxoRef),
    mixLogicRefScriptUtxoRef: parseUtxoRef(args.addresses.referenceScriptUtxos.mix_logic),
    mixBoxRefScriptUtxoRef: parseUtxoRef(args.addresses.referenceScriptUtxos.mix_box),
    mixLogicRewardAddressBech32,
  };
}

// ---------------------------------------------------------------------------
// Schnorr helpers — reusable for testing
// ---------------------------------------------------------------------------

/**
 * Compute the Owner-branch Fiat-Shamir context.
 *
 *   ctx = blake2b_256( serialise_data(outputs) || mix_script_hash )
 *
 * `outputsCbor` MUST be the canonical Plutus-Data CBOR of `self.outputs` as
 * the Aiken validator sees it. See `serializeOutputsForCtx` for the helper
 * that produces this from a built tx.
 */
export function computeOwnerCtx(args: {
  outputsCbor: Uint8Array;
  mixScriptHashHex: string;
}): Uint8Array {
  const hashBytes = hexToBytes(args.mixScriptHashHex);
  if (hashBytes.length !== 28) {
    throw new Error(`mix_script_hash must be 28 bytes, got ${hashBytes.length}`);
  }
  const preimage = new Uint8Array(args.outputsCbor.length + hashBytes.length);
  preimage.set(args.outputsCbor, 0);
  preimage.set(hashBytes, args.outputsCbor.length);
  return blake2b256(preimage);
}

/**
 * Build the Owner redeemer's Plutus-Data CBOR.
 *
 *   MixLogicRedeemer.Owner { proofs: List<SchnorrProof> }
 *     → Constr 0 [ List [Constr 0 [bytes(t, 48), bytes(z, 32)], ...] ]
 *
 * Single-input withdraws pass a 1-element list. Bulk withdraws pass N.
 * Empty lists are rejected on chain (`n >= 1`); we let the validator
 * enforce it rather than duplicating the rule here.
 */
export function encodeOwnerRedeemer(args: {
  proofs: ReadonlyArray<{ t: Uint8Array; z: Uint8Array }>;
}): string {
  for (const p of args.proofs) {
    if (p.t.length !== G1_COMPRESSED_BYTES) {
      throw new Error(`SchnorrProof.t must be ${G1_COMPRESSED_BYTES} bytes`);
    }
    if (p.z.length !== SCALAR_BYTES) {
      throw new Error(`SchnorrProof.z must be ${SCALAR_BYTES} bytes`);
    }
  }
  const proofTags = args.proofs.map(
    (p) => new Tag([Buffer.from(p.t), Buffer.from(p.z)], 121),
  );
  const outer = new Tag([proofTags], 121); // Constr 0 — MixLogicRedeemer.Owner
  return bytesToHex(cborEncoder.encode(outer));
}

/**
 * Placeholder Owner redeemer with N zero-bytes Schnorr proofs — used for
 * the first build pass so mesh can size the redeemer and compute fees +
 * exec units against a fixed-shape redeemer. The real proofs replace the
 * placeholders before signing. `n` must match the number of mix inputs in
 * the tx; otherwise the validator rejects on `proofs.length == n`.
 */
export function placeholderOwnerRedeemerCborHex(n: number): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`placeholderOwnerRedeemerCborHex: n must be >= 1, got ${n}`);
  }
  const proofs = Array.from({ length: n }, () => ({
    t: new Uint8Array(G1_COMPRESSED_BYTES),
    z: new Uint8Array(SCALAR_BYTES),
  }));
  return encodeOwnerRedeemer({ proofs });
}

/** Pre-computed N=1 placeholder for the single-input withdraw fast path. */
export const PLACEHOLDER_OWNER_REDEEMER_CBOR_HEX: string =
  placeholderOwnerRedeemerCborHex(1);

/**
 * Generate the Schnorr proof for the Owner branch.
 *
 * Statement: prover knows `x` such that `b = [x]·a`. The Schnorr base is the
 * mix-box's `a`, not the canonical generator g — `verifySchnorr(base=a, point=b, …)`
 * is what `mix_logic.ak` calls.
 */
export function generateOwnerSchnorrProof(args: {
  ownerSecret: Scalar;
  a: Uint8Array; // 48-byte compressed
  b: Uint8Array; // 48-byte compressed (b = [x]a)
  ctx: Uint8Array; // 32-byte blake2b challenge from computeOwnerCtx
}): { t: Uint8Array; z: Uint8Array } {
  assertOwnerSecret(args.ownerSecret);
  const a: G1Point = pointFromBytes(args.a);
  // Sanity: b == [x]a. (planWithdrawTx already checked, but cheap to repeat.)
  const bExpected = scalarMul(args.ownerSecret, a);
  const bGiven = pointFromBytes(args.b);
  if (!pointEqual(bExpected, bGiven)) {
    throw new Error("generateOwnerSchnorrProof: b ≠ [x]·a (ownerSecret mismatch)");
  }
  const proof = proveSchnorr(a, args.ownerSecret, args.ctx);
  return { t: proof.t, z: proof.z };
}

// ---------------------------------------------------------------------------
// buildWithdrawTx — drives mesh
// ---------------------------------------------------------------------------

export interface BuildWithdrawArgs {
  network: "preprod" | "preview" | "test" | "mainnet";
  ownerSecret: Scalar;
  mixBox: MixBoxRef;
  destinationAddressBech32: string;
  wallet: LovejoinWallet;
  provider: ChainProvider;
  addresses: LovejoinAddresses;
  collateralProvider?: CollateralProvider;
  signOnly?: boolean;
}

export interface WithdrawResult {
  signedTxHex: string;
  txId: string;
  /** Owner material; same secret in, useful for caller logging. */
  owner: OwnerSecretMaterial;
}

/**
 * Build, sign, and (optionally) submit a Withdraw tx.
 *
 * Two-pass: first build with a placeholder Schnorr proof so mesh can size
 * the redeemer and compute the fee, then re-build with the real proof
 * derived from the resulting outputs.
 */
export async function buildWithdrawTx(args: BuildWithdrawArgs): Promise<WithdrawResult> {
  const networkId = networkIdFor(args.network);

  const { params } = await fetchProtocolParams(args.addresses, args.provider);
  const plan = planWithdrawTx({
    ownerSecret: args.ownerSecret,
    mixBox: args.mixBox,
    destinationAddressBech32: args.destinationAddressBech32,
    params,
    addresses: args.addresses,
    networkId,
  });

  const collateralProvider = args.collateralProvider ?? new WalletProvider(args.wallet);
  const preparedCollateral = await collateralProvider.prepareCollateral({
    provider: args.provider,
    collateralAmountLovelace: 5_000_000n,
  });

  // Resolve mix-box UTxO if not pre-supplied. The Aiken validator needs
  // the inline datum present — refuse to proceed if it's missing.
  const mixBoxUtxo = plan.mixBoxInput.utxo
    ?? (await args.provider.getUtxoByRef(plan.mixBoxInput.ref));
  if (!mixBoxUtxo) {
    throw new Error(`withdraw: mix-box UTxO ${plan.mixBoxInput.ref.txId}#${plan.mixBoxInput.ref.outputIndex} not found on chain`);
  }
  if (!mixBoxUtxo.inlineDatum) {
    throw new Error(`withdraw: mix-box UTxO has no inline datum — not a Lovejoin box`);
  }

  // Cross-check: the on-chain inline datum's bytes must equal what
  // encodeMixDatum produces from the (a, b) we plan to verify against.
  // Mismatch means the caller passed stale (a, b) for a different box.
  const expectedDatumHex = encodeMixDatum({ a: plan.mixBoxInput.a, b: plan.mixBoxInput.b });
  if (mixBoxUtxo.inlineDatum.toLowerCase() !== expectedDatumHex.toLowerCase()) {
    throw new Error(
      "withdraw: on-chain inline datum doesn't match mixBox.{a,b}; refusing to spend",
    );
  }

  const meshCore = await import("@meshsdk/core");
  const { MeshTxBuilder } = meshCore;
  const cst = await import("@meshsdk/core-cst");

  const walletUtxos = normalizeWalletUtxos(await args.wallet.getUtxos());
  const changeAddress = await args.wallet.getChangeAddress();
  const meshProvider = await getMeshProvider(args.provider);

  // The two-pass Schnorr build has a chicken-and-egg with mesh's
  // evaluator (placeholder proof fails the validator → no exec units), so
  // we drive the build manually:
  //
  //   1.  Build with placeholder proof + default upper-bound exec units.
  //       Outputs depend only on (redeemer size, exec units, fee), and
  //       the placeholder is the same size as the real Schnorr proof.
  //   2.  Compute proof_1 against pass-1 outputs.
  //   3.  Build with proof_1 + default exec units → call evaluator.
  //       Validator runs successfully, evaluator returns tight exec units.
  //   4.  Build with proof_1 + tight exec units → outputs change because
  //       the fee shrinks (smaller redeemer-cost component) → bigger
  //       change. Proof_1 no longer matches.
  //   5.  Compute proof_3 against pass-3 outputs.
  //   6.  Build with proof_3 + tight exec units → outputs match pass 3
  //       (same redeemer size, same exec units, same fee). Sign + submit.
  //
  // 4 builds + 1 evaluation. Schnorr proofs are constant-time, so the
  // exec units don't depend on the proof bytes — we can pin them
  // confidently across passes 4-6.
  const DEFAULT_EX_UNITS: ExUnits = { mem: 7_000_000, steps: 3_000_000_000 };
  const placeholderRedeemer = PLACEHOLDER_OWNER_REDEEMER_CBOR_HEX;
  const buildOnce = (
    redeemerCborHex: string,
    spendExUnits: ExUnits,
    withdrawExUnits: ExUnits,
  ): Promise<string> => {
    const tx = new MeshTxBuilder({
      fetcher: meshProvider as never,
      submitter: meshProvider as never,
      verbose: false,
    });
    tx
      .readOnlyTxInReference(plan.referenceUtxoRef.txId, plan.referenceUtxoRef.outputIndex)
      // Mix-box spend: pass-through under the withdraw-zero credential.
      // mix_box's spend redeemer is irrelevant data — it doesn't dispatch.
      .spendingPlutusScriptV3()
      .txIn(
        mixBoxUtxo.ref.txId,
        mixBoxUtxo.ref.outputIndex,
        [{ unit: "lovelace", quantity: mixBoxUtxo.lovelace.toString() }],
        mixBoxUtxo.address,
      )
      .txInInlineDatumPresent()
      .txInRedeemerValue("d87980", "CBOR", spendExUnits) // Constr 0 [] — spend redeemer is unused
      .spendingTxInReference(
        plan.mixBoxRefScriptUtxoRef.txId,
        plan.mixBoxRefScriptUtxoRef.outputIndex,
        // mesh's `(txHash, txIndex, scriptSize?, scriptHash?)`. Without
        // these mesh derived an empty hash downstream and CSL bailed on
        // "expected hash length 28 but got Len(0)"; the size is needed
        // for accurate fee computation (size-based component).
        sizeStr(args.addresses.referenceScriptSizes?.mix_box),
        args.addresses.mixBoxScriptHash,
      )
      // Withdrawal-zero on the mix_logic stake credential — this is what
      // actually runs the Owner branch.
      .withdrawalPlutusScriptV3()
      .withdrawal(plan.mixLogicRewardAddressBech32, "0")
      .withdrawalRedeemerValue(redeemerCborHex, "CBOR", withdrawExUnits)
      .withdrawalTxInReference(
        plan.mixLogicRefScriptUtxoRef.txId,
        plan.mixLogicRefScriptUtxoRef.outputIndex,
        sizeStr(args.addresses.referenceScriptSizes?.mix_logic),
        params.mixLogicScriptHash,
      )
      // Output 0: destination.
      .txOut(plan.destinationAddressBech32, [
        { unit: "lovelace", quantity: plan.destinationLovelace.toString() },
      ])
      .changeAddress(changeAddress)
      .selectUtxosFrom(walletUtxos);
    for (const utxo of preparedCollateral.inputs) {
      tx.txInCollateral(
        utxo.ref.txId,
        utxo.ref.outputIndex,
        [{ unit: "lovelace", quantity: utxo.lovelace.toString() }],
        utxo.address,
      );
    }
    if (preparedCollateral.requiredSignerPkhHex) {
      tx.requiredSignerHash(preparedCollateral.requiredSignerPkhHex);
    }
    return tx.complete();
  };

  const computeProofForOutputs = (txCborHex: string): string => {
    const outputsCbor = serializeOutputsForCtx(txCborHex, cst);
    const ctx = computeOwnerCtx({
      outputsCbor,
      mixScriptHashHex: params.mixScriptHash,
    });
    const proof = generateOwnerSchnorrProof({
      ownerSecret: args.ownerSecret,
      a: plan.mixBoxInput.a,
      b: plan.mixBoxInput.b,
      ctx,
    });
    return encodeOwnerRedeemer({ proofs: [{ t: proof.t, z: proof.z }] });
  };

  // 1: placeholder + default exec units.
  const txPlaceholder = await buildOnce(
    placeholderRedeemer,
    DEFAULT_EX_UNITS,
    DEFAULT_EX_UNITS,
  );
  // 2: proof against placeholder outputs.
  const proof1 = computeProofForOutputs(txPlaceholder);
  // 3: proof_1 + default exec units → real evaluation.
  const txForEval = await buildOnce(proof1, DEFAULT_EX_UNITS, DEFAULT_EX_UNITS);
  const tightUnits = await evaluateExUnits(meshProvider, txForEval);
  // 4: proof_1 + tight exec units → outputs shift (fee shrinks).
  const txTightOutputs = await buildOnce(
    proof1,
    tightUnits.spend,
    tightUnits.withdraw,
  );
  // 5: re-compute proof against the new outputs.
  const proof3 = computeProofForOutputs(txTightOutputs);
  // 6: final tx — proof_3 + tight exec units → outputs match step 4.
  const unsignedHexFinal = await buildOnce(
    proof3,
    tightUnits.spend,
    tightUnits.withdraw,
  );

  const walletSignedTx = await args.wallet.signTx(unsignedHexFinal);
  const signedTx = preparedCollateral.externallySigned
    ? await mergeExternalCollateralWitness(collateralProvider, walletSignedTx)
    : walletSignedTx;
  const owner = deriveOwner(args.ownerSecret);

  if (args.signOnly) {
    return { signedTxHex: signedTx, txId: "", owner };
  }
  const txId = await args.provider.submitTx(signedTx);
  return { signedTxHex: signedTx, txId, owner };
}

// ---------------------------------------------------------------------------
// Bulk withdraw — N inputs, N proofs, single combined destination output
// ---------------------------------------------------------------------------

/**
 * One mix-box paired with its owner secret. The SDK pairs boxes 1:1 with
 * proofs in the redeemer; per-input ordering is fixed below by sorting on
 * `(txId, outputIndex)` to match Aiken's ledger-supplied input order.
 */
export interface BulkWithdrawEntry {
  mixBox: MixBoxRef;
  ownerSecret: Scalar;
}

export interface BuildBulkWithdrawArgs {
  network: "preprod" | "preview" | "test" | "mainnet";
  /** N ≥ 1 mix-boxes to spend in a single tx, each with its owner secret. */
  entries: ReadonlyArray<BulkWithdrawEntry>;
  /** Single destination address that receives `N × denom_lovelace`. */
  destinationAddressBech32: string;
  wallet: LovejoinWallet;
  provider: ChainProvider;
  addresses: LovejoinAddresses;
  collateralProvider?: CollateralProvider;
  signOnly?: boolean;
}

export interface BulkWithdrawResult {
  signedTxHex: string;
  txId: string;
  /** Owner material per input, in the same order as `entries` after sorting. */
  owners: OwnerSecretMaterial[];
  /** N — the number of mix-boxes spent. */
  count: number;
  /** Total lovelace sent to the destination (`N × denom_lovelace`). */
  totalLovelace: Lovelace;
}

/**
 * Build, sign, and (optionally) submit a bulk-withdraw tx that spends N ≥ 1
 * mix-boxes via the Owner branch and forwards their combined denom-ADA to a
 * single destination address.
 *
 * Per-input proofs all bind to the same `ctx` (the tx's full output set).
 * Output substitution invalidates every proof; an attacker who reuses some
 * subset of proofs in another tx must produce identical outputs AND an
 * identical input set, since each Schnorr is bound to its own (a_i, b_i).
 *
 * Inputs are sorted by `(txId, outputIndex)` before proof generation so the
 * proofs[i] in the redeemer pairs with the i-th input in Aiken's
 * `tx.inputs` (which is already lex-sorted by the ledger). Mismatched
 * pairing would fail every proof on chain.
 */
export async function buildBulkWithdrawTx(
  args: BuildBulkWithdrawArgs,
): Promise<BulkWithdrawResult> {
  if (args.entries.length === 0) {
    throw new Error("buildBulkWithdrawTx: entries must contain at least one box");
  }
  const networkId = networkIdFor(args.network);
  const { params } = await fetchProtocolParams(args.addresses, args.provider);

  // Sort entries by (txId asc, outputIndex asc) — matches the ledger's
  // canonical input ordering. The validator's `collect_well_formed_mix_inputs`
  // walks `tx.inputs` in that same order, so `proofs[i]` MUST line up.
  const entries = [...args.entries].sort((a, b) => {
    if (a.mixBox.ref.txId !== b.mixBox.ref.txId) {
      return a.mixBox.ref.txId < b.mixBox.ref.txId ? -1 : 1;
    }
    return a.mixBox.ref.outputIndex - b.mixBox.ref.outputIndex;
  });
  const n = entries.length;

  // Per-entry validation: secret unlocks box, points are right shape.
  for (const e of entries) {
    assertOwnerSecret(e.ownerSecret);
    if (e.mixBox.a.length !== G1_COMPRESSED_BYTES) {
      throw new Error(`mixBox.a must be ${G1_COMPRESSED_BYTES} bytes`);
    }
    if (e.mixBox.b.length !== G1_COMPRESSED_BYTES) {
      throw new Error(`mixBox.b must be ${G1_COMPRESSED_BYTES} bytes`);
    }
    const a = pointFromBytes(e.mixBox.a);
    const bGiven = pointFromBytes(e.mixBox.b);
    if (!pointEqual(scalarMul(e.ownerSecret, a), bGiven)) {
      throw new Error(
        `bulk withdraw: ownerSecret does not unlock mix-box ${e.mixBox.ref.txId}#${e.mixBox.ref.outputIndex} (b ≠ [x]·a)`,
      );
    }
  }

  // Resolve every input UTxO + cross-check inline datum bytes.
  const mixBoxUtxos: Utxo[] = [];
  for (const e of entries) {
    const u = e.mixBox.utxo
      ?? (await args.provider.getUtxoByRef(e.mixBox.ref));
    if (!u) {
      throw new Error(
        `bulk withdraw: mix-box UTxO ${e.mixBox.ref.txId}#${e.mixBox.ref.outputIndex} not found on chain`,
      );
    }
    if (!u.inlineDatum) {
      throw new Error(
        `bulk withdraw: mix-box ${e.mixBox.ref.txId}#${e.mixBox.ref.outputIndex} has no inline datum`,
      );
    }
    const expectedHex = encodeMixDatum({ a: e.mixBox.a, b: e.mixBox.b });
    if (u.inlineDatum.toLowerCase() !== expectedHex.toLowerCase()) {
      throw new Error(
        `bulk withdraw: on-chain inline datum for ${e.mixBox.ref.txId}#${e.mixBox.ref.outputIndex} doesn't match (a, b)`,
      );
    }
    mixBoxUtxos.push(u);
  }

  const mixLogicRewardAddressBech32 = buildScriptRewardAddress(
    params.mixLogicScriptHash,
    networkId,
  );
  const referenceUtxoRef = parseUtxoRef(args.addresses.referenceUtxoRef);
  const mixLogicRefScriptUtxoRef = parseUtxoRef(
    args.addresses.referenceScriptUtxos.mix_logic,
  );
  const mixBoxRefScriptUtxoRef = parseUtxoRef(
    args.addresses.referenceScriptUtxos.mix_box,
  );
  const totalLovelace: Lovelace = params.denomLovelace * BigInt(n);

  const collateralProvider = args.collateralProvider ?? new WalletProvider(args.wallet);
  const preparedCollateral = await collateralProvider.prepareCollateral({
    provider: args.provider,
    collateralAmountLovelace: 5_000_000n,
  });

  const meshCore = await import("@meshsdk/core");
  const { MeshTxBuilder } = meshCore;
  const cst = await import("@meshsdk/core-cst");

  const walletUtxos = normalizeWalletUtxos(await args.wallet.getUtxos());
  const changeAddress = await args.wallet.getChangeAddress();
  const meshProvider = await getMeshProvider(args.provider);

  // Same two-pass-into-six-build dance as single-input withdraw — see
  // `buildWithdrawTx` for the rationale. The only differences here are:
  //   * N spend-script inputs (each gets its own SPEND redeemer; mesh's
  //     evaluator returns one tight unit per spend redeemer)
  //   * single combined destination output of `N × denom`
  //   * placeholder/real owner redeemer carries N proofs
  const DEFAULT_EX_UNITS: ExUnits = { mem: 7_000_000, steps: 3_000_000_000 };
  const placeholderRedeemer = placeholderOwnerRedeemerCborHex(n);

  type TightUnits = { spends: ExUnits[]; withdraw: ExUnits };
  const buildOnce = (
    redeemerCborHex: string,
    spendUnitsForInput: (i: number) => ExUnits,
    withdrawExUnits: ExUnits,
  ): Promise<string> => {
    const tx = new MeshTxBuilder({
      fetcher: meshProvider as never,
      submitter: meshProvider as never,
      verbose: false,
    });
    tx.readOnlyTxInReference(referenceUtxoRef.txId, referenceUtxoRef.outputIndex);
    mixBoxUtxos.forEach((u, i) => {
      tx
        .spendingPlutusScriptV3()
        .txIn(u.ref.txId, u.ref.outputIndex, [
          { unit: "lovelace", quantity: u.lovelace.toString() },
        ], u.address)
        .txInInlineDatumPresent()
        .txInRedeemerValue("d87980", "CBOR", spendUnitsForInput(i))
        .spendingTxInReference(
          mixBoxRefScriptUtxoRef.txId,
          mixBoxRefScriptUtxoRef.outputIndex,
          sizeStr(args.addresses.referenceScriptSizes?.mix_box),
          args.addresses.mixBoxScriptHash,
        );
    });
    tx
      .withdrawalPlutusScriptV3()
      .withdrawal(mixLogicRewardAddressBech32, "0")
      .withdrawalRedeemerValue(redeemerCborHex, "CBOR", withdrawExUnits)
      .withdrawalTxInReference(
        mixLogicRefScriptUtxoRef.txId,
        mixLogicRefScriptUtxoRef.outputIndex,
        sizeStr(args.addresses.referenceScriptSizes?.mix_logic),
        params.mixLogicScriptHash,
      )
      // Output 0: combined destination.
      .txOut(args.destinationAddressBech32, [
        { unit: "lovelace", quantity: totalLovelace.toString() },
      ])
      .changeAddress(changeAddress)
      .selectUtxosFrom(walletUtxos);
    for (const utxo of preparedCollateral.inputs) {
      tx.txInCollateral(
        utxo.ref.txId,
        utxo.ref.outputIndex,
        [{ unit: "lovelace", quantity: utxo.lovelace.toString() }],
        utxo.address,
      );
    }
    if (preparedCollateral.requiredSignerPkhHex) {
      tx.requiredSignerHash(preparedCollateral.requiredSignerPkhHex);
    }
    return tx.complete();
  };

  const computeRedeemerForOutputs = (txCborHex: string): string => {
    const outputsCbor = serializeOutputsForCtx(txCborHex, cst);
    const ctx = computeOwnerCtx({
      outputsCbor,
      mixScriptHashHex: params.mixScriptHash,
    });
    const proofs = entries.map((e) => {
      const proof = generateOwnerSchnorrProof({
        ownerSecret: e.ownerSecret,
        a: e.mixBox.a,
        b: e.mixBox.b,
        ctx,
      });
      return { t: proof.t, z: proof.z };
    });
    return encodeOwnerRedeemer({ proofs });
  };

  // Pass 1: placeholder + default exec units.
  const txPlaceholder = await buildOnce(
    placeholderRedeemer,
    () => DEFAULT_EX_UNITS,
    DEFAULT_EX_UNITS,
  );
  // Pass 2: real proofs against placeholder outputs.
  const proof1 = computeRedeemerForOutputs(txPlaceholder);
  // Pass 3: proof_1 + default exec units → run evaluator.
  const txForEval = await buildOnce(proof1, () => DEFAULT_EX_UNITS, DEFAULT_EX_UNITS);
  const tightUnits = await evaluateBulkExUnits(meshProvider, txForEval, n);
  // Pass 4: proof_1 + tight units → outputs shift (fee shrinks).
  const txTightOutputs = await buildOnce(
    proof1,
    (i) => tightUnits.spends[i] ?? DEFAULT_EX_UNITS,
    tightUnits.withdraw,
  );
  // Pass 5: proofs against the new outputs.
  const proof3 = computeRedeemerForOutputs(txTightOutputs);
  // Pass 6: final tx.
  const unsignedHexFinal = await buildOnce(
    proof3,
    (i) => tightUnits.spends[i] ?? DEFAULT_EX_UNITS,
    tightUnits.withdraw,
  );

  const walletSignedTx = await args.wallet.signTx(unsignedHexFinal);
  const signedTx = preparedCollateral.externallySigned
    ? await mergeExternalCollateralWitness(collateralProvider, walletSignedTx)
    : walletSignedTx;
  const owners = entries.map((e) => deriveOwner(e.ownerSecret, e.mixBox.a));

  if (args.signOnly) {
    return { signedTxHex: signedTx, txId: "", owners, count: n, totalLovelace };
  }
  const txId = await args.provider.submitTx(signedTx);
  return { signedTxHex: signedTx, txId, owners, count: n, totalLovelace };
}

/**
 * Mesh's evaluator for a bulk-withdraw tx: collect N SPEND units (one per
 * mix-box input) plus the single REWARD/WITHDRAW unit. SPEND units are
 * returned in redeemer-pointer order; combined with our lex-sorted inputs
 * that matches the order of `entries` after sorting.
 */
async function evaluateBulkExUnits(
  mesh: { evaluateTx(cbor: string): Promise<unknown> },
  unsignedTxCborHex: string,
  expectedSpendCount: number,
): Promise<{ spends: ExUnits[]; withdraw: ExUnits }> {
  const raw = await mesh.evaluateTx(unsignedTxCborHex);
  if (!Array.isArray(raw)) {
    throw new Error(
      `bulk withdraw evaluator: expected an array of actions, got ${typeof raw}`,
    );
  }
  const spends: ExUnits[] = [];
  let withdraw: ExUnits | null = null;
  for (const a of raw as Array<{
    tag?: string;
    budget?: { mem?: number; steps?: number };
  }>) {
    const tag = a.tag;
    const b = a.budget;
    if (!b || typeof b.mem !== "number" || typeof b.steps !== "number") continue;
    const u: ExUnits = { mem: b.mem, steps: b.steps };
    if (tag === "SPEND") spends.push(u);
    else if ((tag === "REWARD" || tag === "WITHDRAW") && !withdraw) withdraw = u;
  }
  if (spends.length !== expectedSpendCount) {
    throw new Error(
      `bulk withdraw evaluator: expected ${expectedSpendCount} SPEND units, got ${spends.length}`,
    );
  }
  if (!withdraw) {
    throw new Error(`bulk withdraw evaluator: missing REWARD/WITHDRAW unit`);
  }
  return { spends, withdraw };
}

// ---------------------------------------------------------------------------
// serialise_data(outputs) — the parity-critical encoder
// ---------------------------------------------------------------------------

/**
 * Compute the Plutus-Data CBOR of a tx's `self.outputs` as the on-chain
 * `builtin.serialise_data` would.
 *
 * Implementation: deserialize the unsigned tx hex via mesh's CST (which
 * uses cardano-sdk's serializer), enumerate each `TransactionOutput`,
 * and emit a `PlutusList` of `Constr 0 [address, value, datum, refScript]`
 * matching the Plutus V3 ledger API.
 *
 * If the on-chain validator rejects with "owner proof failed" while the
 * math looks right (see docs/spec/12-build-guide.md §"All my proofs fail
 * but the math looks right"), this is the function to debug — by an
 * order of magnitude the most likely culprit.
 */
export function serializeOutputsForCtx(
  unsignedTxCborHex: string,
  cst: typeof import("@meshsdk/core-cst"),
): Uint8Array {
  const tx = cst.deserializeTx(unsignedTxCborHex);
  const outputs = tx.body().outputs();
  const outputDatas: import("@meshsdk/core-cst").PlutusData[] = [];
  for (const out of outputs) {
    outputDatas.push(transactionOutputToPlutusData(out, cst));
  }
  const list = new cst.PlutusList();
  for (const d of outputDatas) list.add(d);
  const wrapped = cst.PlutusData.newList(list);
  return hexToBytes(wrapped.toCbor());
}

function transactionOutputToPlutusData(
  out: import("@meshsdk/core-cst").TransactionOutput,
  cst: typeof import("@meshsdk/core-cst"),
): import("@meshsdk/core-cst").PlutusData {
  // Plutus V3 TxOut = Constr 0 [Address, Value, OutputDatum, Maybe ScriptHash].
  // We rebuild via mesh's PlutusData primitives so the CBOR matches what
  // serialise_data emits inside the validator.
  const fields = new cst.PlutusList();
  fields.add(addressToPlutusData(out.address(), cst));
  fields.add(valueToPlutusData(out.amount(), cst));
  fields.add(datumToPlutusData(out, cst));
  fields.add(refScriptToPlutusData(out, cst));
  return cst.PlutusData.newConstrPlutusData(
    new cst.ConstrPlutusData(0n, fields),
  );
}

function addressToPlutusData(
  addr: import("@meshsdk/core-cst").Address,
  cst: typeof import("@meshsdk/core-cst"),
): import("@meshsdk/core-cst").PlutusData {
  // Plutus V3: Address = Constr 0 [Credential, Maybe StakingCredential].
  // Credential = Constr 0 [PubKeyHash] | Constr 1 [ScriptHash]
  // Use cardano-sdk's helpers to read the type + bytes; if the layout
  // surprises us, surface a clear error.
  const bytes = hexToBytes(addr.toBytes());
  if (bytes.length < 1) throw new Error("address payload too short");
  const header = bytes[0]!;
  const addrType = header >> 4; // upper nibble
  const paymentHashBytes = bytes.slice(1, 29);
  const stakeHashBytes = bytes.slice(29);

  // Payment credential
  const paymentList = new cst.PlutusList();
  paymentList.add(cst.PlutusData.newBytes(paymentHashBytes));
  const isPaymentScript = (addrType & 0b0001) === 0b0001 || (addrType & 0b0011) === 0b0011 || addrType === 0b0111;
  // Address-type top nibble layout (CIP-19):
  //   0 = base, key/key
  //   1 = base, script/key
  //   2 = base, key/script
  //   3 = base, script/script
  //   4 = pointer, key
  //   5 = pointer, script
  //   6 = enterprise, key
  //   7 = enterprise, script
  //   ...
  const paymentIsScript = addrType === 1 || addrType === 3 || addrType === 5 || addrType === 7;
  const paymentConstr = new cst.ConstrPlutusData(
    paymentIsScript ? 1n : 0n,
    paymentList,
  );
  const paymentData = cst.PlutusData.newConstrPlutusData(paymentConstr);
  void isPaymentScript; // (kept above for self-documentation; condition is the same)

  // Staking credential — Maybe(StakingCredential).
  // StakingCredential = Constr 0 [Credential] (Hash variant)
  //   - we only emit the StakingHash variant; pointer (rare) is intentionally
  //     unsupported for now and surfaces as None.
  let stakingMaybe: import("@meshsdk/core-cst").PlutusData;
  if (addrType <= 3 && stakeHashBytes.length === 28) {
    // Base address — has staking credential.
    const stakeIsScript = addrType === 2 || addrType === 3;
    const stakeList = new cst.PlutusList();
    stakeList.add(cst.PlutusData.newBytes(stakeHashBytes));
    const stakeCredConstr = new cst.ConstrPlutusData(stakeIsScript ? 1n : 0n, stakeList);
    const stakeCred = cst.PlutusData.newConstrPlutusData(stakeCredConstr);
    // StakingHash = Constr 0 [Credential]
    const stakingHashList = new cst.PlutusList();
    stakingHashList.add(stakeCred);
    const stakingHashConstr = new cst.ConstrPlutusData(0n, stakingHashList);
    const stakingCred = cst.PlutusData.newConstrPlutusData(stakingHashConstr);
    // Maybe.Just = Constr 0 [StakingCredential]
    const justList = new cst.PlutusList();
    justList.add(stakingCred);
    stakingMaybe = cst.PlutusData.newConstrPlutusData(
      new cst.ConstrPlutusData(0n, justList),
    );
  } else {
    // Maybe.Nothing = Constr 1 []
    stakingMaybe = cst.PlutusData.newConstrPlutusData(
      new cst.ConstrPlutusData(1n, new cst.PlutusList()),
    );
  }

  const fields = new cst.PlutusList();
  fields.add(paymentData);
  fields.add(stakingMaybe);
  return cst.PlutusData.newConstrPlutusData(new cst.ConstrPlutusData(0n, fields));
}

function valueToPlutusData(
  value: import("@meshsdk/core-cst").Value,
  cst: typeof import("@meshsdk/core-cst"),
): import("@meshsdk/core-cst").PlutusData {
  // Plutus Value = Map<PolicyId, Map<AssetName, Int>>.
  // Lovelace lives under the empty PolicyId / empty AssetName.
  const outerMap = new cst.PlutusMap();
  const lovelace = value.coin();
  const adaInner = new cst.PlutusMap();
  adaInner.insert(cst.PlutusData.newBytes(new Uint8Array(0)), cst.PlutusData.newInteger(lovelace));
  outerMap.insert(cst.PlutusData.newBytes(new Uint8Array(0)), cst.PlutusData.newMap(adaInner));

  const multiAsset = value.multiasset();
  if (multiAsset && multiAsset.size > 0) {
    // TokenMap is a flat Map<AssetId, bigint> where AssetId = policyId(28
    // bytes) || assetName(0..32 bytes), all hex. Group by policy id so
    // the Plutus-Data shape matches Map<PolicyId, Map<AssetName, Int>>.
    const grouped = new Map<string, Array<[string, bigint]>>();
    for (const [assetId, qty] of multiAsset.entries()) {
      const aid = assetId.toString();
      const policyHex = aid.slice(0, 56);
      const nameHex = aid.slice(56);
      const arr = grouped.get(policyHex) ?? [];
      arr.push([nameHex, qty]);
      grouped.set(policyHex, arr);
    }
    for (const [policyHex, names] of grouped) {
      const policyBytes = hexToBytes(policyHex);
      const inner = new cst.PlutusMap();
      for (const [nameHex, qty] of names) {
        const nameBytes = hexToBytes(nameHex);
        inner.insert(cst.PlutusData.newBytes(nameBytes), cst.PlutusData.newInteger(qty));
      }
      outerMap.insert(cst.PlutusData.newBytes(policyBytes), cst.PlutusData.newMap(inner));
    }
  }
  return cst.PlutusData.newMap(outerMap);
}

function datumToPlutusData(
  out: import("@meshsdk/core-cst").TransactionOutput,
  cst: typeof import("@meshsdk/core-cst"),
): import("@meshsdk/core-cst").PlutusData {
  // OutputDatum:
  //   NoDatum    → Constr 0 []
  //   DatumHash h → Constr 1 [bytes(32)]
  //   InlineDatum d → Constr 2 [data]
  const datum = out.datum();
  if (!datum) {
    return cst.PlutusData.newConstrPlutusData(
      new cst.ConstrPlutusData(0n, new cst.PlutusList()),
    );
  }
  const kind = datum.kind();
  if (kind === cst.DatumKind.DataHash) {
    const hashList = new cst.PlutusList();
    const hash = datum.asDataHash();
    if (!hash) throw new Error("datum kind DataHash but asDataHash() returned null");
    hashList.add(cst.PlutusData.newBytes(hexToBytes(hash.toString())));
    return cst.PlutusData.newConstrPlutusData(new cst.ConstrPlutusData(1n, hashList));
  }
  if (kind === cst.DatumKind.InlineData) {
    const inline = datum.asInlineData();
    if (!inline) throw new Error("datum kind InlineData but asInlineData() returned null");
    const inlineList = new cst.PlutusList();
    inlineList.add(inline);
    return cst.PlutusData.newConstrPlutusData(new cst.ConstrPlutusData(2n, inlineList));
  }
  throw new Error(`unsupported datum kind ${kind}`);
}

function refScriptToPlutusData(
  out: import("@meshsdk/core-cst").TransactionOutput,
  cst: typeof import("@meshsdk/core-cst"),
): import("@meshsdk/core-cst").PlutusData {
  // Maybe ScriptHash:
  //   Nothing  → Constr 1 []
  //   Just h   → Constr 0 [bytes(28)]
  const scriptRef = out.scriptRef();
  if (!scriptRef) {
    return cst.PlutusData.newConstrPlutusData(
      new cst.ConstrPlutusData(1n, new cst.PlutusList()),
    );
  }
  const list = new cst.PlutusList();
  list.add(cst.PlutusData.newBytes(hexToBytes(scriptRef.hash().toString())));
  return cst.PlutusData.newConstrPlutusData(new cst.ConstrPlutusData(0n, list));
}

// ---------------------------------------------------------------------------
// Bech32 stake-script reward address — built without mesh
// ---------------------------------------------------------------------------

/**
 * Construct the bech32 stake-script reward address (HRP "stake_test"/"stake")
 * for a script-stake credential.
 *
 * Header byte: 0xE0 (testnet) / 0xE1 (mainnet) — script-stake reward.
 * Payload: 28-byte script hash.
 */
export function buildScriptRewardAddress(scriptHashHex: string, networkId: 0 | 1): string {
  const hash = hexToBytes(scriptHashHex);
  if (hash.length !== 28) {
    throw new Error(`reward address: script hash must be 28 bytes, got ${hash.length}`);
  }
  const header = 0xf0 | networkId; // 0b1111_NNNN — script-stake reward credential
  const payload = new Uint8Array(29);
  payload[0] = header;
  payload.set(hash, 1);
  return bech32Encode(networkId === 0 ? "stake_test" : "stake", payload);
}

// ---------------------------------------------------------------------------
// Local utilities (kept inline so this module is self-contained for testing)
// ---------------------------------------------------------------------------

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Encode(hrp: string, data: Uint8Array): string {
  const groups = convertBits(data, 8, 5, true);
  const checksum = bech32CreateChecksum(hrp, groups);
  let out = `${hrp}1`;
  for (const g of groups) out += BECH32_CHARSET[g];
  for (const g of checksum) out += BECH32_CHARSET[g];
  return out;
}

function convertBits(data: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) {
      throw new Error(`convertBits: ${value} out of range`);
    }
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
  }
  return out;
}

function bech32Polymod(values: number[]): number {
  const generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= generator[i]!;
    }
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 0x1f);
  return out;
}

function bech32CreateChecksum(hrp: string, data: number[]): number[] {
  const values = [...bech32HrpExpand(hrp), ...data];
  const polymod = bech32Polymod([...values, 0, 0, 0, 0, 0, 0]) ^ 1;
  const out: number[] = [];
  for (let i = 0; i < 6; i++) out.push((polymod >> (5 * (5 - i))) & 0x1f);
  return out;
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

/**
 * Mesh's tx builder takes `scriptSize` as a string (it's wired into
 * a CSL bigint somewhere downstream). Convert our number → decimal
 * string; pass `undefined` if we don't know the size, in which case
 * mesh resolves it from the on-chain UTxO at the cost of an extra
 * Blockfrost call.
 */
function sizeStr(n: number | undefined): string | undefined {
  return typeof n === "number" ? n.toString() : undefined;
}

/** Mesh's exec-unit shape (mirrors `Budget` from `@meshsdk/common`). */
interface ExUnits {
  mem: number;
  steps: number;
}

interface WithdrawExUnits {
  spend: ExUnits;
  withdraw: ExUnits;
}

/**
 * Run the mesh evaluator against a tx CBOR and return per-redeemer exec
 * units. Mesh's `evaluateTx` returns an array of actions; we pick the
 * first SPEND and the first WITHDRAW since the withdraw tx has exactly
 * one of each. If either is missing the chain will reject the tx, so we
 * fail loudly here instead.
 */
async function evaluateExUnits(
  mesh: { evaluateTx(cbor: string): Promise<unknown> },
  unsignedTxCborHex: string,
): Promise<WithdrawExUnits> {
  const raw = await mesh.evaluateTx(unsignedTxCborHex);
  if (!Array.isArray(raw)) {
    throw new Error(
      `withdraw evaluator: expected an array of actions, got ${typeof raw}`,
    );
  }
  let spend: ExUnits | null = null;
  let withdraw: ExUnits | null = null;
  for (const a of raw as Array<{
    tag?: string;
    budget?: { mem?: number; steps?: number };
  }>) {
    const tag = a.tag;
    const b = a.budget;
    if (!b || typeof b.mem !== "number" || typeof b.steps !== "number") continue;
    const u: ExUnits = { mem: b.mem, steps: b.steps };
    if (tag === "SPEND" && !spend) spend = u;
    // Mesh's evaluator surfaces withdrawal redeemers under the `REWARD`
    // tag (matches Conway's redeemer-tag enum where the withdrawal
    // purpose is "rewarding"). Accept both names defensively in case
    // a future mesh version normalizes to "WITHDRAW".
    else if ((tag === "REWARD" || tag === "WITHDRAW") && !withdraw) withdraw = u;
  }
  if (!spend || !withdraw) {
    throw new Error(
      `withdraw evaluator: missing exec units for spend or withdraw — got ${JSON.stringify(
        raw,
      )}`,
    );
  }
  return { spend, withdraw };
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

// `publicPoint` from crypto/schnorr is unused here but kept imported so that
// future iterations (e.g. Schnorr ctx with G as base) can reach it without
// growing the import surface.
void publicPoint;
