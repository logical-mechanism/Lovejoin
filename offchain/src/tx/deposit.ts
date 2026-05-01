// Deposit tx builder.
//
// Spec:
//   * docs/spec/01-protocol.md §"Deposit" — tx structure (1 fee shard input
//     with Replenish, 1 mix-box output, 1 replenished fee shard output).
//   * docs/spec/03-contracts.md §3 (validate_replenish) — the on-chain rules
//     this tx must satisfy.
//   * docs/spec/04-offchain.md §"buildDepositTx".
//
// Architecture: split into a pure planning function (`planDepositTx`) and a
// mesh-driven assembler (`buildDepositTx`). The planning function is the
// part with all the protocol logic — datum encoding, output value
// computation, redeemer construction — and is exhaustively unit-tested
// without any chain or wallet plumbing. The mesh assembler glues the plan
// onto MeshTxBuilder and is exercised by the Preprod integration test.

import {
  G1_COMPRESSED_BYTES,
  SCALAR_ORDER,
  type Scalar,
  generator,
  pointFromBytes,
  pointToBytes,
  publicPointG,
  scalarMul,
} from "../crypto/index.js";
import { Encoder, Tag } from "cbor-x";

import type { ChainProvider, Lovelace, Utxo, UtxoRef } from "../chain/provider.js";
import {
  type CollateralProvider,
  WalletProvider,
} from "./collateral.js";
import { mergeExternalCollateralWitness } from "./witness-merge.js";
import { getMeshProtocolParams, getMeshProvider } from "./mesh-bridge.js";
import {
  pickFeeShardOptional,
  replenishOutputLovelace,
} from "./fee.js";
import {
  fetchProtocolParams,
  type LovejoinAddresses,
  type ProtocolParams,
  parseUtxoRef,
} from "./params.js";
import { buildScriptAddress } from "./address.js";
import {
  type LovejoinNetworkId,
  type LovejoinWallet,
  meshUtxoToLovejoin,
  networkIdFor,
  normalizeWalletUtxos,
} from "../wallet/cip30.js";

/**
 * Plan for a Deposit tx — pure data, fully describing what the tx will
 * commit. Produced by `planDepositTx`; consumed by `buildDepositTx` (and the
 * unit-test harness that asserts the plan's correctness without invoking
 * mesh).
 */
export interface DepositPlan {
  /** Owner secret `x ∈ Z_r` that controls the new mix-box. */
  ownerSecret: Scalar;
  /** Compressed `a = g` (48 bytes). The canonical generator. */
  a: Uint8Array;
  /** Compressed `b = [x]·g` (48 bytes). The owner's public point. */
  b: Uint8Array;
  /** Mix-box output (position 0 in the tx). */
  mixBoxOutput: {
    addressBech32: string;
    lovelace: Lovelace;
    /** Plutus-Data CBOR hex of `MixDatum { a, b }` (Constr 0 [a, b]). */
    inlineDatumHex: string;
  };
  /**
   * Replenished fee shard output (position 1 in the tx). `null` when the
   * deposit runs without a fee-shard input (no shards on chain) — the tx
   * is then mix-box-only and mesh balances against the wallet alone.
   */
  feeShardOutput: {
    addressBech32: string;
    lovelace: Lovelace;
    /** Plutus-Data CBOR hex of `()` (Constr 0 []). */
    inlineDatumHex: string;
  } | null;
  /** The fee shard being consumed, or `null` when running shard-less. */
  feeShardInput: Utxo | null;
  /**
   * Plutus-Data CBOR hex of the `Replenish` redeemer (Constr 1 []).
   * `null` when running shard-less.
   */
  replenishRedeemerHex: string | null;
  /** Reference UTxO (read-only via tx.reference_inputs). */
  referenceUtxoRef: UtxoRef;
  /**
   * CIP-33 reference-script UTxO for the fee_contract validator. `null`
   * when running shard-less (no fee_contract spend in the tx).
   */
  feeContractRefScriptUtxoRef: UtxoRef | null;
}

/** Owner secret + a label for the SDK to surface to the UI / CLI. */
export interface OwnerSecretMaterial {
  /** 32-byte big-endian scalar `x` in `[1, r)`. */
  secret: Scalar;
  /** Lowercase 64-char hex of `secret`. */
  secretHex: string;
  /**
   * 48-byte compressed hex of the box's `a` point. With deposit-time
   * re-randomization this is `[d]·g` for a fresh per-deposit `d`, not
   * the canonical generator. Withdraw needs this to reconstruct the
   * box's inline datum and verify ownership.
   */
  aHex: string;
  /**
   * 48-byte compressed hex of the box's `b` point — `[x]·a`. With
   * re-randomization that's `[x·d]·g`. Stored as `publicPointHex` for
   * backwards-compat with code that pre-dates re-randomization (where
   * `a = g` made `b == [x]·g` the natural label).
   */
  publicPointHex: string;
  /**
   * Stable short label, suitable for filenames or storage keys: the first
   * 16 hex chars of `b`. Not collision-resistant — for human filing only.
   */
  label: string;
}

