// Mix tx builder — variable-N Sigmajoin re-randomization.
//
// Spec:
//   * docs/spec/01-protocol.md §"Mix — variable N (the full Sigmajoin construction)".
//   * docs/spec/02-cryptography.md §"N-way Sigma-OR" + §"Context binding (Mix redeemer)".
//   * docs/spec/03-contracts.md §2 (Mix branch) + §3 (PayMixFee).
//   * docs/spec/04-offchain.md §"buildMixTx — variable N + collateral provider".
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
// Per-redeemer exec-unit estimates (see `mixExUnitsEstimate` below): mesh's
// default `DEFAULT_REDEEMER_BUDGET = {mem: 7M, steps: 3G}` is the
// per-tx upper bound, NOT a per-redeemer realistic value. With 4 redeemers
// in a shard-mode Mix at N=2 (2× mix_box stub + 1× mix_logic + 1×
// fee_contract), the placeholder min_fee comes out to ~2.74 ADA — which
// blows the on-chain `max_fee_per_mix_lovelace` cap of 2 ADA. Mesh
// rejects the build BEFORE the evaluator runs (the evaluator would
// otherwise refine these to the real values), surfacing as
// `Min fee 2743184, Fee 2000000`. The fix is to pass populate-time
// `exUnits` that already reflect the real validator costs scaled by N;
// mesh's first serialize pass then yields a min_fee under the cap, the
// setFee check passes, and the evaluator (when it works) refines the
// budgets downward into the final tx body. Numbers anchored to
// docs/perf.md (V3 cost-model estimates for the sigma-OR verifier);
// safety margin baked in so estimates exceed real usage and the
// chain-side validator runs comfortably within the claimed budget.
//
// Collateral: per spec §"Collateral provider", Mix txs require an external
// provider so the submitter's wallet doesn't show up as the collateral
// signer (which would defeat anonymity). The CollateralProvider passed in
// here CAN be a WalletProvider — it's an explicit override that the UI
// hides; the integration tests pin it that way until giveme.my's
// two-step API lands in M5.

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
import type {
  ChainProvider,
  Hex32,
  Lovelace,
  Utxo,
  UtxoRef,
} from "../chain/provider.js";
import {
  type CollateralProvider,
  WalletProvider,
} from "./collateral.js";
import { encodeMixDatum, generateOwnerSecret as drawScalar } from "./deposit.js";
import { pickRandomFeeShard } from "./fee.js";
import { getMeshProvider } from "./mesh-bridge.js";
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
  meshUtxoToLovejoin,
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
// Per-redeemer exec-unit estimates
// ---------------------------------------------------------------------------

/** mesh's `Budget` shape, redeclared locally so we don't import the type. */
export interface MixRedeemerExUnits {
  mem: number;
  steps: number;
}

/** All exec-unit budgets we attach to a single Mix tx's redeemers. */
export interface MixExUnitsPlan {
  /** mix_box's spend redeemer (one per input). The validator is a stub
   *  that returns true — this is just enough for the script wrapper
   *  overhead. */
  mixBox: MixRedeemerExUnits;
  /** mix_logic's withdrawal redeemer — the heavy sigma-OR verifier. Cost
   *  scales as ~N² (each of the N inputs runs an N-branch sigma-OR
   *  verify against the same N output statements). */
  mixLogic: MixRedeemerExUnits;
  /** fee_contract's spend redeemer (only emitted in shard mode). Cheap
   *  arithmetic check (`fee_in - fee_out == tx.fee` and
   *  `tx.fee ≤ max_fee_per_mix`). */
  feeContract: MixRedeemerExUnits;
}

/**
 * Realistic per-redeemer exec-unit estimates for a Mix tx at width N.
 *
 * Anchored to `docs/perf.md` (V3 cost-model estimates for the sigma-OR
 * verifier). The numbers carry a generous safety margin so they bound
 * real on-chain usage (the chain rejects a tx that exceeds the claimed
 * budget) while staying small enough that mesh's pre-evaluation
 * min_fee check stays under `max_fee_per_mix_lovelace`. When a working
 * evaluator is wired in, mesh refines these downward into the final tx
 * body — the values returned here only matter for the FIRST serialize
 * pass inside `MeshTxBuilder.complete()`.
 *
 * @param n Mix width (`2 ≤ n ≤ max_n`).
 */
