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

import type { ChainProvider, Hex32, Lovelace, UtxoRef } from "../chain/provider.js";
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
import { buildSeedelfTokenName, pickSmallestInputRef, SEEDELF_TOKEN_PREFIX_HEX } from "./token.js";
import { encodeMintRedeemer } from "./redeemer.js";
import type { SeedelfAddresses } from "./addresses.js";
import { seedelfWalletAddressBech32 } from "./addresses.js";
import type { LovejoinWallet } from "../wallet/cip30.js";
import { meshUtxoToLovejoin, normalizeWalletUtxos } from "../wallet/cip30.js";
import { getMeshProtocolParams, getMeshProvider } from "../tx/mesh-bridge.js";
import { drawRerandomizationScalar } from "./rng.js";

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

// ---------------------------------------------------------------------------
// mintSeedelfTx — drives mesh
// ---------------------------------------------------------------------------

/** Inputs to the mesh-driven Seedelf mint tx builder. */
export interface BuildSeedelfMintArgs {
  /** Active network — used for nothing here but kept for symmetry with the other builders. */
  network: "preprod" | "preview" | "test" | "mainnet";
  /** Seedelf protocol addresses on the active network. */
  addresses: SeedelfAddresses;
  /** Chain provider (mesh sibling drives the build). */
  provider: ChainProvider;
  /** Connected wallet — pays the mint output, signs the tx. */
  wallet: LovejoinWallet;
  /** Owner secret `x` that controls the freshly-minted register. */
  ownerSecret: Scalar;
  /**
   * Optional fresh re-randomization scalar `d`. Auto-drawn from a CSPRNG
   * when omitted. Tests pass an explicit value for reproducibility.
   */
  rerandomizeScalar?: Scalar;
  /** Optional UTF-8 personal tag (≤ 15 bytes). */
  personalTag?: string | Uint8Array;
  /** Lovelace pinned to the mint output. Defaults to {@link SEEDELF_MINT_DEFAULT_LOVELACE}. */
  outputLovelace?: Lovelace;
  /** If true, sign but don't submit. */
  signOnly?: boolean;
}

export interface SeedelfMintResult {
  signedTxHex: string;
  /** Tx id; empty when `signOnly` skipped submission. */
  txId: Hex32;
  /** The plan the tx was built from. */
  plan: SeedelfMintPlan;
}

/**
 * Build, sign, and (optionally) submit a Seedelf mint tx.
 *
 * Wallet-paid + wallet-signed: the user's CIP-30 wallet covers the mint
 * output's min-UTxO ADA, the tx fee, and signs the body. No external
 * collateral provider is needed (the wallet is already in the tx). The
 * seedelf mint validator's `reference_input` is the mint reference
 * UTxO; the redeemer is `BoundedBytes(personal_tag)`.
 *
 * The validator computes the canonical token name from
 * `tx.inputs[0].output_reference` (the lex-smallest input) and the
 * redeemer's personal_tag. We pick the lex-smallest wallet UTxO before
 * planning so the planner's token-name matches what the validator will
 * see — and we pass that ref into `selectUtxosFrom` to force mesh to
 * include it (the ledger lex-sorts after selection, so as long as the
 * UTxO is in `tx.inputs` it becomes the smallest).
 */
