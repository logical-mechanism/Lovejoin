// Mix tx builder — variable-N Sigmajoin re-randomization.
//
// Spec: (see CLAUDE.md)
//   *  §"Mix — variable N (the full Sigmajoin construction)".
//   *  §"N-way Sigma-OR" + §"Context binding (Mix redeemer)".
//   *  §2 (Mix branch) + §3 (PayMixFee).
//   *  §"buildMixTx — variable N + collateral provider".
//
// Architecture: the same split-into-plan-and-build pattern deposit.ts and
// withdraw.ts use. `planMixTx(...)` is the pure module — it picks fresh
// `y_i` per input, computes the N output (a', b') pairs, encodes the inline
// datum CBOR, computes the Fiat-Shamir context, generates each input's
// N-way sigma-OR proof, and emits a fully-typed plan. `buildMixTx(...)`
// drives mesh with that plan: spends the N mix-boxes via withdraw-zero,
// spends the fee shard with PayMixFee, consumes a collateral input, and
// produces the unsigned tx ready to sign + submit.
//
// On-chain order matters in TWO places:
//
//   1. `tx.inputs` is sorted lexicographically by (txid, output_index) by
//      the Cardano ledger BEFORE the validator runs. The Aiken validator
//      reads `mix_logic.collect_well_formed_mix_inputs` in the resulting
//      sorted order, so the redeemer's `proofs[i]` MUST be the proof for
//      the i-th lexicographically-smallest mix-box input. The plan sorts
//      inputs that way before generating proofs.
//
//   2. Outputs preserve insertion order — the validator asserts the N mix
//      outputs occupy positions [0, N). The build emits them in plan order
//      (the user-chosen permutation of N) followed by the fee shard
//      output at position N.
//
// Fee handling: the spec sets `tx.fee ≤ max_fee_per_mix_lovelace` and
// `fee_in - fee_out == tx.fee`. The simplest balance is `tx.fee =
// max_fee_per_mix` (over-pay slightly so the equation has a known fixed
// answer); mesh's `setFee` pins this exactly. Calibrating
// `max_fee_per_mix` down to the empirical minimum is M4's stress-test
// deliverable.
//
// Per-redeemer exec-unit budgets are sourced exclusively from the chain
// provider's evaluator. mesh's `DEFAULT_REDEEMER_BUDGET = {mem: 7M, steps:
// 3G}` placeholder would put min_fee above `max_fee_per_mix_lovelace`
// before the evaluator runs, so we pass a tiny constant placeholder
// (`POPULATE_TIME_EXUNITS_PLACEHOLDER` below) that keeps the populate-time
// min_fee well under cap; the evaluator then overwrites it with real
// values. If the evaluator is missing or errors, we fail the build —
// there is no "fallback estimate" any more, because the only thing a
// fallback estimate can do is hide the underlying problem (Blockfrost
// ogmios v5 routing, network outage, etc.) and ship a tx whose claimed
// budget bears no relation to real chain cost. Submitting that burns
// collateral on a budget-exhaustion failure or wastes fees if the claim
// is wildly over.
//
// Collateral: Mix txs default to GivemeMyProvider (wallet-anonymous; the
// host signs the collateral). Pass an explicit WalletProvider only for
// debugging — leaks the submitter's wallet onto the tx and breaks
// anonymity.

import { Encoder, Tag } from "cbor-x";

import {
  type DHTupleStatement,
  G1_COMPRESSED_BYTES,
  SCALAR_BYTES,
  SCALAR_ORDER,
  type Scalar,
  type SigmaOrBranchProof,
  type SigmaOrProof,
  blake2b256,
  generator,
  pointFromBytes,
  pointToBytes,
  proveSigmaOr,
  scalarMul,
  verifySigmaOr,
} from "../crypto/index.js";
import type { ChainProvider, Hex32, Lovelace, Utxo, UtxoRef } from "../chain/provider.js";
import { lovejoinUtxoToOgmiosAdditional } from "../chain/ogmios-utxo.js";
import { type CollateralProvider, GivemeMyProvider, WalletProvider } from "./collateral.js";
import { appendVkeyWitness } from "./witness-merge.js";
import { encodeMixDatum, generateOwnerSecret as drawScalar } from "./deposit.js";
import {
  computeMinTxFee,
  computeRefScriptFee,
  extractFeeFromTxCbor,
  sumEvaluatorExUnits,
} from "./fee-helpers.js";
import { pickRandomFeeShard } from "./fee.js";
import { type RetryOptions, withInputCollisionRetry } from "./retry.js";
import { getMeshProtocolParams, getMeshProvider } from "./mesh-bridge.js";
import {
  fetchProtocolParams,
  type LovejoinAddresses,
  type ProtocolParams,
  parseUtxoRef,
} from "./params.js";
import { buildScriptAddress } from "./address.js";
import { buildScriptRewardAddress } from "./withdraw.js";
import {
  type LovejoinNetworkId,
  type LovejoinWallet,
  networkIdFor,
  normalizeWalletUtxos,
} from "../wallet/cip30.js";

const cborEncoder = new Encoder();

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

/** A mix-box input the Mix tx will consume. */
export interface MixInput {
  /** The on-chain ref of the mix-box. */
  ref: UtxoRef;
  /** The mix-box's `a` from its inline `MixDatum`. */
  a: Uint8Array;
  /** The mix-box's `b` from its inline `MixDatum`. */
  b: Uint8Array;
  /**
   * The full UTxO record. Required so the tx builder can carry the address
   * + lovelace + reference-script fields into mesh without an extra fetch.
   */
  utxo: Utxo;
}

/** The pre-encoded shape of one N-way sigma-OR proof. */
export interface MixProofPlan {
  /** N branches, each {t0,t1,c,z}. */
  branches: SigmaOrBranchProof[];
}

export interface MixOutputPlan {
  /** New mix-box inline datum's a (compressed 48-byte). */
  a: Uint8Array;
  /** New mix-box inline datum's b (compressed 48-byte). */
  b: Uint8Array;
  /** Plutus-Data CBOR hex of the resulting MixDatum. */
  inlineDatumHex: string;
}

/**
 * How the Mix tx pays its on-chain fee.
 *
 *   * `"shard"` — the canonical hyperstructure path. Spend a fee_contract
 *     shard with `PayMixFee`; the validator pins
 *     `fee_in - fee_out == tx.fee` and `tx.fee ≤ max_fee_per_mix_lovelace`.
 *     Cost is socialised across the pool of shards.
 *   * `"wallet"` — submitter-pays. No fee shard input or output;
 *     mesh balances the tx by drawing a wallet UTxO and emitting a
 *     wallet change output. The on-chain `max_fee_per_mix` cap doesn't
 *     apply because `fee_contract.validate_pay_mix_fee` never runs in
 *     this mode. Trade-off: the wallet's identity is on the tx (same
 *     leak as the M4 wallet-collateral default — no incremental cost
 *     until M5's giveme.my refactor lands).
 *
 * The on-chain validators in M2 already permit both shapes — the fee
 * shard is a public-good coordination mechanism, not a protocol
 * constraint. See `mix_logic.validate_mix` (no fee_contract reference)
 * and `fee_contract.validate_pay_mix_fee` (only fires when the shard
 * is consumed).
 */
export type MixFeePayer = "shard" | "wallet";