export function mixExUnitsEstimate(n: number): MixExUnitsPlan {
  if (!Number.isInteger(n) || n < 2) {
    throw new Error(`mixExUnitsEstimate: n must be an integer ≥ 2, got ${n}`);
  }
  return {
    // Stub validator (always-true). Pad to absorb script-wrapper +
    // datum-decoding overhead; doesn't scale with N.
    mixBox: { mem: 50_000, steps: 10_000_000 },
    // sigma-OR verifier dominates total exec. Roughly: per-tx CPU ~
    // 0.15B × N² + 0.1B; per-tx mem ~ 0.35M × N² + 0.5M. Verified
    // against perf.md's per-N table; ~25% margin baked in.
    mixLogic: {
      mem: 500_000 + 350_000 * n * n,
      steps: 100_000_000 + 150_000_000 * n * n,
    },
    // Cheap balance check. Constant in N; the redeemer itself is `()`.
    feeContract: { mem: 250_000, steps: 70_000_000 },
  };
}

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
        [
          Buffer.from(br.t0),
          Buffer.from(br.t1),
          Buffer.from(br.c),
          Buffer.from(br.z),
        ],
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
export function serialiseMixDatumCanonical(args: {
  a: Uint8Array;
  b: Uint8Array;
}): Uint8Array {
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
    return new Uint8Array([
      0x1a,
      (v >>> 24) & 0xff,
      (v >>> 16) & 0xff,
      (v >>> 8) & 0xff,
      v & 0xff,
    ]);
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
    throw new Error(
      `ySecrets.length (${args.ySecrets.length}) must equal inputs.length (${n})`,
    );
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
      throw new Error(
        `Mix inputs include duplicate ref ${a.txId}#${a.outputIndex}`,
      );
    }
  }

  const ySecrets: Scalar[] = (args.ySecrets ?? defaultYSecrets(n)).map((y) => {
    if (y <= 0n || y >= SCALAR_ORDER) {
      throw new Error(`y_i must be in [1, r)`);
    }
    return y;
  });
  const permutation = args.permutation
    ? args.permutation.slice()
    : defaultPermutation(n);
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
  const datumBytes = outputs.map((o) =>
    serialiseMixDatumCanonical({ a: o.a, b: o.b }),
  );
  const valueBytes = outputs.map(() =>
    encodeAdaOnlyValueCbor(args.params.denomLovelace),
  );
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

  const mixBoxAddress = buildScriptAddress(
    args.addresses.mixBoxScriptHash,
    args.networkId,
    args.addresses.dappStakeKeyHashHex ?? null,
  );
  // Fee shards live at the enterprise (unstaked) script address — the
  // bootstrap funded them there. Mix-box outputs keep the dApp stake key
  // (single-stake-credential discoverability for the indexer); fee
  // outputs do not, because that's where the on-chain UTxOs already are.
  const feeAddress = buildScriptAddress(
    args.addresses.feeScriptHash,
    args.networkId,
    null,
  );

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
  const datumBytes = plan.outputs.map((o) =>
    serialiseMixDatumCanonical({ a: o.a, b: o.b }),
  );
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
    if (
      !verifySigmaOr(
        pointFromBytes(inp.a),
        pointFromBytes(inp.b),
        orStatements,
        proof,
        ctx,
      )
    ) {
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
   * Wallet — required for collateral signing when using WalletProvider.
   * Mesh's signTx is invoked at the end; the wallet provides the vkey
   * witness for the collateral input.
   */
  wallet: LovejoinWallet;
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
   * Collateral provider. Defaults to `WalletProvider(wallet)` for v1 —
   * see file-header comment on the M5 two-step refactor that brings
   * GivemeMyProvider into the Mix path properly.
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
 */
export async function buildMixTx(args: BuildMixArgs): Promise<MixResult> {
  const networkId = networkIdFor(args.network);
  const { params } = await fetchProtocolParams(args.addresses, args.provider);
  const feePayer: MixFeePayer = args.feePayer ?? "shard";

  // Resolve the fee shard. Shard mode picks one if not supplied; wallet
  // mode skips this entirely (no shard input on the tx).
  let feeShard: Utxo | undefined;
  if (feePayer === "shard") {
    feeShard = args.feeShard ?? (await pickRandomFeeShard({
      provider: args.provider,
      feeScriptAddressBech32: buildScriptAddress(
        args.addresses.feeScriptHash,
        networkId,
        null,
      ),
    }));
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
        `This is an encoding-parity bug — see docs/spec/12-build-guide.md §Risk 1.`,
    );
  }

  // Collateral.
  const collateralProvider = args.collateralProvider ?? new WalletProvider(args.wallet);
  // Cardano's collateralPercent is 150 — required collateral covers
  // 1.5x the tx fee. We pin to 5_000_000 lovelace as a generous default
  // (max_fee is sub-1-ADA so 5 ADA is well over).
  const collateralProvision = await collateralProvider.requestCollateral({
    txBodyDigest: new Uint8Array(32), // not used by WalletProvider
    collateralAmountLovelace: 5_000_000n,
  });
  if (collateralProvision.externalWitness !== null) {
    // For M4 we don't yet know how to merge an externally-supplied vkey
    // witness without first computing the body hash and round-tripping
    // through the provider. Bail loudly so the caller sees the limitation.
    throw new Error(
      "Mix tx: external collateral witness (e.g. GivemeMyProvider) requires the " +
        "two-step CollateralProvider refactor (deferred to M5). Use WalletProvider " +
        "for now or pass `collateralProvider: new WalletProvider(wallet)` explicitly.",
    );
  }

  const meshCore = await import("@meshsdk/core");
  const { MeshTxBuilder } = meshCore;
  const meshProvider = await getMeshProvider(args.provider);

  // Evaluator selection. The build flow tries Blockfrost's evaluator
  // first — when it works, mesh refines the populate-time `exUnits`
  // estimates (see `mixExUnitsEstimate(N)`) down to the real values,
  // tightening the on-chain claimed budgets. When it fails (Blockfrost
  // empirically returns `EvaluationFailure: ScriptFailures: {}` /
  // empty result for Mix txs that exercise `xor_bytearray` /
  // Conway builtin 77 in sigma_or.ak), we retry without the evaluator
  // and let the populate-time estimates ride straight into the final
  // tx body. The estimates are conservative (≥ real usage with margin)
  // and small enough to fit under `max_fee_per_mix_lovelace`, so both
  // shard and wallet mode succeed regardless of evaluator status.
  //
  // Do NOT swap to mesh's OfflineEvaluator (`@meshsdk/core-csl`).
  // Its bundled UPLC machine also predates Conway's bitwise builtins
  // and aborts with "Default Function not found - 77".

  // Pre-resolve everything mesh's complete() will need from outside the
  // builder, so the build-and-complete attempt below can run twice
  // without duplicating side effects (wallet RPCs, etc).
  const changeAddress = await args.wallet.getChangeAddress();
  const walletUtxos =
    feePayer === "wallet"
      ? normalizeWalletUtxos(await args.wallet.getUtxos())
      : [];

  // Per-redeemer exec-unit estimates that bypass mesh's
  // `DEFAULT_REDEEMER_BUDGET = {mem: 7M, steps: 3G}` placeholder. See the
  // file-header note on fee handling for why the default is unusable in
  // shard mode (4 redeemers × default would put min_fee above the 2 ADA
  // cap before the evaluator gets a chance to refine).
  const exUnits = mixExUnitsEstimate(plan.n);

  const populate = (tx: InstanceType<typeof MeshTxBuilder>) => {
    tx.readOnlyTxInReference(
      plan.referenceUtxoRef.txId,
      plan.referenceUtxoRef.outputIndex,
    );

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
        .txInRedeemerValue("d87980", "CBOR", exUnits.mixBox)
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
        .txInRedeemerValue(plan.payMixFeeRedeemerCborHex, "CBOR", exUnits.feeContract)
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
      .withdrawalRedeemerValue(plan.mixRedeemerCborHex, "CBOR", exUnits.mixLogic)
      .withdrawalTxInReference(
        plan.mixLogicRefScriptUtxoRef.txId,
        plan.mixLogicRefScriptUtxoRef.outputIndex,
        sizeStr(args.addresses.referenceScriptSizes?.mix_logic),
        params.mixLogicScriptHash,
      );

    // Outputs 0..N-1: mix-boxes. The validator asserts this slot is
    // populated by mix-script outputs and that the tail is NOT.
    for (const o of plan.outputs) {
      tx
        .txOut(plan.mixBoxAddressBech32, [
          { unit: "lovelace", quantity: params.denomLovelace.toString() },
        ])
        .txOutInlineDatumValue(o.inlineDatumHex, "CBOR");
    }
    // Output N: fee shard (shard mode) or wallet change (wallet mode,
    // emitted by mesh during balancing).
    if (plan.feePayer === "shard" && plan.feeShardOutput) {
      tx
        .txOut(plan.feeShardOutput.addressBech32, [
          {
            unit: "lovelace",
            quantity: plan.feeShardOutput.lovelace.toString(),
          },
        ])
        .txOutInlineDatumValue(plan.feeShardOutput.inlineDatumHex, "CBOR");
    }

    // Pin the fee in shard mode (inputs - outputs balance to
    // txFeeLovelace). Wallet mode lets mesh compute the minimum fee.
    if (plan.feePayer === "shard" && plan.txFeeLovelace !== null) {
      tx.setFee(plan.txFeeLovelace.toString());
    }

    // Collateral input + return.
    for (const utxo of collateralProvision.inputs) {
      tx.txInCollateral(
        utxo.ref.txId,
        utxo.ref.outputIndex,
        [{ unit: "lovelace", quantity: utxo.lovelace.toString() }],
        utxo.address,
      );
    }

    tx.changeAddress(changeAddress);
    if (plan.feePayer === "shard") {
      // Shard mode preserves wallet anonymity — no wallet input.
      tx.selectUtxosFrom([]);
    } else {
      tx.selectUtxosFrom(walletUtxos);
    }
  };

  const buildOnce = async (withEvaluator: boolean): Promise<string> => {
    const tx = new MeshTxBuilder({
      fetcher: meshProvider as never,
      submitter: meshProvider as never,
      ...(withEvaluator ? { evaluator: meshProvider as never } : {}),
      verbose: false,
    });
    populate(tx);
    return tx.complete();
  };

  // First attempt with the evaluator wired in. On failure (e.g.
  // Blockfrost's evaluator gap on V3 bitwise builtins), fall back to
  // the populate-time `exUnits` estimates from `mixExUnitsEstimate(N)`.
  // Those estimates are tight enough to keep min_fee under
  // `max_fee_per_mix_lovelace`, so even shard mode succeeds without a
  // working evaluator — the redeemers just claim the estimated budgets,
  // and chain-side validation runs against them. The estimates carry a
  // safety margin so chain exec stays within the claimed budget.
  let unsignedTxHex: string;
  try {
    unsignedTxHex = await buildOnce(true);
  } catch (evalErr) {
    const errMsg = evalErr instanceof Error ? evalErr.message : String(evalErr);
    // eslint-disable-next-line no-console
    console.warn(
      `Mix evaluator failed; retrying with populate-time exUnits estimates. ` +
        `Original error: ${errMsg.slice(0, 200)}`,
    );
    unsignedTxHex = await buildOnce(false);
  }
  const signedTx = await args.wallet.signTx(unsignedTxHex, true);

  if (args.signOnly) {
    return { signedTxHex: signedTx, txId: "", plan };
  }
  const txId = await args.provider.submitTx(signedTx);
  return { signedTxHex: signedTx, txId, plan };
}

// ---------------------------------------------------------------------------
// Local utilities
// ---------------------------------------------------------------------------

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
