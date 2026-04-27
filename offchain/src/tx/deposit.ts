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
  pointToBytes,
  publicPointG,
} from "../crypto/index.js";
import { Encoder, Tag } from "cbor-x";

import type { ChainProvider, Lovelace, Utxo, UtxoRef } from "../chain/provider.js";
import {
  type CollateralProvider,
  WalletProvider,
} from "./collateral.js";
import { getMeshProvider } from "./mesh-bridge.js";
import {
  pickRandomFeeShard,
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
  /** Replenished fee shard output (position 1 in the tx). */
  feeShardOutput: {
    addressBech32: string;
    lovelace: Lovelace;
    /** Plutus-Data CBOR hex of `()` (Constr 0 []). */
    inlineDatumHex: string;
  };
  /** The fee shard being consumed. */
  feeShardInput: Utxo;
  /** Plutus-Data CBOR hex of the `Replenish` redeemer (Constr 1 []). */
  replenishRedeemerHex: string;
  /** Reference UTxO (read-only via tx.reference_inputs). */
  referenceUtxoRef: UtxoRef;
  /** CIP-33 reference-script UTxO for the fee_contract validator. */
  feeContractRefScriptUtxoRef: UtxoRef;
}

/** Owner secret + a label for the SDK to surface to the UI / CLI. */
export interface OwnerSecretMaterial {
  /** 32-byte big-endian scalar `x` in `[1, r)`. */
  secret: Scalar;
  /** Lowercase 64-char hex of `secret`. */
  secretHex: string;
  /** Public point `b = [x]·g` as 48-byte compressed hex (= the `b` field). */
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

/** CBOR hex for `Constr 0 []` used as a placeholder PayMixFee redeemer. */
export const PAY_MIX_FEE_REDEEMER_CBOR_HEX = "d87980";

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

/** Build the public material that pairs with an owner secret. */
export function deriveOwner(secret: Scalar): OwnerSecretMaterial {
  assertOwnerSecret(secret);
  const b = pointToBytes(publicPointG(secret));
  const secretHex = scalarToHex(secret);
  const publicPointHex = bytesToHex(b);
  return {
    secret,
    secretHex,
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
  /** Number of mix rounds the user wants to fund — drives the fee top-up. */
  rounds: number;
  /** Lovejoin protocol parameters from the reference UTxO. */
  params: ProtocolParams;
  /** Bootstrap addresses.json — provides script hashes + reference UTxO. */
  addresses: LovejoinAddresses;
  /** Fee shard the SDK has chosen to consume. */
  feeShard: Utxo;
  /** Network discriminator for bech32 address construction. */
  networkId: LovejoinNetworkId;
  /** Optional minimum rounds (for UI parity); throws if `rounds` is below. */
  minRounds?: number;
}

export function planDepositTx(args: PlanDepositArgs): DepositPlan {
  const ownerSecret = args.ownerSecret ?? generateOwnerSecret();
  assertOwnerSecret(ownerSecret);

  // (a, b) for the new mix-box — `a = g`, `b = [x]·g`.
  const a = pointToBytes(generator());
  const b = pointToBytes(publicPointG(ownerSecret));

  const mixBoxAddress = buildScriptAddress(
    args.addresses.mixBoxScriptHash,
    args.networkId,
    args.addresses.dappStakeKeyHashHex ?? null,
  );
  const feeAddress = buildScriptAddress(
    args.addresses.feeScriptHash,
    args.networkId,
    args.addresses.dappStakeKeyHashHex ?? null,
  );

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
  /** Optional pre-picked fee shard (otherwise the SDK picks uniformly). */
  feeShard?: Utxo;
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
 * Output ordering is fixed: position 0 is the new mix-box, position 1 is
 * the replenished fee shard. mesh handles fee + change.
 */
export async function buildDepositTx(args: BuildDepositArgs): Promise<DepositResult> {
  const networkId = networkIdFor(args.network);

  const { params } = await fetchProtocolParams(args.addresses, args.provider);
  const feeAddress = buildScriptAddress(
    args.addresses.feeScriptHash,
    networkId,
    args.addresses.dappStakeKeyHashHex ?? null,
  );
  const feeShard = args.feeShard ?? (await pickRandomFeeShard({
    provider: args.provider,
    feeScriptAddressBech32: feeAddress,
  }));

  const plan = planDepositTx({
    ...(args.ownerSecret !== undefined ? { ownerSecret: args.ownerSecret } : {}),
    rounds: args.rounds,
    params,
    addresses: args.addresses,
    feeShard,
    networkId,
    ...(args.minRounds !== undefined ? { minRounds: args.minRounds } : {}),
  });

  // Wallet collateral. Mix uses GivemeMyProvider per spec; deposit + withdraw
  // use the wallet's own collateral. Either way the CollateralProvider
  // interface returns the same shape.
  const collateral = args.collateralProvider ?? new WalletProvider(args.wallet);
  // Eight bytes is enough placeholder for a digest — deposit doesn't use the
  // digest because WalletProvider ignores it. M4's Mix tx will compute a
  // real one before calling.
  const collateralProvision = await collateral.requestCollateral({
    txBodyDigest: new Uint8Array(32),
    collateralAmountLovelace: 5_000_000n,
  });

  // Lazily import mesh classes to avoid loading libsodium on test paths
  // that don't exercise this function. See wallet/cip30.ts for context.
  const { MeshTxBuilder } = await import("@meshsdk/core");

  // mesh's tx builder needs a real `IFetcher` / `ISubmitter` (with
  // `fetchUTxOs`, `fetchProtocolParameters`, ...) — our `ChainProvider`
  // doesn't satisfy that surface. The provider exposes a lazy mesh
  // sibling via `.meshProvider()` that's the same Blockfrost data, but
  // shaped for mesh.
  const meshProvider = await getMeshProvider(args.provider);
  const txBuilder = new MeshTxBuilder({
    fetcher: meshProvider as never,
    submitter: meshProvider as never,
    verbose: false,
  });

  // Wallet inputs (mesh handles selection).
  const walletUtxos = normalizeWalletUtxos(await args.wallet.getUtxos());
  const changeAddress = await args.wallet.getChangeAddress();

  // Build the tx body.
  const tx = txBuilder
    // Reference UTxO read by mix_logic / fee_contract for ProtocolParams.
    .readOnlyTxInReference(plan.referenceUtxoRef.txId, plan.referenceUtxoRef.outputIndex)
    // Spend the fee shard with Replenish.
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
    )
    // Output 0: new mix-box.
    .txOut(plan.mixBoxOutput.addressBech32, [
      { unit: "lovelace", quantity: plan.mixBoxOutput.lovelace.toString() },
    ])
    .txOutInlineDatumValue(plan.mixBoxOutput.inlineDatumHex, "CBOR")
    // Output 1: replenished fee shard.
    .txOut(plan.feeShardOutput.addressBech32, [
      { unit: "lovelace", quantity: plan.feeShardOutput.lovelace.toString() },
    ])
    .txOutInlineDatumValue(plan.feeShardOutput.inlineDatumHex, "CBOR")
    .changeAddress(changeAddress)
    .selectUtxosFrom(walletUtxos);

  // Wallet collateral: mesh's API takes (txHash, idx, amount?, address?).
  for (const utxo of collateralProvision.inputs) {
    tx.txInCollateral(
      utxo.ref.txId,
      utxo.ref.outputIndex,
      [{ unit: "lovelace", quantity: utxo.lovelace.toString() }],
      utxo.address,
    );
  }

  const unsignedTx = await tx.complete();
  const signedTx = await args.wallet.signTx(unsignedTx);
  const owner = deriveOwner(plan.ownerSecret);

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