export interface DepositResult {
  /** Signed tx CBOR hex. */
  signedTxHex: string;
  /** Tx hash returned by the chain provider. */
  txId: string;
  /** Owner secret material for the new mix-box. */
  owner: OwnerSecretMaterial;
  /** Always 0 — Lovejoin's deposit tx puts the mix-box at output index 0. */
  mixBoxOutputIndex: 0;
}

// ---------------------------------------------------------------------------
// Plutus-Data CBOR helpers
// ---------------------------------------------------------------------------

const cborEncoder = new Encoder();

/** CBOR hex for `Constr 0 []` — the unit datum. */
export const UNIT_DATUM_CBOR_HEX = "d87980";

/** CBOR hex for `Constr 1 []` — the FeeRedeemer.Replenish variant. */
export const REPLENISH_REDEEMER_CBOR_HEX = "d87a80";

/**
 * Encode a `MixDatum { a, b }` to canonical Plutus-Data CBOR.
 *
 * Layout: `Constr 0 [bytes(a, 48), bytes(b, 48)]`. Both `a` and `b` MUST be
 * 48-byte compressed BLS12-381 G1 elements (Lovejoin's curve). The on-chain
 * `try_decode_well_formed_inline` in mixbox.ak rejects anything else.
 */
export function encodeMixDatum(args: { a: Uint8Array; b: Uint8Array }): string {
  if (args.a.length !== G1_COMPRESSED_BYTES) {
    throw new Error(`MixDatum.a must be ${G1_COMPRESSED_BYTES} bytes, got ${args.a.length}`);
  }
  if (args.b.length !== G1_COMPRESSED_BYTES) {
    throw new Error(`MixDatum.b must be ${G1_COMPRESSED_BYTES} bytes, got ${args.b.length}`);
  }
  if (bytesEqual(args.a, args.b)) {
    throw new Error("MixDatum: a and b must differ — equal points are rejected on chain");
  }
  // cbor-x emits Buffer instances inside arrays as CBOR byte strings (major
  // type 2), which is exactly what Plutus's bytes encoding expects.
  const tagged = new Tag([Buffer.from(args.a), Buffer.from(args.b)], 121);
  return bytesToHex(cborEncoder.encode(tagged));
}

/** Validate a 32-byte big-endian secret scalar in `[1, r)`. */
export function assertOwnerSecret(secret: Scalar): void {
  if (secret <= 0n || secret >= SCALAR_ORDER) {
    throw new Error("ownerSecret must be in [1, r)");
  }
}

/** Generate a fresh owner secret using the provided RNG (default: WebCrypto). */
export function generateOwnerSecret(rng?: () => Uint8Array): Scalar {
  return drawScalar(rng);
}

/**
 * Draw a fresh scalar `d ∈ [1, r)` for deposit-time re-randomization.
 * Same shape as `generateOwnerSecret` — kept under a distinct name so
 * call sites self-document the role of the value.
 */
export function generateRerandomizationScalar(rng?: () => Uint8Array): Scalar {
  return drawScalar(rng);
}

function drawScalar(rng?: () => Uint8Array): Scalar {
  const draw = rng ?? defaultScalarDraw;
  // Reject-sample 32 random bytes until we land in [1, r). With r ≈ 2^255
  // this almost always passes on the first try.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const bytes = draw();
    if (bytes.length !== 32) {
      throw new Error(`scalar draw must return 32 bytes, got ${bytes.length}`);
    }
    let s = 0n;
    for (const b of bytes) s = (s << 8n) | BigInt(b);
    if (s > 0n && s < SCALAR_ORDER) return s;
  }
}

function defaultScalarDraw(): Uint8Array {
  const buf = new Uint8Array(32);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.getRandomValues) {
    throw new Error("generateOwnerSecret: globalThis.crypto.getRandomValues unavailable");
  }
  c.getRandomValues(buf);
  return buf;
}

/**
 * Build the public material that pairs with an owner secret given an
 * already-computed box `a` point (compressed bytes). With deposit-time
 * re-randomization the caller supplies `a = [d]·g`; without it (e.g.
 * the legacy `deriveOwner(secret)` overload) `a` defaults to the
 * canonical generator and `b = [x]·g`.
 */
export function deriveOwner(
  secret: Scalar,
  aBytes?: Uint8Array,
): OwnerSecretMaterial {
  assertOwnerSecret(secret);
  if (aBytes) {
    if (aBytes.length !== G1_COMPRESSED_BYTES) {
      throw new Error(
        `deriveOwner: a must be ${G1_COMPRESSED_BYTES} bytes, got ${aBytes.length}`,
      );
    }
    // b = [x]·a (whatever a is). Re-randomized deposits set a = [d]·g.
    const aPoint = pointFromBytes(aBytes);
    const b = pointToBytes(scalarMul(secret, aPoint));
    const aHex = bytesToHex(aBytes);
    const publicPointHex = bytesToHex(b);
    return {
      secret,
      secretHex: scalarToHex(secret),
      aHex,
      publicPointHex,
      label: publicPointHex.slice(0, 16),
    };
  }
  // Legacy path: a = g, b = [x]·g. Used by tests / call sites that
  // pre-date re-randomization.
  const a = pointToBytes(generator());
  const b = pointToBytes(publicPointG(secret));
  const publicPointHex = bytesToHex(b);
  return {
    secret,
    secretHex: scalarToHex(secret),
    aHex: bytesToHex(a),
    publicPointHex,
    label: publicPointHex.slice(0, 16),
  };
}