export interface MixPlan {
  /** N mix-box inputs in **lex sorted order** — the order the validator sees. */
  inputs: MixInput[];
  /**
   * `inputToOutput[i] = j` means "input i went to output position j". One
   * permutation of [0, N). In lex-sorted-input space.
   */
  inputToOutput: number[];
  /** N output mix-boxes at tx-output positions 0..N-1. */
  outputs: MixOutputPlan[];
  /** N proofs in lex-sorted-input order. */
  proofs: MixProofPlan[];
  /** Plutus-Data CBOR hex of the full Mix redeemer (Constr 1 [proofs]). */
  mixRedeemerCborHex: string;
  /** Mix-box script address (bech32). */
  mixBoxAddressBech32: string;
  /** Who pays the tx fee — see {@link MixFeePayer}. */
  feePayer: MixFeePayer;
  /** Fee-shard input being consumed. `null` when `feePayer === "wallet"`. */
  feeShardInput: Utxo | null;
  /**
   * Fee-shard output (one only, datum unchanged, value = fee_in - tx.fee).
   * `null` when `feePayer === "wallet"`.
   */
  feeShardOutput: {
    addressBech32: string;
    lovelace: Lovelace;
    inlineDatumHex: string;
  } | null;
  /**
   * Plutus-Data CBOR hex of the PayMixFee redeemer (Constr 0 []).
   * `null` when `feePayer === "wallet"`.
   */
  payMixFeeRedeemerCborHex: string | null;
  /** Reference UTxO for ProtocolParams. */
  referenceUtxoRef: UtxoRef;
  /** mix_box CIP-33 reference-script UTxO ref. */
  mixBoxRefScriptUtxoRef: UtxoRef;
  /** mix_logic CIP-33 reference-script UTxO ref. */
  mixLogicRefScriptUtxoRef: UtxoRef;
  /** fee_contract CIP-33 reference-script UTxO ref. */
  feeContractRefScriptUtxoRef: UtxoRef;
  /** Bech32 reward address for the mix_logic withdraw-zero. */
  mixLogicRewardAddressBech32: string;
  /**
   * The exact fee the tx will pay. `Lovelace` in shard mode (= max_fee_per_mix
   * by default — pinned because it has to match `fee_in - fee_out` exactly).
   * `null` in wallet mode — mesh computes the minimum fee from the tx body.
   */
  txFeeLovelace: Lovelace | null;
  /** N (== inputs.length == outputs.length == proofs.length). */
  n: number;
}

// ---------------------------------------------------------------------------
// Per-redeemer exec-unit budgets
// ---------------------------------------------------------------------------

/**
 * Tiny placeholder we attach to every redeemer at populate-time. The
 * mesh evaluator overwrites it with chain-real values during `complete()`.
 *
 * IMPORTANT: spread `{...POPULATE_TIME_EXUNITS_PLACEHOLDER}` at every
 * call site. mesh's `castBuilderDataToRedeemer` stores the exUnits
 * object reference as-is (no copy); passing the same object to multiple
 * `txInRedeemerValue` / `withdrawalRedeemerValue` calls in one build
 * makes them all alias the same instance, and `updateRedeemer`'s
 * mutations to `redeemer.exUnits.mem/.steps` then leak across redeemers
 * — the LAST evaluator-returned budget wins for every redeemer.
 * Confirmed against mesh @1.8.14:
 *   `node_modules/.../@meshsdk/transaction/dist/index.js:1458` (storage)
 *   `node_modules/.../@meshsdk/transaction/dist/index.js:1474` (mutation).
 */
const POPULATE_TIME_EXUNITS_PLACEHOLDER = { mem: 10_000, steps: 1_000_000 };

// ---------------------------------------------------------------------------
// CBOR helpers
// ---------------------------------------------------------------------------

/** PayMixFee variant of the FeeRedeemer is `Constr 0 []` → `d87980`. */
export const PAY_MIX_FEE_REDEEMER_CBOR_HEX = "d87980";

/** The unit datum on every fee shard — `Constr 0 []` → `d87980`. */
export const FEE_UNIT_DATUM_CBOR_HEX = "d87980";

/**
 * Encode the `Mix { proofs: List<SigmaOrProof> }` redeemer to canonical
 * Plutus-Data CBOR. `Mix` is the second variant of `MixLogicRedeemer`
 * (Constr 1, tag 122). Inside it carries one list of N proofs; each
 * `SigmaOrProof` is `Constr 0 [List<SigmaOrBranch>]` and each
 * `SigmaOrBranch` is `Constr 0 [bytes(48), bytes(48), bytes(32),
 * bytes(32)]`.
 */
export function encodeMixRedeemer(proofs: ReadonlyArray<MixProofPlan>): string {
  if (proofs.length < 2) {
    throw new Error(`Mix redeemer needs N >= 2 proofs, got ${proofs.length}`);
  }
  const proofsCbor = proofs.map((p) => {
    if (p.branches.length < 2) {
      throw new Error(`SigmaOrProof must have >= 2 branches, got ${p.branches.length}`);
    }
    const branches = p.branches.map((br) => {
      if (br.t0.length !== G1_COMPRESSED_BYTES) {
        throw new Error(`SigmaOrBranch.t0 must be ${G1_COMPRESSED_BYTES} bytes`);
      }
      if (br.t1.length !== G1_COMPRESSED_BYTES) {
        throw new Error(`SigmaOrBranch.t1 must be ${G1_COMPRESSED_BYTES} bytes`);
      }
      if (br.c.length !== 32) {
        throw new Error(`SigmaOrBranch.c must be 32 bytes`);
      }
      if (br.z.length !== SCALAR_BYTES) {
        throw new Error(`SigmaOrBranch.z must be ${SCALAR_BYTES} bytes`);
      }
      // Constr 0 [bytes, bytes, bytes, bytes]
      return new Tag(
        [Buffer.from(br.t0), Buffer.from(br.t1), Buffer.from(br.c), Buffer.from(br.z)],
        121,
      );
    });
    // SigmaOrProof = Constr 0 [List<SigmaOrBranch>]
    return new Tag([branches], 121);
  });
  // Mix = Constr 1 [List<SigmaOrProof>]
  const redeemer = new Tag([proofsCbor], 122);
  return bytesToHex(cborEncoder.encode(redeemer));
}

/**
 * Canonical Plutus-Data CBOR of `MixDatum { a, b }` as Aiken's
 * `builtin.serialise_data` re-emits it on chain.
 *
 * Plutus canonical form for a Constr is `tag 121 + List<Data>`, and
 * `serialise_data` encodes the field list with INDEFINITE-length CBOR
 * (`9F … FF`), even for small constant-size lists. cbor-x emits
 * definite-length (`82 …`), which is also valid Plutus-Data and decodes
 * to the same tree — so it's fine for the *stored* inline datum — but
 * the bytes differ, and the on-chain `compute_mix_ctx` re-serialises
 * the parsed datum canonically. Using the cbor-x definite form for our
 * off-chain ctx therefore mismatches the chain by 1 byte (the array
 * header) plus the trailing break, the sigma-OR proof's challenge
 * doesn't agree, and the validator aborts in the OR-equation check
 * with no traces. Confirmed against ogmios v6 + parity test
 * `serialise_data_mix_datum_*`.
 *
 * Layout: `D8 79 9F 58 30 <a, 48 bytes> 58 30 <b, 48 bytes> FF` = 104 bytes.
 */
export function serialiseMixDatumCanonical(args: { a: Uint8Array; b: Uint8Array }): Uint8Array {
  if (args.a.length !== G1_COMPRESSED_BYTES) {
    throw new Error(
      `serialiseMixDatumCanonical: a must be ${G1_COMPRESSED_BYTES} bytes, got ${args.a.length}`,
    );
  }
  if (args.b.length !== G1_COMPRESSED_BYTES) {
    throw new Error(
      `serialiseMixDatumCanonical: b must be ${G1_COMPRESSED_BYTES} bytes, got ${args.b.length}`,
    );
  }
  const out = new Uint8Array(2 + 1 + 2 + 48 + 2 + 48 + 1);
  out[0] = 0xd8;
  out[1] = 0x79; // tag 121 = Constr 0
  out[2] = 0x9f; // indefinite-length array start
  out[3] = 0x58;
  out[4] = 0x30; // bytes(48)
  out.set(args.a, 5);
  out[53] = 0x58;
  out[54] = 0x30; // bytes(48)
  out.set(args.b, 55);
  out[103] = 0xff; // break
  return out;
}

/**
 * Encode an ada-only Plutus `Value` to canonical Plutus-Data CBOR. Used
 * when computing the Mix Fiat-Shamir context, which hashes the value of
 * each of the N mix outputs. Mix outputs are by spec ada-only at the
 * protocol denomination — no native assets, no extra Maps.
 *
 * Plutus shape: `Map<PolicyId, Map<AssetName, Integer>>` with `(empty,
 * (empty, lovelace))`. Canonical CBOR: `A1 40 A1 40 <int>` — Aiken's
 * `serialise_data` uses DEFINITE-length 1-entry maps for Plutus
 * canonical (verified by parity test). Maps and arrays use different
 * rules: maps are definite when ≤ 23 entries, arrays are always
 * indefinite. See `serialiseMixDatumCanonical` for the array case.
 *
 * The integer encoding follows CBOR's deterministic-form rules
 * (RFC 8949 §4.2.1 / smallest-form).
 */