export async function mintSeedelfTx(args: BuildSeedelfMintArgs): Promise<SeedelfMintResult> {
  const walletRaw = await args.wallet.getUtxos();
  const walletMesh = normalizeWalletUtxos(walletRaw);
  if (walletMesh.length === 0) {
    throw new Error("Seedelf mint: wallet has no spendable UTxOs to fund the mint output");
  }
  const walletUtxos = walletMesh.map(meshUtxoToLovejoin);
  const smallestRef = pickSmallestInputRef(walletUtxos.map((u) => u.ref));

  const plan = planSeedelfMintTx({
    addresses: args.addresses,
    smallestInputRef: smallestRef,
    ownerSecret: args.ownerSecret,
    rerandomizeScalar: args.rerandomizeScalar ?? drawRerandomizationScalar(),
    ...(args.personalTag !== undefined ? { personalTag: args.personalTag } : {}),
    outputLovelace: args.outputLovelace ?? SEEDELF_MINT_DEFAULT_LOVELACE,
  });

  // Cross-check: the planned register must round-trip with the supplied secret.
  if (!verifyMintRegister(plan, args.ownerSecret)) {
    throw new Error("Seedelf mint: planned register does not round-trip with ownerSecret");
  }

  const meshCore = await import("@meshsdk/core");
  const { MeshTxBuilder } = meshCore;
  const meshProvider = await getMeshProvider(args.provider);
  const meshParams = await getMeshProtocolParams(args.provider);

  const changeAddress = await args.wallet.getChangeAddress();
  const tx = new MeshTxBuilder({
    fetcher: meshProvider as never,
    submitter: meshProvider as never,
    evaluator: meshProvider as never,
    params: meshParams as never,
    verbose: false,
  });
  // Trust evaluator-returned exec units exactly (mesh defaults to 1.1×).
  tx.txEvaluationMultiplier = 1;

  // NOTE: the mint validator's reference script lives at
  // `plan.mintReferenceUtxoRef`. We attach it via `mintTxInReference`
  // below, which doubles as the read-only reference declaration. Calling
  // `readOnlyTxInReference` on the SAME UTxO before that would register
  // it twice with different scriptSize values (undefined vs the real
  // size), tripping mesh-csl's "Different script sizes for the same ref
  // input <ref>" rejection.

  // Wallet inputs — let mesh select, but pin the lex-smallest ref so the
  // validator's expected token name matches the plan. mesh's `txIn` adds
  // it explicitly and `selectUtxosFrom(rest)` covers the rest of the fee.
  const smallestUtxo = walletUtxos.find(
    (u) => u.ref.txId === smallestRef.txId && u.ref.outputIndex === smallestRef.outputIndex,
  )!;
  tx.txIn(
    smallestUtxo.ref.txId,
    smallestUtxo.ref.outputIndex,
    [{ unit: "lovelace", quantity: smallestUtxo.lovelace.toString() }],
    smallestUtxo.address,
  );

  // Mint output: 1 × Seedelf NFT at the wallet contract with the register
  // as inline datum.
  const policyAndName = `${plan.mintPolicyIdHex}${plan.assetNameHex}`;
  tx.mintPlutusScriptV3()
    .mint("1", plan.mintPolicyIdHex, plan.assetNameHex)
    .mintTxInReference(
      plan.mintReferenceUtxoRef.txId,
      plan.mintReferenceUtxoRef.outputIndex,
      args.addresses.seedelfReferenceScriptSize?.toString(),
      plan.mintPolicyIdHex,
    )
    .mintRedeemerValue(plan.mintRedeemerCborHex, "CBOR");

  tx.txOut(plan.mintOutputAddressBech32, [
    { unit: "lovelace", quantity: plan.mintOutputLovelace.toString() },
    { unit: policyAndName, quantity: "1" },
  ]).txOutInlineDatumValue(plan.inlineDatumHex, "CBOR");

  // Wallet collateral (wallet's own).
  const collateralCandidates = await args.wallet.getCollateral();
  const collateralMesh = normalizeWalletUtxos(collateralCandidates);
  if (collateralMesh.length === 0) {
    throw new Error(
      "Seedelf mint: wallet exposes no collateral UTxOs. Set up a collateral UTxO in wallet settings and retry.",
    );
  }
  for (const m of collateralMesh) {
    tx.txInCollateral(m.input.txHash, m.input.outputIndex, m.output.amount, m.output.address);
  }

  // Coin selection draws from the remaining wallet UTxOs (the smallest
  // ref is already pinned explicitly above; selectUtxosFrom adds more if
  // needed to cover fee + min-UTxO).
  const restWalletMesh = walletMesh.filter(
    (m) =>
      !(m.input.txHash === smallestRef.txId && m.input.outputIndex === smallestRef.outputIndex),
  );
  tx.changeAddress(changeAddress).selectUtxosFrom(restWalletMesh);

  const unsignedTx = await tx.complete();
  const signedTx = await args.wallet.signTx(unsignedTx);
  if (args.signOnly) {
    return { signedTxHex: signedTx, txId: "", plan };
  }
  const txId = await args.provider.submitTx(signedTx);
  return { signedTxHex: signedTx, txId, plan };
}