// ---------------------------------------------------------------------------
// planDepositTx — pure
// ---------------------------------------------------------------------------

export interface PlanDepositArgs {
  /** Owner secret to use; if omitted, a fresh one is generated via WebCrypto. */
  ownerSecret?: Scalar;
  /**
   * Optional re-randomization scalar `d ∈ [1, r)`. When provided the new
   * mix-box's `a = [d]·g`; otherwise a fresh `d` is drawn via WebCrypto.
   * Pass `null` to opt into the legacy `a = g` behavior — useful for
   * deterministic tests that pre-date re-randomization.
   */
  rerandomization?: Scalar | null;
  /** Number of mix rounds the user wants to fund — drives the fee top-up. */
  rounds: number;
  /** Lovejoin protocol parameters from the reference UTxO. */
  params: ProtocolParams;
  /** Bootstrap addresses.json — provides script hashes + reference UTxO. */
  addresses: LovejoinAddresses;
  /**
   * Fee shard the SDK has chosen to consume. Pass `null` (or omit) to build
   * a shard-less deposit — only the mix-box output is emitted, and mesh
   * balances against the wallet's own UTxOs. The on-chain fee_contract is
   * never invoked.
   */
  feeShard?: Utxo | null;
  /** Network discriminator for bech32 address construction. */
  networkId: LovejoinNetworkId;
  /** Optional minimum rounds (for UI parity); throws if `rounds` is below. */
  minRounds?: number;
}

export function planDepositTx(args: PlanDepositArgs): DepositPlan {
  const ownerSecret = args.ownerSecret ?? generateOwnerSecret();
  assertOwnerSecret(ownerSecret);

  // Re-randomize the deposit: `a = [d]·g`, `b = [x]·a = [x·d]·g`. Without
  // this every fresh deposit lands at `(g, [x]·g)`, which lets observers
  // trivially distinguish "just deposited" boxes from boxes that have
  // been through at least one Mix. With `d` drawn freshly per deposit
  // each new box looks indistinguishable from a mid-mix-pool box.
  // The user only ever stores `x` — `d` is consumed at deposit time and
  // discarded. The validator's Schnorr check `b == [x]·a` still holds.
  const d: Scalar | null = args.rerandomization === undefined
    ? generateRerandomizationScalar()
    : args.rerandomization;
  let aPoint;
  let bPoint;
  if (d === null) {
    // Legacy `a = g` path — kept for tests + KAT vectors that depend
    // on byte-stable outputs.
    aPoint = generator();
    bPoint = publicPointG(ownerSecret);
  } else {
    if (d <= 0n || d >= SCALAR_ORDER) {
      throw new Error("rerandomization scalar must be in [1, r)");
    }
    aPoint = scalarMul(d, generator());
    bPoint = scalarMul(ownerSecret, aPoint);
  }
  const a = pointToBytes(aPoint);
  const b = pointToBytes(bPoint);

  const mixBoxAddress = buildScriptAddress(
    args.addresses.mixBoxScriptHash,
    args.networkId,
    args.addresses.dappStakeKeyHashHex ?? null,
  );
  // Fee shards live at the enterprise (unstaked) script address — the
  // bootstrap funded them there. Don't add the dApp stake key here or we'd
  // be looking up an empty address.
  const feeAddress = buildScriptAddress(
    args.addresses.feeScriptHash,
    args.networkId,
    null,
  );

  // Shard-less deposit: emit only the mix-box. The fee_contract is not
  // invoked at all — mesh balances the lovelace against the wallet.
  if (!args.feeShard) {
    if (!Number.isInteger(args.rounds) || args.rounds <= 0) {
      throw new Error(`rounds must be a positive integer, got ${args.rounds}`);
    }
    if (args.minRounds !== undefined && args.rounds < args.minRounds) {
      throw new Error(
        `rounds=${args.rounds} below minRounds=${args.minRounds}; UI should reject`,
      );
    }
    return {
      ownerSecret,
      a,
      b,
      mixBoxOutput: {
        addressBech32: mixBoxAddress,
        lovelace: args.params.denomLovelace,
        inlineDatumHex: encodeMixDatum({ a, b }),
      },
      feeShardOutput: null,
      feeShardInput: null,
      replenishRedeemerHex: null,
      referenceUtxoRef: parseUtxoRef(args.addresses.referenceUtxoRef),
      feeContractRefScriptUtxoRef: null,
    };
  }

  const replenishedLovelace = replenishOutputLovelace({
    shard: args.feeShard,
    rounds: args.rounds,
    params: args.params,
    ...(args.minRounds !== undefined ? { minRounds: args.minRounds } : {}),
  });

  return {
    ownerSecret,
    a,
    b,
    mixBoxOutput: {
      addressBech32: mixBoxAddress,
      lovelace: args.params.denomLovelace,
      inlineDatumHex: encodeMixDatum({ a, b }),
    },
    feeShardOutput: {
      addressBech32: feeAddress,
      lovelace: replenishedLovelace,
      inlineDatumHex: UNIT_DATUM_CBOR_HEX,
    },
    feeShardInput: args.feeShard,
    replenishRedeemerHex: REPLENISH_REDEEMER_CBOR_HEX,
    referenceUtxoRef: parseUtxoRef(args.addresses.referenceUtxoRef),
    feeContractRefScriptUtxoRef: parseUtxoRef(args.addresses.referenceScriptUtxos.fee_contract),
  };
}

