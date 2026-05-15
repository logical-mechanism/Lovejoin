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

import type { ChainProvider, Hex32, Lovelace, Utxo } from "../chain/provider.js";
import { SCALAR_ORDER, type Scalar } from "../crypto/bls.js";
import {
  decodeRegisterDatum,
  encodeRegisterDatum,
  rerandomizeRegister,
  type SeedelfRegister,
} from "./register.js";
import { seedelfWalletAddressBech32, type SeedelfAddresses } from "./addresses.js";
import { isSeedelfAssetName } from "./token.js";
import { drawRerandomizationScalar } from "./rng.js";
import type { LovejoinWallet } from "../wallet/cip30.js";
import { getMeshProtocolParams, getMeshProvider } from "../tx/mesh-bridge.js";

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

// ---------------------------------------------------------------------------
// sendToSeedelfTx — drives mesh
// ---------------------------------------------------------------------------

/** An optional native token to ship alongside ADA in the send-to-seedelf output. */
export interface SeedelfSendAsset {
  /** mesh's unit format: `<28-byte policy id hex><asset name hex>` (no separator). */
  unit: string;
  /** Quantity as a non-negative bigint. */
  quantity: bigint;
}

export interface BuildSeedelfSendArgs {
  network: "preprod" | "preview" | "test" | "mainnet";
  addresses: SeedelfAddresses;
  provider: ChainProvider;
  /** Wallet that funds the send. */
  wallet: LovejoinWallet;
  /**
   * Recipient's register. Resolve from the recipient's `seedelf id` (locator
   * NFT asset name) by reading the UTxO at the wallet contract that carries
   * it, then decoding its inline datum. Helper {@link resolveRecipientRegister}
   * does this lookup against an arbitrary `ChainProvider`.
   */
  recipientRegister: SeedelfRegister;
  /** ADA (in lovelace) to send. MUST cover the wallet-contract min-UTxO. */
  lovelace: Lovelace;
  /** Optional native assets to ship into the recipient's stealth balance. */
  assets?: ReadonlyArray<SeedelfSendAsset>;
  /** Optional fresh re-randomization scalar; auto-drawn when omitted. */
  rerandomizeScalar?: Scalar;
  /** If true, sign but don't submit. */
  signOnly?: boolean;
}

export interface SeedelfSendResult {
  signedTxHex: string;
  /** Tx id; empty when `signOnly` skipped submission. */
  txId: Hex32;
  plan: SeedelfSendPlan;
}

/**
 * Build, sign, and (optionally) submit a Send-to-Seedelf tx. Plain
 * wallet-paid payment: no script runs on chain, no collateral provider,
 * no reference input. The recipient's register is re-randomized into a
 * fresh inline datum and the output sits at the wallet contract address.
 */
export async function sendToSeedelfTx(args: BuildSeedelfSendArgs): Promise<SeedelfSendResult> {
  const plan = planSeedelfSendTx({
    addresses: args.addresses,
    recipientRegister: args.recipientRegister,
    rerandomizeScalar: args.rerandomizeScalar ?? drawRerandomizationScalar(),
    lovelace: args.lovelace,
  });

  const meshCore = await import("@meshsdk/core");
  const { MeshTxBuilder } = meshCore;
  const meshProvider = await getMeshProvider(args.provider);
  const meshParams = await getMeshProtocolParams(args.provider);

  const tx = new MeshTxBuilder({
    fetcher: meshProvider as never,
    submitter: meshProvider as never,
    evaluator: meshProvider as never,
    params: meshParams as never,
    verbose: false,
  });
  tx.txEvaluationMultiplier = 1;

  const outputAmount: Array<{ unit: string; quantity: string }> = [
    { unit: "lovelace", quantity: plan.outputLovelace.toString() },
  ];
  if (args.assets) {
    for (const a of args.assets) {
      if (a.quantity <= 0n) {
        throw new Error(`Seedelf send: asset ${a.unit} must have positive quantity`);
      }
      outputAmount.push({ unit: a.unit, quantity: a.quantity.toString() });
    }
  }

  tx.txOut(plan.outputAddressBech32, outputAmount).txOutInlineDatumValue(
    plan.inlineDatumHex,
    "CBOR",
  );

  const changeAddress = await args.wallet.getChangeAddress();
  const walletUtxos = await args.wallet.getUtxos();
  tx.changeAddress(changeAddress).selectUtxosFrom((walletUtxos ?? []) as never);

  const unsignedTx = await tx.complete();
  const signedTx = await args.wallet.signTx(unsignedTx);
  if (args.signOnly) {
    return { signedTxHex: signedTx, txId: "", plan };
  }
  const txId = await args.provider.submitTx(signedTx);
  return { signedTxHex: signedTx, txId, plan };
}

/**
 * Look up a recipient's register by their seedelf id (locator NFT asset
 * name, 32-byte hex). Walks the wallet-contract address, finds the UTxO
 * carrying that token, decodes its inline datum.
 *
 * Returns `null` if no UTxO at the wallet contract carries the seedelf id
 * (recipient hasn't minted, or supplied an invalid id).
 */
export async function resolveRecipientRegister(args: {
  provider: ChainProvider;
  addresses: SeedelfAddresses;
  /** Recipient's seedelf id — 32-byte hex asset name. */
  seedelfIdHex: string;
}): Promise<{ register: SeedelfRegister; utxo: Utxo } | null> {
  const lower = args.seedelfIdHex.toLowerCase();
  if (!isSeedelfAssetName(lower)) {
    throw new Error(
      `Seedelf send: seedelfIdHex must be a 32-byte 5eed0e1f-prefixed asset name, got "${args.seedelfIdHex}"`,
    );
  }
  const policyAndName = `${args.addresses.seedelfPolicyId}${lower}`;
  const wcAddress = seedelfWalletAddressBech32(args.addresses);
  const utxos = await args.provider.getUtxos(wcAddress);
  for (const u of utxos) {
    if (!u.inlineDatum) continue;
    if (
      !(policyAndName in u.assets) &&
      !(`${args.addresses.seedelfPolicyId.toLowerCase()}${lower}` in u.assets)
    ) {
      // Tolerate case differences in policy hex from various providers.
      continue;
    }
    const register = decodeRegisterDatum(u.inlineDatum);
    if (register) return { register, utxo: u };
  }
  return null;
}