export function encodeAdaOnlyValueCbor(lovelace: bigint): Uint8Array {
  if (lovelace < 0n) {
    throw new Error(`encodeAdaOnlyValueCbor: lovelace must be non-negative, got ${lovelace}`);
  }
  const intBytes = encodeCborUInt(lovelace);
  const out = new Uint8Array(4 + intBytes.length);
  out[0] = 0xa1; // map(1)
  out[1] = 0x40; // bytes(0) — empty policy id
  out[2] = 0xa1; // map(1)
  out[3] = 0x40; // bytes(0) — empty asset name
  out.set(intBytes, 4);
  return out;
}

/**
 * Canonical CBOR major-type-0 encoding of a non-negative bigint
 * (smallest form). Throws for values that exceed the spec's u64 range —
 * Plutus' `Value` quantities never go above 2^64 in practice, and
 * supporting the bignum tag(2) path here would be dead code.
 */
function encodeCborUInt(n: bigint): Uint8Array {
  if (n < 0n) throw new Error("encodeCborUInt: negative");
  if (n < 24n) return new Uint8Array([Number(n)]);
  if (n < 256n) return new Uint8Array([0x18, Number(n)]);
  if (n < 65_536n) {
    const v = Number(n);
    return new Uint8Array([0x19, (v >> 8) & 0xff, v & 0xff]);
  }
  if (n < 4_294_967_296n) {
    const v = Number(n);
    return new Uint8Array([0x1a, (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
  }
  if (n < 18_446_744_073_709_551_616n) {
    const out = new Uint8Array(9);
    out[0] = 0x1b;
    let x = n;
    for (let i = 8; i >= 1; i--) {
      out[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    return out;
  }
  throw new Error(`encodeCborUInt: ${n} exceeds u64; bignum path not implemented`);
}

/**
 * Compute the Mix Fiat-Shamir context.
 *
 *   ctx = blake2b_256(
 *       serialise_data(out_0.datum) || ... || serialise_data(out_{N-1}.datum)
 *    || serialise_data(out_0.value) || ... || serialise_data(out_{N-1}.value)
 *    || mix_script_hash
 *   )
 *
 * Mix outputs all carry `denom_lovelace` ADA only, so every value
 * encoding is identical and equals `encodeAdaOnlyValueCbor(denom)`.
 */
export function computeMixCtx(args: {
  outputDatums: ReadonlyArray<Uint8Array>;
  outputValues: ReadonlyArray<Uint8Array>;
  mixScriptHashHex: string;
}): Uint8Array {
  const datumLen = args.outputDatums.reduce((a, x) => a + x.length, 0);
  const valueLen = args.outputValues.reduce((a, x) => a + x.length, 0);
  const hash = hexToBytes(args.mixScriptHashHex);
  if (hash.length !== 28) {
    throw new Error(`mix_script_hash must be 28 bytes, got ${hash.length}`);
  }
  const preimage = new Uint8Array(datumLen + valueLen + 28);
  let p = 0;
  for (const d of args.outputDatums) {
    preimage.set(d, p);
    p += d.length;
  }
  for (const v of args.outputValues) {
    preimage.set(v, p);
    p += v.length;
  }
  preimage.set(hash, p);
  return blake2b256(preimage);
}

// ---------------------------------------------------------------------------
// planMixTx — pure, no chain access
// ---------------------------------------------------------------------------

export interface PlanMixArgs {
  /** Selected mix-box inputs. ≥ 2; will be sorted by (txid, idx). */
  inputs: ReadonlyArray<MixInput>;
  /**
   * Per-input fresh witnesses `y_i ∈ [1, r)`. Optional — if omitted the
   * planner draws them via WebCrypto. Tests pass an explicit list for
   * reproducibility. Length must equal `inputs.length`.
   */
  ySecrets?: ReadonlyArray<Scalar>;
  /**
   * Permutation of `[0, N)` mapping sorted-input index → output position.
   * Optional — if omitted, a fresh random permutation is drawn. Length
   * must equal `inputs.length`.
   */
  permutation?: ReadonlyArray<number>;
  /** Lovejoin protocol parameters from the reference UTxO. */
  params: ProtocolParams;
  /** Bootstrap addresses.json — provides script hashes + reference UTxOs. */
  addresses: LovejoinAddresses;
  /**
   * Fee shard the SDK has chosen to consume. Required in `"shard"` fee
   * mode (the default); ignored when `feePayer === "wallet"`.
   */
  feeShard?: Utxo;
  /** Who pays the tx fee. Default: `"shard"`. See {@link MixFeePayer}. */
  feePayer?: MixFeePayer;
  /** Network discriminator for bech32 address construction. */
  networkId: LovejoinNetworkId;
  /**
   * Lovelace fee the tx will pay. Default: `params.maxFeePerMixLovelace`.
   * Caller may pass a smaller value for fee-calibration sweeps; the on-chain
   * rule `tx.fee ≤ max_fee_per_mix_lovelace` still applies. Ignored in
   * wallet mode — mesh computes the fee from the tx body.
   */
  txFeeLovelace?: Lovelace;
}

/**
 * Build the full Mix-tx data plan: sorted inputs, output (a', b') pairs,
 * inline datum CBOR for each output, the FS context, the per-input
 * sigma-OR proofs, and the redeemer CBOR.
 *
 * No chain access. No mesh dependency. Fully deterministic given
 * `(ySecrets, permutation)` — pass both for reproducible tests.
 */
export function planMixTx(args: PlanMixArgs): MixPlan {
  const n = args.inputs.length;
  if (n < 2) {
    throw new Error(`Mix needs N >= 2 inputs, got ${n}`);
  }
  if (args.ySecrets && args.ySecrets.length !== n) {
    throw new Error(`ySecrets.length (${args.ySecrets.length}) must equal inputs.length (${n})`);
  }
  if (args.permutation && args.permutation.length !== n) {
    throw new Error(
      `permutation.length (${args.permutation.length}) must equal inputs.length (${n})`,
    );
  }
  // Sort inputs by (txid asc, output_index asc) — what the ledger does
  // before the validator reads `tx.inputs`.
  const sortedInputs = [...args.inputs].sort(compareUtxoRef);
  // Detect duplicate refs — would be rejected on chain but we should fail
  // loudly here rather than producing a tx that can't be submitted.
  for (let i = 1; i < sortedInputs.length; i++) {
    const a = sortedInputs[i - 1]!.ref;
    const b = sortedInputs[i]!.ref;
    if (a.txId === b.txId && a.outputIndex === b.outputIndex) {
      throw new Error(`Mix inputs include duplicate ref ${a.txId}#${a.outputIndex}`);
    }
  }

  const ySecrets: Scalar[] = (args.ySecrets ?? defaultYSecrets(n)).map((y) => {
    if (y <= 0n || y >= SCALAR_ORDER) {
      throw new Error(`y_i must be in [1, r)`);
    }
    return y;
  });
  const permutation = args.permutation ? args.permutation.slice() : defaultPermutation(n);
  validatePermutation(permutation);

  // For each sorted-input i, compute output[permutation[i]] = ([y_i]·a_i, [y_i]·b_i).
  const outputs = new Array<MixOutputPlan>(n);
  for (let i = 0; i < n; i++) {
    const inp = sortedInputs[i]!;
    const aPoint = pointFromBytes(inp.a);
    const bPoint = pointFromBytes(inp.b);
    const y = ySecrets[i]!;
    const aPrime = pointToBytes(scalarMul(y, aPoint));
    const bPrime = pointToBytes(scalarMul(y, bPoint));
    const j = permutation[i]!;
    outputs[j] = {
      a: aPrime,
      b: bPrime,
      inlineDatumHex: encodeMixDatum({ a: aPrime, b: bPrime }),
    };
  }

  // Compute the FS ctx.
  //
  // The datum bytes here are the CANONICAL Plutus-Data form (indef-length
  // array), NOT the cbor-x bytes we store on chain. The validator's
  // `serialise_data(inline_data)` re-emits the parsed datum in canonical
  // form before hashing, so we must do the same off-chain to get a
  // matching ctx. See `serialiseMixDatumCanonical` for the byte layout
  // and the rabbit hole that led us here.
  const datumBytes = outputs.map((o) => serialiseMixDatumCanonical({ a: o.a, b: o.b }));
  const valueBytes = outputs.map(() => encodeAdaOnlyValueCbor(args.params.denomLovelace));
  const ctx = computeMixCtx({
    outputDatums: datumBytes,
    outputValues: valueBytes,
    mixScriptHashHex: args.params.mixScriptHash,
  });

  // Build the OR-statement vector once. Same for every input.
  const orStatements: DHTupleStatement[] = outputs.map((o) => ({
    ap: pointFromBytes(o.a),
    bp: pointFromBytes(o.b),
  }));

  // Per-input sigma-OR proof.
  const proofs: MixProofPlan[] = [];
  for (let i = 0; i < n; i++) {
    const inp = sortedInputs[i]!;
    const realIndex = permutation[i]!; // output position where input i landed
    const proof: SigmaOrProof = proveSigmaOr(
      pointFromBytes(inp.a),
      pointFromBytes(inp.b),
      orStatements,
      realIndex,
      ySecrets[i]!,
      ctx,
    );
    proofs.push({ branches: proof.branches });
  }

  const mixBoxAddress = buildScriptAddress(args.addresses.mixBoxScriptHash, args.networkId);
  const feeAddress = buildScriptAddress(args.addresses.feeScriptHash, args.networkId);

  const feePayer: MixFeePayer = args.feePayer ?? "shard";

  // Resolve fee-shard inputs/outputs based on mode. In wallet mode the
  // shard is bypassed entirely — mesh balances against a wallet UTxO.
  let feeShardInput: Utxo | null = null;
  let feeShardOutput: MixPlan["feeShardOutput"] = null;
  let payMixFeeRedeemerCborHex: string | null = null;
  let txFee: Lovelace | null = null;
  if (feePayer === "shard") {
    if (!args.feeShard) {
      throw new Error("planMixTx: feeShard is required when feePayer === 'shard'");
    }
    txFee = args.txFeeLovelace ?? args.params.maxFeePerMixLovelace;
    if (txFee <= 0n) {
      throw new Error(`tx fee must be > 0, got ${txFee}`);
    }
    if (txFee > args.params.maxFeePerMixLovelace) {
      throw new Error(
        `tx fee ${txFee} exceeds max_fee_per_mix_lovelace ${args.params.maxFeePerMixLovelace}`,
      );
    }
    const feeOutLovelace = args.feeShard.lovelace - txFee;
    if (feeOutLovelace <= 0n) {
      throw new Error(
        `fee shard ${args.feeShard.ref.txId}#${args.feeShard.ref.outputIndex} has too little ` +
          `lovelace (${args.feeShard.lovelace}) to absorb tx.fee=${txFee}`,
      );
    }
    feeShardInput = args.feeShard;
    feeShardOutput = {
      addressBech32: feeAddress,
      lovelace: feeOutLovelace,
      inlineDatumHex: FEE_UNIT_DATUM_CBOR_HEX,
    };
    payMixFeeRedeemerCborHex = PAY_MIX_FEE_REDEEMER_CBOR_HEX;
  } else if (feePayer !== "wallet") {
    throw new Error(`planMixTx: unknown feePayer "${feePayer as string}"`);
  }

  return {
    inputs: sortedInputs,
    inputToOutput: permutation,
    outputs,
    proofs,
    mixRedeemerCborHex: encodeMixRedeemer(proofs),
    mixBoxAddressBech32: mixBoxAddress,
    feePayer,
    feeShardInput,
    feeShardOutput,
    payMixFeeRedeemerCborHex,
    referenceUtxoRef: parseUtxoRef(args.addresses.referenceUtxoRef),
    mixBoxRefScriptUtxoRef: parseUtxoRef(args.addresses.referenceScriptUtxos.mix_box),
    mixLogicRefScriptUtxoRef: parseUtxoRef(args.addresses.referenceScriptUtxos.mix_logic),
    feeContractRefScriptUtxoRef: parseUtxoRef(args.addresses.referenceScriptUtxos.fee_contract),
    mixLogicRewardAddressBech32: buildScriptRewardAddress(
      args.params.mixLogicScriptHash,
      args.networkId,
    ),
    txFeeLovelace: txFee,
    n,
  };
}

/**
 * Cross-check: verify all N proofs locally before submission. This catches
 * any encoding-parity drift in `encodeMixDatum` / `encodeAdaOnlyValueCbor` /
 * `computeMixCtx` before we burn a tx fee on a guaranteed-to-fail submission.
 *
 * Takes the mix script hash explicitly because the plan doesn't carry it
 * directly. Returns the index of the first failing proof, or -1 if all pass.
 */
export function verifyMixPlanWithHash(plan: MixPlan, mixScriptHashHex: string): number {
  const orStatements: DHTupleStatement[] = plan.outputs.map((o) => ({
    ap: pointFromBytes(o.a),
    bp: pointFromBytes(o.b),
  }));
  // Use canonical (indef-length-array) Plutus Data form — same as the
  // on-chain `serialise_data(inline_data)` produces. See
  // `serialiseMixDatumCanonical` for context.
  const datumBytes = plan.outputs.map((o) => serialiseMixDatumCanonical({ a: o.a, b: o.b }));
  const denom = plan.inputs[0]!.utxo.lovelace;
  const valueBytes = plan.outputs.map(() => encodeAdaOnlyValueCbor(denom));
  const ctx = computeMixCtx({
    outputDatums: datumBytes,
    outputValues: valueBytes,
    mixScriptHashHex,
  });
  for (let i = 0; i < plan.inputs.length; i++) {
    const inp = plan.inputs[i]!;
    const proof: SigmaOrProof = { branches: plan.proofs[i]!.branches };
    if (!verifySigmaOr(pointFromBytes(inp.a), pointFromBytes(inp.b), orStatements, proof, ctx)) {
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// buildMixTx — drives mesh
// ---------------------------------------------------------------------------

export interface BuildMixArgs {
  network: "preprod" | "preview" | "test" | "mainnet";
  /**
   * Selected mix-box inputs, ≥ 2. Order doesn't matter — the plan sorts.
   */
  inputs: ReadonlyArray<MixInput>;
  /**
   * Wallet — optional for the canonical shard-mode + external-collateral
   * path. The protocol's whole point is that a Mix tx in that mode has
   * NO wallet input and NO wallet signature: collateral comes from the
   * external host (giveme.my), the host signs the only required vkey
   * witness, and the fee-shard pays via PayMixFee. With those two
   * conditions met, the wallet is not part of the witness set or the
   * UTxO set; the SDK only needs `getChangeAddress()` to satisfy mesh's
   * builder, and that's substituted from the collateral input's address
   * when no wallet is supplied (no change is ever emitted because
   * `selectUtxosFrom([])` runs in shard mode).
   *
   * REQUIRED for:
   *   * `feePayer === "wallet"` — the wallet pays the tx fee, so it
   *     must contribute a UTxO and sign.
   *   * `WalletProvider` collateral — the wallet's vkey is the witness.
   *     This is also the fallback when no pinned external host exists
   *     (e.g. `preview`), so passing a wallet is the safe default.
   *
   * Surfaced as required → optional in this signature; runtime checks
   * inside `buildMixTx` enforce the actual constraints and throw with
   * an explicit message if the path can't proceed without a wallet.
   */
  wallet?: LovejoinWallet;
  provider: ChainProvider;
  addresses: LovejoinAddresses;
  /**
   * Who pays the tx fee. Default: `"shard"` — the canonical hyperstructure
   * path that consumes a fee_contract shard. Use `"wallet"` to bypass the
   * shard (and its `max_fee_per_mix` cap) at the cost of revealing the
   * submitter's wallet on the tx. See {@link MixFeePayer}.
   */
  feePayer?: MixFeePayer;
  /**
   * Optional pre-picked fee shard. Only honoured when `feePayer === "shard"`;
   * if omitted in shard mode the SDK picks one uniformly at random
   * (`pickRandomFeeShard`). Ignored in wallet mode.
   */
  feeShard?: Utxo;
  /**
   * Optional UTxO refs to exclude when picking a fee shard. The UI
   * passes the set of refs that are currently inputs to in-flight
   * mempool txs (sourced from the backend's `/mempool/inputs` route);
   * the SDK skips them when picking. Ignored in wallet mode (no fee
   * shard picked) and when `feeShard` is supplied. With backend-less
   * Blockfrost deploys this stays empty and the retry path absorbs
   * collisions instead.
   */
  excludeFeeShardRefs?: ReadonlyArray<UtxoRef>;
  /**
   * Optional in-flight fee shards the caller wants the SDK to consider
   * alongside the chain-confirmed set. Include-polarity companion to
   * `excludeFeeShardRefs`: when chaining off an in-flight Replenish or
   * prior Mix, pass the parent's post-state fee-shard output here so
   * the picker can re-spend it without waiting for confirmation.
   *
   * Forwarded to `pickRandomFeeShard.extraShards`; entries that aren't
   * legitimate fee shards (wrong datum, native assets) are filtered out
   * defensively. Ignored in wallet mode (no shard picked) and when
   * `feeShard` is supplied.
   */
  feeShardExtras?: ReadonlyArray<Utxo>;
  /**
   * Collateral provider. Defaults to a `GivemeMyProvider` wired against the
   * pinned host for `args.network` — Mix txs MUST be wallet-anonymous, and
   * a wallet-supplied collateral leaks the submitter's identity onto the
   * tx (the collateral input is observable on chain). Pass an explicit
   * `WalletProvider(wallet)` only for local dev / debugging where the
   * leak is acceptable. If the pinned host has no entry for the network
   * (e.g. `preview`), we fall back to `WalletProvider(wallet)` with a
   * console warning.
   */
  collateralProvider?: CollateralProvider;
  /**
   * Override the tx fee. Default: `params.maxFeePerMixLovelace` (shard
   * mode only). Lower values are useful for the fee-calibration sweep.
   * Ignored in wallet mode — mesh computes the minimum fee.
   */
  txFeeLovelace?: Lovelace;
  /** If true, sign but don't submit. Default: false. */
  signOnly?: boolean;
  /**
   * Retry on input collisions. Useful for shard mode under heavy mix
   * activity: if the picked fee shard was consumed by another tx
   * between build and submit, the SDK transparently re-picks a fresh
   * shard and rebuilds. In wallet mode this still costs an extra
   * signature per retry; in shard mode the retry is silent (no wallet).
   * Pool-box collisions aren't auto-fixed (the caller owns input
   * selection), so the retry will exhaust attempts and surface the
   * original error in that case.
   *
   * Default: no retry (1 attempt). UI typically passes `{ maxAttempts: 3 }`.
   */
  retry?: RetryOptions;
  /**
   * Chain this Mix tx onto an in-flight parent (Deposit, Replenish, or
   * a prior Mix) that hasn't confirmed yet. The `utxos` are the parent's
   * outputs that this child consumes — they are spliced into the
   * Ogmios chain state in three places so every evaluator on the path
   * sees the same view:
   *
   *   1. **Local proof-of-evaluation** (during `tx.complete()`):
   *      routed through the chain provider's
   *      `evaluateTxWithAdditionalUtxos`. For BlockfrostProvider that
   *      means `/utils/txs/evaluate/utxos?version=6` with
   *      `additionalUtxoSet`; for BackendChainProvider, the backend's
   *      `/evaluate` route forwards them as ogmios
   *      `evaluateTransaction.additionalUtxo`.
   *   2. **Shard-mode fee-discovery evaluator pass** (after the first
   *      `complete()`): same path as above.
   *   3. **Collateral host** (giveme.my): forwarded as
   *      `additional_utxos` per v1.2.0's schema so the host's Koios /
   *      Ogmios evaluator agrees with our local result.
   *
   * Caller responsibilities:
   *   * The in-flight outputs MUST also be referenced in `args.inputs`
   *     (and/or `args.feeShard` for a chained Replenish→Mix). chainFrom
   *     is purely the evaluator-side splice — input selection is the
   *     caller's job.
   *   * `chainDepth` is an opt-in annotation that travels into log
   *     messages so operators can spot runaway chaining in transcripts.
   *     The SDK does NOT enforce a cap. The actual upper bounds are
   *     (a) fee-shard depletion (the picker's `minLovelace` filter drops
   *     a shard below the protocol's 3-ADA floor), (b) Cardano's
   *     mempool tx-graph capacity, and (c) the self-hosted backend's
   *     32-entry `additionalUtxoSet` cap on `/evaluate`. Rolled-back
   *     chains mean "no progress", not "lost funds" — orphaned Mix
   *     txs never confirm and never charge the user. Defaults to 1.
   *   * Rollback handling: if the parent tx is dropped from the mempool
   *     (rollback, fee race, replacement), the chained child becomes
   *     invalid. The SDK does NOT auto-resubmit — `tx/retry.ts` handles
   *     single-tx retries, not chain rollbacks. Catch the submit-time
   *     failure and resubmit at the caller.
   *
   * Provider support: the chain provider's mesh sibling must implement
   * `evaluateTxWithAdditionalUtxos`. BlockfrostProvider and the backend
   * provider both do. Custom providers will throw at the first
   * `tx.complete()` with a clear message naming the missing method.
   */
  chainFrom?: {
    utxos: ReadonlyArray<Utxo>;
    chainDepth?: number;
  };
  /**
   * Optional reproducibility hooks for tests. None of these affect the
   * plan structure — they just pin the random choices.
   */
  ySecrets?: ReadonlyArray<Scalar>;
  permutation?: ReadonlyArray<number>;
}

export interface MixResult {
  signedTxHex: string;
  txId: Hex32;
  /** The plan the tx was built from — useful for callers that want to
   *  inspect the chosen permutation / output (a', b') for tracking. */
  plan: MixPlan;
}

/**
 * Build, sign, and (optionally) submit a Mix tx on Cardano.
 *
 * The CIP-30 wallet's only role here is to sign the collateral input (when
 * using the default WalletProvider). No regular wallet input contributes
 * to the tx — fees come from the fee shard, mix-box values come from the
 * spent boxes themselves.
 *
 * Wallet-less submission is supported on the canonical shard + external-
 * collateral path. Wallet-mode and wallet-collateral fallbacks throw with
 * an explicit message if a wallet wasn't supplied.
 *
 * @example
 * ```ts
 * const collateral = new GivemeMyProvider({ endpoint: env.COLLATERAL_ENDPOINT });
 * const result = await buildMixTx({
 *   provider,
 *   addresses,
 *   params,
 *   inputs,           // N MixInput records — see selectMixNTuple
 *   feeShard,         // chosen fee shard UTxO
 *   collateralProvider: collateral,
 *   network: addresses.network,
 * });
 * console.log("mixed N=" + result.plan.outputs.length, "tx", result.txId);
 * ```
 */
export async function buildMixTx(args: BuildMixArgs): Promise<MixResult> {
  const networkId = networkIdFor(args.network);
  const { params } = await fetchProtocolParams(args.addresses, args.provider);
  const feePayer: MixFeePayer = args.feePayer ?? "shard";

  // Up-front guard for the wallet-mode case so the caller gets a clean
  // error before we burn cycles on a Mesh build pass that would die at
  // selectUtxosFrom() with an obscure stack.
  if (feePayer === "wallet" && !args.wallet) {
    throw new Error(
      'Mix tx: wallet-fee mode requires a connected wallet (the wallet pays the tx fee + signs). Pass `args.wallet` or switch `feePayer` to "shard".',
    );
  }

  // Build + sign + submit, with retry on fee-shard collision. Attempts
  // 2+ ignore `args.feeShard` and pick a fresh shard from chain (reusing
  // the caller's pre-pick on retry would just re-trigger the same
  // BadInputsUTxO). Pool-box collisions aren't auto-fixed; the retry
  // would build the same tx and fail again, exhausting maxAttempts.
  return withInputCollisionRetry(async (attempt) => {
    // Resolve the fee shard. Shard mode picks one if not supplied; wallet
    // mode skips this entirely (no shard input on the tx). The 3-ADA floor
    // skips depleted shards. Mix recreates the shard output minus tx.fee,
    // and going below min-utxo on the new shard is an unrecoverable submit
    // failure. Donate / Deposit don't pass this floor on purpose: they top
    // shards up and MUST be allowed to target depleted ones.
    const MIN_FEE_SHARD_LOVELACE = 3_000_000n;
    let feeShard: Utxo | undefined;
    if (feePayer === "shard") {
      feeShard =
        attempt === 1 && args.feeShard
          ? args.feeShard
          : await pickRandomFeeShard({
              provider: args.provider,
              feeScriptAddressBech32: buildScriptAddress(args.addresses.feeScriptHash, networkId),
              minLovelace: MIN_FEE_SHARD_LOVELACE,
              ...(args.excludeFeeShardRefs && args.excludeFeeShardRefs.length > 0
                ? { excludeRefs: args.excludeFeeShardRefs }
                : {}),
              ...(args.feeShardExtras && args.feeShardExtras.length > 0
                ? { extraShards: args.feeShardExtras }
                : {}),
            });
    }

    const plan = planMixTx({
      inputs: args.inputs,
      ...(args.ySecrets ? { ySecrets: args.ySecrets } : {}),
      ...(args.permutation ? { permutation: args.permutation } : {}),
      params,
      addresses: args.addresses,
      ...(feeShard ? { feeShard } : {}),
      feePayer,
      networkId,
      ...(args.txFeeLovelace !== undefined ? { txFeeLovelace: args.txFeeLovelace } : {}),
    });

    // Cross-check: every proof must verify locally. If any fail it's a
    // critical encoding-parity bug — abort before we burn fees.
    const failingProof = verifyMixPlanWithHash(plan, params.mixScriptHash);
    if (failingProof >= 0) {
      throw new Error(
        `Mix plan: proof for input ${failingProof} (${plan.inputs[failingProof]!.ref.txId}#` +
          `${plan.inputs[failingProof]!.ref.outputIndex}) fails local sigma-OR verification. ` +
          `This is an encoding-parity bug — see  §Risk 1.`,
      );
    }

    // Collateral. Default to GivemeMyProvider (wallet-anonymous Mix is the
    // protocol's whole point; see BuildMixArgs.collateralProvider doc). Fall
    // back to WalletProvider only when the network has no pinned host.
    const collateralProvider = args.collateralProvider ?? defaultMixCollateralProvider(args);
    // Cardano's collateralPercent is 150 — required collateral covers
    // 1.5x the tx fee. We pin to 5_000_000 lovelace as a generous default
    // (max_fee is sub-1-ADA so 5 ADA is well over).
    const preparedCollateral = await collateralProvider.prepareCollateral({
      provider: args.provider,
      collateralAmountLovelace: 5_000_000n,
    });

    const meshCore = await import("@meshsdk/core");
    const { MeshTxBuilder } = meshCore;
    const meshProvider = await getMeshProvider(args.provider);
    const meshParams = await getMeshProtocolParams(args.provider);

    // chainFrom resolution. If the caller is chaining onto an in-flight
    // parent (Deposit / Replenish / prior Mix), convert the parent's
    // outputs into Ogmios `additionalUtxo` shape ONCE here so the same
    // payload feeds three places: the local mesh evaluator pass (during
    // `tx.complete()`), the shard-mode fee-discovery evaluator call, and
    // the collateral provider's `signTxBody`. Without all three wired,
    // the chained Mix would fail at the first un-spliced evaluator that
    // can't resolve the in-flight input.
    const chainFromUtxos = args.chainFrom?.utxos ?? [];
    const chainDepth = args.chainFrom?.chainDepth ?? 1;
    const additionalUtxos =
      chainFromUtxos.length > 0
        ? chainFromUtxos.map((u) => lovejoinUtxoToOgmiosAdditional(u))
        : undefined;
    if (additionalUtxos && additionalUtxos.length > 0) {
      console.log(
        `[lovejoin/mix] chaining onto ${additionalUtxos.length} in-flight UTxO(s) ` +
          `at chainDepth=${chainDepth}; splicing into evaluator + signTxBody`,
      );
    }

    // Evaluator wiring. The chain provider's `evaluateTx` populates real
    // exec-unit budgets into every redeemer during `complete()`. There is
    // no fallback: a missing or failing evaluator throws here so callers
    // see the actual root cause (Blockfrost's ogmios-v6 routing, network
    // outage, validator UPLC mismatch, etc.) instead of submitting a tx
    // whose claimed budgets are made up.
    //
    // For chainFrom, route through `evaluateTxWithAdditionalUtxos` so
    // the upstream evaluator sees the in-flight parent's outputs. Falls
    // back to a clear error if the chain provider doesn't expose that
    // method (the unit-test provider in chain-provider.test.ts is the
    // only one in this repo that doesn't).
    //
    // Do NOT swap to mesh's OfflineEvaluator (`@meshsdk/core-csl`). Its
    // bundled UPLC machine predates Conway's bitwise builtins and aborts
    // with "Default Function not found - 77".
    const chainAwareEvaluator = {
      evaluateTx: async (cborHex: string) => {
        if (additionalUtxos && additionalUtxos.length > 0) {
          if (!meshProvider.evaluateTxWithAdditionalUtxos) {
            throw new Error(
              "Mix tx: chainFrom is set but the chain provider's mesh sibling does " +
                "not expose evaluateTxWithAdditionalUtxos. BlockfrostProvider and " +
                "BackendChainProvider both implement it; custom providers must too.",
            );
          }
          return meshProvider.evaluateTxWithAdditionalUtxos(cborHex, additionalUtxos);
        }
        return meshProvider.evaluateTx(cborHex);
      },
    };

    // Mesh requires a change address even when no change will ever be
    // emitted (shard mode runs `selectUtxosFrom([])`, so the builder won't
    // touch any UTxO that could produce change). When a wallet is present
    // we use its change address as before; when it isn't, we fall back to
    // the collateral input's address — guaranteed to exist on this tx and
    // always a valid bech32. In the (impossible-on-shard-mode) event mesh
    // emits change anyway, it lands back at the collateral provider rather
    // than vanishing.
    const changeAddress = args.wallet
      ? await args.wallet.getChangeAddress()
      : preparedCollateral.inputs[0]!.address;
    const walletUtxos =
      feePayer === "wallet" && args.wallet
        ? normalizeWalletUtxos(await args.wallet.getUtxos())
        : [];

    // Tiny populate-time placeholder per redeemer. Overwritten by the
    // evaluator before the final tx body is emitted. Sized small enough
    // that mesh's pre-evaluator min_fee check fits under any reasonable
    // `max_fee_per_mix_lovelace`.
    const exUnits = POPULATE_TIME_EXUNITS_PLACEHOLDER;

    const populate = (tx: InstanceType<typeof MeshTxBuilder>, feeOverride?: bigint) => {
      // Effective tx fee for this build pass:
      //   - shard mode: feeOverride (post-discovery actual fee) ?? plan.txFeeLovelace
      //                 (initial = max_fee_per_mix_lovelace).
      //   - wallet mode: feeOverride if set (Conway ref-script-fee correction);
      //                  otherwise mesh auto-computes during complete().
      const effectiveFee: bigint | null =
        feeOverride !== undefined
          ? feeOverride
          : plan.feePayer === "shard"
            ? plan.txFeeLovelace
            : null;
      // Effective fee_shard_output lovelace: feeIn - effectiveFee. Validator's
      // `fee_in - fee_out == tx.fee` invariant requires this to be coherent
      // with `effectiveFee`.
      const effectiveFeeOutLovelace: bigint | null =
        plan.feePayer === "shard" &&
        plan.feeShardInput !== null &&
        plan.feeShardOutput !== null &&
        effectiveFee !== null
          ? plan.feeShardInput.lovelace - effectiveFee
          : null;

      tx.readOnlyTxInReference(plan.referenceUtxoRef.txId, plan.referenceUtxoRef.outputIndex);

      // Spend each mix-box. mesh adds them in call order; the ledger sorts
      // at tx-finalization time, so the on-chain order is the lex-sorted
      // input order from the plan (matches the redeemer's proof order).
      for (const inp of plan.inputs) {
        tx.spendingPlutusScriptV3()
          .txIn(
            inp.ref.txId,
            inp.ref.outputIndex,
            [{ unit: "lovelace", quantity: inp.utxo.lovelace.toString() }],
            inp.utxo.address,
          )
          .txInInlineDatumPresent()
          // mix_box's spend redeemer is irrelevant data — it doesn't dispatch.
          .txInRedeemerValue("d87980", "CBOR", { ...exUnits })
          .spendingTxInReference(
            plan.mixBoxRefScriptUtxoRef.txId,
            plan.mixBoxRefScriptUtxoRef.outputIndex,
            sizeStr(args.addresses.referenceScriptSizes?.mix_box),
            args.addresses.mixBoxScriptHash,
          );
      }

      // Spend the fee shard with PayMixFee — only in shard mode.
      if (
        plan.feePayer === "shard" &&
        plan.feeShardInput &&
        plan.feeShardOutput &&
        plan.payMixFeeRedeemerCborHex
      ) {
        tx.spendingPlutusScriptV3()
          .txIn(
            plan.feeShardInput.ref.txId,
            plan.feeShardInput.ref.outputIndex,
            [
              {
                unit: "lovelace",
                quantity: plan.feeShardInput.lovelace.toString(),
              },
            ],
            plan.feeShardOutput.addressBech32,
          )
          .txInInlineDatumPresent()
          .txInRedeemerValue(plan.payMixFeeRedeemerCborHex, "CBOR", { ...exUnits })
          .spendingTxInReference(
            plan.feeContractRefScriptUtxoRef.txId,
            plan.feeContractRefScriptUtxoRef.outputIndex,
            sizeStr(args.addresses.referenceScriptSizes?.fee_contract),
            args.addresses.feeScriptHash,
          );
      }

      // mix_logic withdraw-zero with the Mix redeemer.
      tx.withdrawalPlutusScriptV3()
        .withdrawal(plan.mixLogicRewardAddressBech32, "0")
        .withdrawalRedeemerValue(plan.mixRedeemerCborHex, "CBOR", { ...exUnits })
        .withdrawalTxInReference(
          plan.mixLogicRefScriptUtxoRef.txId,
          plan.mixLogicRefScriptUtxoRef.outputIndex,
          sizeStr(args.addresses.referenceScriptSizes?.mix_logic),
          params.mixLogicScriptHash,
        );

      // Outputs 0..N-1: mix-boxes. The validator asserts this slot is
      // populated by mix-script outputs and that the tail is NOT.
      for (const o of plan.outputs) {
        tx.txOut(plan.mixBoxAddressBech32, [
          { unit: "lovelace", quantity: params.denomLovelace.toString() },
        ]).txOutInlineDatumValue(o.inlineDatumHex, "CBOR");
      }
      // Output N: fee shard (shard mode) or wallet change (wallet mode,
      // emitted by mesh during balancing).
      if (plan.feePayer === "shard" && plan.feeShardOutput && effectiveFeeOutLovelace !== null) {
        tx.txOut(plan.feeShardOutput.addressBech32, [
          { unit: "lovelace", quantity: effectiveFeeOutLovelace.toString() },
        ]).txOutInlineDatumValue(plan.feeShardOutput.inlineDatumHex, "CBOR");
      }

      // Pin the tx fee in shard mode (validator forces inputs - outputs ==
      // tx.fee), or when a wallet-mode override is provided (Conway
      // ref-script-fee correction). Wallet mode without override lets mesh
      // auto-compute.
      if (effectiveFee !== null) {
        tx.setFee(effectiveFee.toString());
      }

      // Collateral input + return. mesh derives `collateral_return` from the
      // input's address when the input value exceeds the protocol-required
      // collateral (= 1.5x fee), so we don't set it explicitly.
      for (const utxo of preparedCollateral.inputs) {
        tx.txInCollateral(
          utxo.ref.txId,
          utxo.ref.outputIndex,
          [{ unit: "lovelace", quantity: utxo.lovelace.toString() }],
          utxo.address,
        );
      }
      // Required signer for an external host. The host's server-side
      // validators reject any tx that doesn't list its pkh under
      // required_signers — see Collateral-Provider's
      // `api/validators/cbor.py::check_signers`.
      if (preparedCollateral.requiredSignerPkhHex) {
        tx.requiredSignerHash(preparedCollateral.requiredSignerPkhHex);
      }

      tx.changeAddress(changeAddress);
      if (plan.feePayer === "shard") {
        // Shard mode preserves wallet anonymity — no wallet input.
        tx.selectUtxosFrom([]);
      } else {
        tx.selectUtxosFrom(walletUtxos);
      }
    };

    const buildOnce = async (feeOverride?: bigint): Promise<string> => {
      const tx = new MeshTxBuilder({
        fetcher: meshProvider as never,
        submitter: meshProvider as never,
        // chainAwareEvaluator routes through evaluateTxWithAdditionalUtxos
        // when chainFrom is set; otherwise it delegates to meshProvider's
        // default evaluator.
        evaluator: chainAwareEvaluator as never,
        params: meshParams as never,
        verbose: false,
      });
      // mesh's default 1.1× safety buffer pushes evaluator-real budgets
      // further over the chain's per-tx exec cap at high N. We trust the
      // evaluator's numbers exactly — they're the chain's own values.
      tx.txEvaluationMultiplier = 1;
      populate(tx, feeOverride);
      return tx.complete();
    };

    // Build pass(es).
    //
    // Shard mode: pass 1 sets fee = max_fee_per_mix_lovelace (plan.txFeeLovelace)
    // and runs mesh's internal evaluator. We then read the per-redeemer
    // exec units from the chain's evaluator, recompute the actual minimum
    // fee from Cardano's formula (size + script + ref-script), and re-build
    // with that pinned. The validator's `fee_in - fee_out == tx.fee` invariant
    // means populate() also adjusts feeShardOutput.lovelace = feeIn - actualFee
    // in lockstep. Mix outputs at positions 0..N-1 are unchanged across passes
    // (the proofs are bound to those bytes), so the OR proofs stay valid.
    //
    // Wallet mode: mesh-csl @1.8.14 doesn't compute Conway's
    // reference-script-fee component (`set_ref_script_coins_per_byte` is
    // unwired), so the chain rejects with `FeeTooSmallUTxO`. We mirror the
    // withdraw flow's workaround: read mesh's auto-fee, add the missing
    // ref-script-fee, re-build with that pinned via `setFee`.
    let unsignedTxHex: string;
    try {
      unsignedTxHex = await buildOnce();
    } catch (evalErr) {
      const errMsg = evalErr instanceof Error ? evalErr.message : String(evalErr);
      throw new Error(
        `Mix tx: evaluator failed and there is no fallback. The chain provider's ` +
          `evaluateTx must return refined exec units for every redeemer. ` +
          `Original error: ${errMsg}`,
      );
    }

    const refScriptSize = computeMixRefScriptBytes(args.addresses, feePayer);
    const refScriptCostPerByte = Number(meshParams.minFeeRefScriptCostPerByte ?? 15);

    if (feePayer === "shard" && plan.feeShardInput && plan.txFeeLovelace !== null) {
      // Discovery pass: ask the chain's evaluator for the real per-redeemer
      // exec units now that pass 1 produced a complete tx body, then compute
      // Cardano's actual minimum fee. Re-build with that fee pinned so the
      // shard pays only what the chain will actually charge — instead of
      // over-paying max_fee_per_mix_lovelace every tx.
      //
      // Mix shard tx witness shape: zero wallet vkey witnesses (the whole
      // point of shard mode is wallet-anonymous submission) + one external
      // host vkey witness (collateral signer + required_signer_hash, both
      // satisfied by the giveme.my host's single key). mesh-csl's min-fee
      // check counts those expected witnesses against tx size; pass the
      // count through so our number lines up with mesh's check.
      const expectedVkeyWitnesses = 1;
      // Same evaluator the build-pass uses, so chainFrom is honoured here too.
      const evalRaw = await chainAwareEvaluator.evaluateTx(unsignedTxHex);
      if (Array.isArray(evalRaw)) {
        const totalExUnits = sumEvaluatorExUnits(
          evalRaw as Array<{ budget?: { mem?: number; steps?: number } }>,
        );
        const realParams = await args.provider.getProtocolParameters();
        const minFee = computeMinTxFee({
          txCborHex: unsignedTxHex,
          totalExUnits,
          refScriptBytes: refScriptSize,
          expectedVkeyWitnesses,
          params: {
            minFeeA: realParams.minFeeA,
            minFeeB: realParams.minFeeB,
            priceStep: realParams.pricesStep,
            priceMem: realParams.pricesMem,
            minFeeRefScriptCostPerByte: refScriptCostPerByte,
          },
        });
        // Cap at the on-chain max so the validator's
        // `tx.fee <= max_fee_per_mix_lovelace` rule still passes if the
        // network is unusually expensive (defensive — under normal Conway
        // params minFee << max).
        const capped = minFee > plan.txFeeLovelace ? plan.txFeeLovelace : minFee;

        console.log(
          `[lovejoin/mix] shard-mode fee discovery: minFee=${minFee} ` +
            `(size+script+ref) cap=${plan.txFeeLovelace} → setFee(${capped}); ` +
            `feeOut=${plan.feeShardInput.lovelace - capped}`,
        );
        if (capped !== plan.txFeeLovelace) {
          unsignedTxHex = await buildWithFeeBumpRetry(buildOnce, capped, plan.txFeeLovelace);
        }
      } else {
        console.warn(
          `[lovejoin/mix] shard-mode fee discovery: evaluator returned non-array ` +
            `result; falling back to plan.txFeeLovelace=${plan.txFeeLovelace}`,
        );
      }
    }

    if (feePayer === "wallet") {
      const cst = await import("@meshsdk/core-cst");
      const meshFee = extractFeeFromTxCbor(unsignedTxHex, cst);
      const refScriptFee = computeRefScriptFee(refScriptSize, refScriptCostPerByte);
      const correctedFee = meshFee + refScriptFee;

      console.log(
        `[lovejoin/mix] wallet-mode fee correction: mesh=${meshFee} + ref-script(` +
          `${refScriptSize}b × ${refScriptCostPerByte}/b)=${refScriptFee} → setFee(${correctedFee})`,
      );
      if (refScriptFee > 0n) {
        unsignedTxHex = await buildOnce(correctedFee);
      }
    }

    // Witness path. With GivemeMyProvider (the default for Mix) the user's
    // wallet does not sign at all — the host's vkey is the only signer the
    // tx needs. With WalletProvider the wallet signs the collateral input
    // through the normal CIP-30 path; absence of a wallet on that branch
    // is a programming error since defaultMixCollateralProvider() only
    // returns WalletProvider when args.wallet is set.
    let signedTx: string;
    if (preparedCollateral.externallySigned) {
      // Same additionalUtxos array used for the evaluator above is also
      // forwarded to the collateral host so its evaluator sees the same
      // chain state. See BuildMixArgs.chainFrom.
      const hostWitness = await collateralProvider.signTxBody(
        unsignedTxHex,
        additionalUtxos ? { additionalUtxos } : undefined,
      );
      if (!hostWitness) {
        throw new Error(
          "Mix tx: collateral provider claimed externallySigned but signTxBody() returned null",
        );
      }
      signedTx = await appendVkeyWitness(unsignedTxHex, hostWitness);

      console.log(
        `[lovejoin/mix] external collateral witness merged from ${hostWitness.vkeyHex.slice(0, 8)}…`,
      );
    } else {
      if (!args.wallet) {
        throw new Error(
          "Mix tx: the chosen collateral provider needs a wallet signature, but no wallet was supplied. Use GivemeMyProvider (default for shard mode on networks with a pinned host) for wallet-anonymous submission.",
        );
      }
      signedTx = await args.wallet.signTx(unsignedTxHex, true);
    }

    if (args.signOnly) {
      return { signedTxHex: signedTx, txId: "", plan };
    }
    const txId = await args.provider.submitTx(signedTx);
    return { signedTxHex: signedTx, txId, plan };
  }, args.retry);
}

/**
 * Pick the default Mix collateral provider.
 *
 * Rule: only fee-shard mode routes through the external host. In shard
 * mode the protocol promises wallet-anonymous Mix submission, which means
 * NO wallet input and NO wallet signature on the tx; that requires the
 * collateral input to come from someone other than the user — giveme.my
 * by default. In wallet-fee mode the wallet is already in the tx (paying
 * the fee + supplying change), so wallet-collateral is the right call —
 * routing through giveme.my would be a pointless extra HTTP round-trip.
 *
 * `preview` has no pinned host; shard mode falls back to wallet collateral
 * with a warning so dev environments keep working but the operator knows
 * Mix anonymity has degraded.
 */
function defaultMixCollateralProvider(args: BuildMixArgs): CollateralProvider {
  const feePayer = args.feePayer ?? "shard";
  if (feePayer !== "shard") {
    // wallet-mode: the up-front guard in buildMixTx already required
    // args.wallet, so the non-null assertion is safe here.
    return new WalletProvider(args.wallet!);
  }
  try {
    return new GivemeMyProvider({ network: args.network });
  } catch (e) {
    // No pinned host (typically `preview`). Without a wallet there's
    // also no fallback — surface a clean error instead of crashing
    // inside `WalletProvider(undefined)`.
    if (!args.wallet) {
      throw new Error(
        `Mix tx: no pinned collateral host for "${args.network}" and no wallet supplied. Pass an explicit collateralProvider, or connect a wallet so we can fall back to WalletProvider. Original: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    console.warn(
      `[lovejoin/mix] no pinned collateral host for "${args.network}" — falling back to ` +
        `wallet collateral. Mix anonymity is degraded on this path. Original: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
    return new WalletProvider(args.wallet);
  }
}

// ---------------------------------------------------------------------------
// Local utilities
// ---------------------------------------------------------------------------

/// Run `buildOnce(fee)` and, if mesh-csl rejects with
/// `Fee is less than the minimum fee. Min fee: X, Fee: Y`, retry with
/// `X` (capped at `feeCeiling`). Defends against any residual gap in
/// `computeMinTxFee`'s witness/utxo padding vs mesh-csl's internal
/// min-fee number — instead of playing exact-match games with mesh's
/// padding constants, we just take what it tells us. Up to 3 bumps;
/// each strict-increase guarantees we converge or hit the ceiling.
async function buildWithFeeBumpRetry(
  buildOnce: (feeOverride?: bigint) => Promise<string>,
  initialFee: bigint,
  feeCeiling: bigint,
  attempts = 3,
): Promise<string> {
  let fee = initialFee;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await buildOnce(fee);
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const match = msg.match(/Min fee:\s*(\d+)/);
      if (!match) throw e;
      const reportedMin = BigInt(match[1] ?? "0");
      if (reportedMin <= fee) throw e;
      const next = reportedMin > feeCeiling ? feeCeiling : reportedMin;

      console.warn(
        `[lovejoin/mix] mesh-csl reported Min fee=${reportedMin} > our fee=${fee}; ` +
          `retrying with setFee(${next}) (cap=${feeCeiling})`,
      );
      if (next === fee) throw e;
      fee = next;
    }
  }
  throw lastErr ?? new Error("buildWithFeeBumpRetry: exhausted retries");
}

/// Sum the byte sizes of every reference script attached to a Mix tx.
/// Conway's reference-script fee (`min_fee_ref_script_cost_per_byte`)
/// is computed against the SUM of unique reference-script bytes that
/// the tx pulls in. mix_box and mix_logic are always present; the fee
/// shard's ref script (`fee_contract`) is pulled in only in shard mode.
/// Returns 0 if `referenceScriptSizes` is missing from addresses.json
/// (older bootstraps); in that case the correction is a no-op and the
/// caller falls back to mesh's broken auto-fee, which the chain may
/// reject with `FeeTooSmallUTxO`.
function computeMixRefScriptBytes(addresses: LovejoinAddresses, feePayer: MixFeePayer): number {
  const sizes = addresses.referenceScriptSizes;
  if (!sizes) return 0;
  const base = (sizes.mix_box ?? 0) + (sizes.mix_logic ?? 0);
  return feePayer === "shard" ? base + (sizes.fee_contract ?? 0) : base;
}

function compareUtxoRef(a: MixInput, b: MixInput): number {
  // Lex compare on lowercase hex txid, then numeric compare on output index.
  const ta = a.ref.txId.toLowerCase();
  const tb = b.ref.txId.toLowerCase();
  if (ta < tb) return -1;
  if (ta > tb) return 1;
  return a.ref.outputIndex - b.ref.outputIndex;
}

function defaultPermutation(n: number): number[] {
  // Identity unless caller asks otherwise. Caller usually passes
  // `randomPermutation(n)` from pool/select.ts — keeping the default to
  // identity makes the planner deterministic for unit tests that don't
  // care about permutation entropy.
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i);
  return out;
}

function defaultYSecrets(n: number): Scalar[] {
  const out: Scalar[] = [];
  for (let i = 0; i < n; i++) out.push(drawScalar());
  return out;
}

function validatePermutation(p: ReadonlyArray<number>): void {
  const seen = new Set<number>();
  for (let i = 0; i < p.length; i++) {
    const v = p[i]!;
    if (!Number.isInteger(v) || v < 0 || v >= p.length) {
      throw new Error(`permutation: index ${v} at position ${i} out of range`);
    }
    if (seen.has(v)) {
      throw new Error(`permutation: duplicate target ${v}`);
    }
    seen.add(v);
  }
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
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

function sizeStr(n: number | undefined): string | undefined {
  return typeof n === "number" ? n.toString() : undefined;
}

// `generator` is imported for the re-rand path's symmetry with deposit.ts;
// not actually used by buildMixTx but kept reachable so future changes
// don't have to grow the import surface.
void generator;