// ---------------------------------------------------------------------------
// buildDepositTx — drives mesh
// ---------------------------------------------------------------------------

export interface BuildDepositArgs {
  /** Network name from config. Drives bech32 HRP + mesh networkId. */
  network: "preprod" | "preview" | "test" | "mainnet";
  /** Number of rounds the user wants to fund. */
  rounds: number;
  /** Optional pre-generated owner secret. */
  ownerSecret?: Scalar;
  /** Optional minimum rounds (UI enforces; SDK still validates). */
  minRounds?: number;
  /** User wallet — supplies inputs, change, collateral, and signing. */
  wallet: LovejoinWallet;
  /** Chain provider — for reference UTxO + protocol params + submission. */
  provider: ChainProvider;
  /** Bootstrap addresses.json content. */
  addresses: LovejoinAddresses;
  /**
   * Optional pre-picked fee shard (otherwise the SDK picks uniformly). Pass
   * `null` to force a shard-less deposit even when shards exist; pass
   * `undefined` (or omit) to let the SDK pick one — and silently fall back
   * to shard-less when none are available on chain.
   */
  feeShard?: Utxo | null;
  /**
   * Optional UTxO refs to skip when auto-picking a fee shard. Lets the
   * caller forward a mempool snapshot so deposits don't pick a shard
   * that's already an input to an in-flight tx. Ignored when `feeShard`
   * is supplied explicitly. If excluding leaves zero candidates the
   * picker falls back to the full set rather than refusing — concurrency
   * hint, not a hard constraint.
   */
  excludeFeeShardRefs?: ReadonlyArray<UtxoRef>;
  /** Optional collateral provider. Default: WalletProvider(wallet). */
  collateralProvider?: CollateralProvider;
  /**
   * If true, the SDK signs but doesn't submit — caller can dry-run the
   * built tx. Default: false (sign + submit).
   */
  signOnly?: boolean;
}

/**
 * Build, sign, and (optionally) submit a Deposit tx on Cardano.
 *
 * Output ordering is fixed: position 0 is the new mix-box; position 1 (if
 * any) is the replenished fee shard. mesh handles fee + change. When the
 * caller passes `feeShard: null` or no fee shards exist on chain, the tx
 * is mix-box-only — the fee_contract is not invoked.
 */
export async function buildDepositTx(args: BuildDepositArgs): Promise<DepositResult> {
  const networkId = networkIdFor(args.network);

  const { params } = await fetchProtocolParams(args.addresses, args.provider);
  const feeAddress = buildScriptAddress(
    args.addresses.feeScriptHash,
    networkId,
    null,
  );
  // `undefined` → auto-pick (or null when no shards on chain); `null`
  // → explicit shard-less; a `Utxo` → explicit shard.
  const feeShard = args.feeShard !== undefined
    ? args.feeShard
    : await pickFeeShardOptional({
        provider: args.provider,
        feeScriptAddressBech32: feeAddress,
        ...(args.excludeFeeShardRefs && args.excludeFeeShardRefs.length > 0
          ? { excludeRefs: args.excludeFeeShardRefs }
          : {}),
      });

  const plan = planDepositTx({
    ...(args.ownerSecret !== undefined ? { ownerSecret: args.ownerSecret } : {}),
    rounds: args.rounds,
    params,
    addresses: args.addresses,
    feeShard,
    networkId,
    ...(args.minRounds !== undefined ? { minRounds: args.minRounds } : {}),
  });

  // Wallet collateral. Deposit defaults to WalletProvider — the user's
  // wallet is already in the tx, so wallet anonymity isn't a concern. Pass
  // an explicit provider to route through giveme.my (e.g. for fresh wallets
  // that don't have a 5-ADA collateral UTxO).
  const collateral = args.collateralProvider ?? new WalletProvider(args.wallet);
  const preparedCollateral = await collateral.prepareCollateral({
    provider: args.provider,
    collateralAmountLovelace: 5_000_000n,
  });

  // Lazily import mesh classes to avoid loading libsodium on test paths
  // that don't exercise this function. See wallet/cip30.ts for context.
  const { MeshTxBuilder } = await import("@meshsdk/core");

  // mesh's tx builder needs a real `IFetcher` / `ISubmitter` / `IEvaluator`
  // (with `fetchUTxOs`, `fetchProtocolParameters`, `evaluateTx`, ...) —
  // our `ChainProvider` doesn't satisfy that surface. The provider exposes
  // a lazy mesh sibling via `.meshProvider()` that's the same Blockfrost
  // data, shaped for mesh. Wiring it as `evaluator` is what makes mesh
  // call Blockfrost's `/utils/txs/evaluate` endpoint to compute real
  // exec-unit budgets — without it MeshTxBuilder uses worst-case defaults
  // that inflate the fee 10x or worse.
  const meshProvider = await getMeshProvider(args.provider);
  const meshParams = await getMeshProtocolParams(args.provider);
  const txBuilder = new MeshTxBuilder({
    fetcher: meshProvider as never,
    submitter: meshProvider as never,
    evaluator: meshProvider as never,
    params: meshParams as never,
    verbose: false,
  });
  // Trust evaluator-returned exec units exactly (mesh defaults to 1.1×).
  txBuilder.txEvaluationMultiplier = 1;

  // Wallet inputs (mesh handles selection).
  const walletUtxos = normalizeWalletUtxos(await args.wallet.getUtxos());
  const changeAddress = await args.wallet.getChangeAddress();

  // Build the tx body. Reference UTxO is always read; fee-shard spend is
  // only added when the plan included a shard (otherwise the deposit is
  // mix-box-only and the fee_contract isn't invoked).
  const tx = txBuilder.readOnlyTxInReference(
    plan.referenceUtxoRef.txId,
    plan.referenceUtxoRef.outputIndex,
  );

  if (
    plan.feeShardInput &&
    plan.feeShardOutput &&
    plan.replenishRedeemerHex &&
    plan.feeContractRefScriptUtxoRef
  ) {
    tx
      .spendingPlutusScriptV3()
      .txIn(
        plan.feeShardInput.ref.txId,
        plan.feeShardInput.ref.outputIndex,
        [{ unit: "lovelace", quantity: plan.feeShardInput.lovelace.toString() }],
        plan.feeShardOutput.addressBech32,
      )
      .txInInlineDatumPresent()
      .txInRedeemerValue(plan.replenishRedeemerHex, "CBOR")
      .spendingTxInReference(
        plan.feeContractRefScriptUtxoRef.txId,
        plan.feeContractRefScriptUtxoRef.outputIndex,
        // mesh's `(txHash, txIndex, scriptSize?, scriptHash?)`. Pass both
        // explicitly: the hash because without it mesh derived an empty
        // bytestring downstream and CSL bailed on "expected hash length 28
        // but got Len(0)"; the size because mesh uses it for the
        // size-based fee component.
        args.addresses.referenceScriptSizes?.fee_contract?.toString(),
        args.addresses.feeScriptHash,
      );
  }

  // Output 0: new mix-box.
  tx
    .txOut(plan.mixBoxOutput.addressBech32, [
      { unit: "lovelace", quantity: plan.mixBoxOutput.lovelace.toString() },
    ])
    .txOutInlineDatumValue(plan.mixBoxOutput.inlineDatumHex, "CBOR");

  // Output 1 (only when replenishing): the topped-up fee shard.
  if (plan.feeShardOutput) {
    tx
      .txOut(plan.feeShardOutput.addressBech32, [
        { unit: "lovelace", quantity: plan.feeShardOutput.lovelace.toString() },
      ])
      .txOutInlineDatumValue(plan.feeShardOutput.inlineDatumHex, "CBOR");
  }

  tx.changeAddress(changeAddress).selectUtxosFrom(walletUtxos);

  // Collateral input(s). mesh's API takes (txHash, idx, amount?, address?).
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

  const unsignedTx = await tx.complete();
  const walletSignedTx = await args.wallet.signTx(unsignedTx);
  const signedTx = preparedCollateral.externallySigned
    ? await mergeExternalCollateralWitness(collateral, walletSignedTx)
    : walletSignedTx;
  const owner = deriveOwner(plan.ownerSecret, plan.a);

  if (args.signOnly) {
    return {
      signedTxHex: signedTx,
      txId: "", // not submitted yet
      owner,
      mixBoxOutputIndex: 0,
    };
  }

  const txId = await args.provider.submitTx(signedTx);
  return {
    signedTxHex: signedTx,
    txId,
    owner,
    mixBoxOutputIndex: 0,
  };
}

// ---------------------------------------------------------------------------
// Local utilities
// ---------------------------------------------------------------------------

/**
 * Reusable converter for callers that have an array of mesh UTxOs in hand
 * (e.g. from `wallet.getUtxos()`) and want chain/provider Utxo shape.
 */
export function meshUtxosToLovejoin(
  meshUtxos: ReadonlyArray<Parameters<typeof meshUtxoToLovejoin>[0]>,
): Utxo[] {
  return meshUtxos.map(meshUtxoToLovejoin);
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function scalarToHex(s: Scalar): string {
  let hex = s.toString(16);
  if (hex.length > 64) throw new Error("scalar overflows 32 bytes");
  if (hex.length < 64) hex = hex.padStart(64, "0");
  return hex;
}

// ---------------------------------------------------------------------------
// Bulk deposit — N distinct mix-box outputs from a single fee shard
// ---------------------------------------------------------------------------

/** One planned mix-box output in a bulk deposit. */
export interface BulkDepositBoxPlan {
  ownerSecret: Scalar;
  /** 48-byte compressed `a = [d_i]·g`. */
  a: Uint8Array;
  /** 48-byte compressed `b = [x_i·d_i]·g`. */
  b: Uint8Array;
  output: {
    addressBech32: string;
    lovelace: Lovelace;
    inlineDatumHex: string;
  };
}

/**
 * Plan for a bulk-deposit tx. N mix-box outputs at positions 0..N-1, then
 * (when replenishing) the replenished fee shard at position N. mesh handles
 * fee + change after. With no fee shard supplied the tx is mix-boxes-only
 * and the fee_contract is not invoked.
 */
export interface BulkDepositPlan {
  boxes: BulkDepositBoxPlan[];
  feeShardOutput: {
    addressBech32: string;
    lovelace: Lovelace;
    inlineDatumHex: string;
  } | null;
  feeShardInput: Utxo | null;
  replenishRedeemerHex: string | null;
  referenceUtxoRef: UtxoRef;
  feeContractRefScriptUtxoRef: UtxoRef | null;
}

export interface PlanBulkDepositArgs {
  /**
   * Per-box owner secrets, in the order they should appear in the tx
   * outputs (positions 0..N-1). N ≥ 1. Each secret should come from
   * `deriveOwnerSecret(seed, index)` with a distinct index — the SDK
   * doesn't enforce that here because it can't see the seed; the UI is
   * expected to bump `nextDepositIndex` per box.
   */
  ownerSecrets: ReadonlyArray<Scalar>;
  /**
   * Per-box re-randomization scalars `d_i ∈ [1, r)`. If omitted, a fresh
   * `d_i` is drawn per box via WebCrypto. Pass `null` for a slot to opt
   * into the legacy `a = g` behaviour (the on-chain validator accepts
   * either, but distinct `d_i` per box keeps the new boxes
   * indistinguishable from mid-pool boxes).
   */
  rerandomizations?: ReadonlyArray<Scalar | null>;
  /** Number of mix rounds to fund per new box. Total contribution =
   *  `boxes × rounds × max_fee_per_mix`. */
  rounds: number;
  params: ProtocolParams;
  addresses: LovejoinAddresses;
  /**
   * Fee shard to consume + replenish. Pass `null` (or omit) to build a
   * shard-less bulk deposit — the tx then emits N mix-boxes only and
   * mesh balances against the wallet alone.
   */
  feeShard?: Utxo | null;
  networkId: LovejoinNetworkId;
  minRounds?: number;
}

/**
 * Pure planner for a bulk-deposit tx. Each box i gets its own
 * `a_i = [d_i]·g` and `b_i = [x_i]·a_i`; equal datums are rejected on
 * chain via `try_decode_well_formed_inline`'s a==b check, but bulk
 * callers should already be using distinct (x_i, d_i) per index.
 */
export function planBulkDepositTx(args: PlanBulkDepositArgs): BulkDepositPlan {
  const n = args.ownerSecrets.length;
  if (n < 1) {
    throw new Error("planBulkDepositTx: ownerSecrets must contain at least one secret");
  }
  if (args.rerandomizations !== undefined && args.rerandomizations.length !== n) {
    throw new Error(
      `planBulkDepositTx: rerandomizations length ${args.rerandomizations.length} ≠ ownerSecrets length ${n}`,
    );
  }
  for (const x of args.ownerSecrets) assertOwnerSecret(x);

  const mixBoxAddress = buildScriptAddress(
    args.addresses.mixBoxScriptHash,
    args.networkId,
    args.addresses.dappStakeKeyHashHex ?? null,
  );
  // Fee shards live at the enterprise (unstaked) script address — see
  // planDepositTx for the rationale.
  const feeAddress = buildScriptAddress(
    args.addresses.feeScriptHash,
    args.networkId,
    null,
  );

  const seenDatums = new Set<string>();
  const boxes: BulkDepositBoxPlan[] = [];
  for (let i = 0; i < n; i++) {
    const x = args.ownerSecrets[i]!;
    const d: Scalar | null = args.rerandomizations === undefined
      ? generateRerandomizationScalar()
      : args.rerandomizations[i]!;
    let aPoint;
    let bPoint;
    if (d === null) {
      aPoint = generator();
      bPoint = publicPointG(x);
    } else {
      if (d <= 0n || d >= SCALAR_ORDER) {
        throw new Error(`rerandomization scalar [${i}] must be in [1, r)`);
      }
      aPoint = scalarMul(d, generator());
      bPoint = scalarMul(x, aPoint);
    }
    const a = pointToBytes(aPoint);
    const b = pointToBytes(bPoint);
    const inlineDatumHex = encodeMixDatum({ a, b });
    if (seenDatums.has(inlineDatumHex)) {
      // Two boxes producing identical datums would collide as
      // identical UTxOs in the same tx — practically impossible
      // outside of caller error (reusing the same x AND the same d),
      // but cheap to refuse early.
      throw new Error(
        `planBulkDepositTx: duplicate (a, b) at output ${i}; secrets/rerandomizations must be distinct per box`,
      );
    }
    seenDatums.add(inlineDatumHex);
    boxes.push({
      ownerSecret: x,
      a,
      b,
      output: {
        addressBech32: mixBoxAddress,
        lovelace: args.params.denomLovelace,
        inlineDatumHex,
      },
    });
  }

  if (!Number.isInteger(args.rounds) || args.rounds <= 0) {
    throw new Error(`rounds must be a positive integer, got ${args.rounds}`);
  }
  if (args.minRounds !== undefined && args.rounds < args.minRounds) {
    throw new Error(
      `rounds=${args.rounds} below minRounds=${args.minRounds}; UI should reject`,
    );
  }

  // Shard-less bulk deposit: emit only the N mix-boxes.
  if (!args.feeShard) {
    return {
      boxes,
      feeShardOutput: null,
      feeShardInput: null,
      replenishRedeemerHex: null,
      referenceUtxoRef: parseUtxoRef(args.addresses.referenceUtxoRef),
      feeContractRefScriptUtxoRef: null,
    };
  }

  // Total replenishment: sum across all new boxes. Each box logically
  // funds `rounds` mixes worth of fees; the on-chain rule is just
  // `fee_out > fee_in`, so any positive contribution would satisfy it,
  // but we keep the convention that bulk depositors top up the same
  // per-box share they would have for N single deposits.
  const perBoxContribution = BigInt(args.rounds) * args.params.maxFeePerMixLovelace;
  const replenishedLovelace: Lovelace =
    args.feeShard.lovelace + perBoxContribution * BigInt(n);

  return {
    boxes,
    feeShardOutput: {
      addressBech32: feeAddress,
      lovelace: replenishedLovelace,
      inlineDatumHex: UNIT_DATUM_CBOR_HEX,
    },
    feeShardInput: args.feeShard,
    replenishRedeemerHex: REPLENISH_REDEEMER_CBOR_HEX,
    referenceUtxoRef: parseUtxoRef(args.addresses.referenceUtxoRef),
    feeContractRefScriptUtxoRef: parseUtxoRef(args.addresses.referenceScriptUtxos.fee_contract),
  };
}

export interface BuildBulkDepositArgs {
  network: "preprod" | "preview" | "test" | "mainnet";
  /** Per-box owner secrets in output-position order (positions 0..N-1). */
  ownerSecrets: ReadonlyArray<Scalar>;
  /** Number of mix rounds to fund per new box. */
  rounds: number;
  minRounds?: number;
  wallet: LovejoinWallet;
  provider: ChainProvider;
  addresses: LovejoinAddresses;
  /**
   * Optional pre-picked fee shard. Pass `null` to force a shard-less bulk
   * deposit; pass `undefined` (or omit) to let the SDK pick — and silently
   * fall back to shard-less when no shards exist on chain.
   */
  feeShard?: Utxo | null;
  /**
   * Optional UTxO refs to skip when auto-picking a fee shard. Same
   * semantics as `BuildDepositArgs.excludeFeeShardRefs`.
   */
  excludeFeeShardRefs?: ReadonlyArray<UtxoRef>;
  collateralProvider?: CollateralProvider;
  signOnly?: boolean;
}

export interface BulkDepositResult {
  signedTxHex: string;
  txId: string;
  /** Owner material per output, in output-position order. */
  owners: OwnerSecretMaterial[];
  /** N — the number of mix-boxes created. */
  count: number;
}

/**
 * Build, sign, and (optionally) submit a bulk-deposit tx that mints N
 * fresh mix-box UTxOs from a single fee-shard input.
 *
 * Output order: positions 0..N-1 are the new mix-boxes (in input order
 * of `ownerSecrets`); position N is the replenished fee shard. mesh
 * appends the wallet change after the explicit outputs.
 */
export async function buildBulkDepositTx(
  args: BuildBulkDepositArgs,
): Promise<BulkDepositResult> {
  if (args.ownerSecrets.length === 0) {
    throw new Error("buildBulkDepositTx: ownerSecrets must contain at least one secret");
  }
  const networkId = networkIdFor(args.network);

  const { params } = await fetchProtocolParams(args.addresses, args.provider);
  const feeAddress = buildScriptAddress(
    args.addresses.feeScriptHash,
    networkId,
    null,
  );
  // `undefined` → auto-pick (or null when no shards on chain); `null`
  // → explicit shard-less; a `Utxo` → explicit shard.
  const feeShard = args.feeShard !== undefined
    ? args.feeShard
    : await pickFeeShardOptional({
        provider: args.provider,
        feeScriptAddressBech32: feeAddress,
        ...(args.excludeFeeShardRefs && args.excludeFeeShardRefs.length > 0
          ? { excludeRefs: args.excludeFeeShardRefs }
          : {}),
      });

  const plan = planBulkDepositTx({
    ownerSecrets: args.ownerSecrets,
    rounds: args.rounds,
    params,
    addresses: args.addresses,
    feeShard,
    networkId,
    ...(args.minRounds !== undefined ? { minRounds: args.minRounds } : {}),
  });

  const collateral = args.collateralProvider ?? new WalletProvider(args.wallet);
  const preparedCollateral = await collateral.prepareCollateral({
    provider: args.provider,
    collateralAmountLovelace: 5_000_000n,
  });

  const { MeshTxBuilder } = await import("@meshsdk/core");
  const meshProvider = await getMeshProvider(args.provider);
  const meshParams = await getMeshProtocolParams(args.provider);
  const txBuilder = new MeshTxBuilder({
    fetcher: meshProvider as never,
    submitter: meshProvider as never,
    evaluator: meshProvider as never,
    params: meshParams as never,
    verbose: false,
  });
  // Trust evaluator-returned exec units exactly (mesh defaults to 1.1×).
  txBuilder.txEvaluationMultiplier = 1;

  const walletUtxos = normalizeWalletUtxos(await args.wallet.getUtxos());
  const changeAddress = await args.wallet.getChangeAddress();

  // Reference UTxO is always read; the fee-shard spend is only added when
  // the plan included a shard (otherwise the bulk deposit is mix-boxes-only
  // and the fee_contract isn't invoked).
  txBuilder.readOnlyTxInReference(
    plan.referenceUtxoRef.txId,
    plan.referenceUtxoRef.outputIndex,
  );
  if (
    plan.feeShardInput &&
    plan.feeShardOutput &&
    plan.replenishRedeemerHex &&
    plan.feeContractRefScriptUtxoRef
  ) {
    txBuilder
      .spendingPlutusScriptV3()
      .txIn(
        plan.feeShardInput.ref.txId,
        plan.feeShardInput.ref.outputIndex,
        [{ unit: "lovelace", quantity: plan.feeShardInput.lovelace.toString() }],
        plan.feeShardOutput.addressBech32,
      )
      .txInInlineDatumPresent()
      .txInRedeemerValue(plan.replenishRedeemerHex, "CBOR")
      .spendingTxInReference(
        plan.feeContractRefScriptUtxoRef.txId,
        plan.feeContractRefScriptUtxoRef.outputIndex,
        args.addresses.referenceScriptSizes?.fee_contract?.toString(),
        args.addresses.feeScriptHash,
      );
  }

  // N mix-box outputs at positions 0..N-1.
  for (const box of plan.boxes) {
    txBuilder
      .txOut(box.output.addressBech32, [
        { unit: "lovelace", quantity: box.output.lovelace.toString() },
      ])
      .txOutInlineDatumValue(box.output.inlineDatumHex, "CBOR");
  }
  // Position N (only when replenishing): the topped-up fee shard.
  if (plan.feeShardOutput) {
    txBuilder
      .txOut(plan.feeShardOutput.addressBech32, [
        { unit: "lovelace", quantity: plan.feeShardOutput.lovelace.toString() },
      ])
      .txOutInlineDatumValue(plan.feeShardOutput.inlineDatumHex, "CBOR");
  }
  txBuilder.changeAddress(changeAddress).selectUtxosFrom(walletUtxos);

  for (const utxo of preparedCollateral.inputs) {
    txBuilder.txInCollateral(
      utxo.ref.txId,
      utxo.ref.outputIndex,
      [{ unit: "lovelace", quantity: utxo.lovelace.toString() }],
      utxo.address,
    );
  }
  if (preparedCollateral.requiredSignerPkhHex) {
    txBuilder.requiredSignerHash(preparedCollateral.requiredSignerPkhHex);
  }

  const unsignedTx = await txBuilder.complete();
  const walletSignedTx = await args.wallet.signTx(unsignedTx);
  const signedTx = preparedCollateral.externallySigned
    ? await mergeExternalCollateralWitness(collateral, walletSignedTx)
    : walletSignedTx;
  const owners = plan.boxes.map((box) => deriveOwner(box.ownerSecret, box.a));

  if (args.signOnly) {
    return {
      signedTxHex: signedTx,
      txId: "",
      owners,
      count: plan.boxes.length,
    };
  }

  const txId = await args.provider.submitTx(signedTx);
  return {
    signedTxHex: signedTx,
    txId,
    owners,
    count: plan.boxes.length,
  };
}
