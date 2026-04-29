// Append an externally-supplied vkey witness to a completed tx CBOR.
//
// Use case: a Collateral-Provider host signs over the tx body's hash and
// returns a `VkeyWitness`. The user's wallet has already signed (or skipped
// signing — Mix txs are wallet-anonymous). We need to merge the external
// witness into the existing `transaction_witness_set.vkey_witnesses` and
// produce a valid tx for `provider.submitTx`.
//
// We use mesh's CST library because it already handles the
// re-serialisation rules (canonical OrderedSet ordering for body fields,
// witness-set CBOR layout) that the cardano-cli would otherwise enforce.
// Hand-rolling the CBOR splice would be ~25 lines but extremely fragile —
// the witness set has 11 different fields, and miswriting any of them
// produces a tx that the ledger silently rejects with no useful error.

import type {
  CollateralProvider,
  VkeyWitness as ExternalVkeyWitness,
} from "./collateral.js";

/**
 * Lazy import of `@meshsdk/core-cst` — same pattern as `tx/withdraw.ts`,
 * matches the libsodium-late-load convention recorded in
 * `project_ui_bundler_pitfalls.md`.
 */
type CstModule = typeof import("@meshsdk/core-cst");

/**
 * Append `extra` to the `vkey_witnesses` list of `txCborHex` and return the
 * re-serialised tx CBOR.
 *
 * Idempotent against the same vkey — if `extra.vkey` is already present in
 * the witness set, we leave the witness set alone and return the input
 * unchanged. (A doubled vkey witness is technically valid but wastes bytes
 * and surprises some indexers; idempotency keeps two-pass build flows
 * clean.)
 */
export async function appendVkeyWitness(
  txCborHex: string,
  extra: ExternalVkeyWitness,
): Promise<string> {
  const cst = (await import("@meshsdk/core-cst")) as CstModule;
  return appendVkeyWitnessSync(txCborHex, extra, cst);
}

/**
 * Same as {@link appendVkeyWitness} but takes a pre-loaded CST module.
 * Used by tx builders that already have CST in scope to avoid a second
 * dynamic import.
 */
export function appendVkeyWitnessSync(
  txCborHex: string,
  extra: ExternalVkeyWitness,
  cst: CstModule,
): string {
  const tx = cst.deserializeTx(txCborHex);
  const witnessSet = tx.witnessSet();
  const existing = witnessSet.vkeys();
  const existingValues = existing ? [...existing.values()] : [];

  // De-dupe by vkey hex — see top-of-file note on idempotency.
  const newVkeyLower = extra.vkeyHex.toLowerCase();
  for (const w of existingValues) {
    if (w.vkey().toString().toLowerCase() === newVkeyLower) {
      return txCborHex;
    }
  }

  const incoming = new cst.VkeyWitness(
    cst.Ed25519PublicKeyHex(newVkeyLower),
    cst.Ed25519SignatureHex(extra.signatureHex.toLowerCase()),
  );
  const merged = [...existingValues, incoming];
  witnessSet.setVkeys(
    cst.CborSet.fromCore(
      merged.map((vkw) => vkw.toCore()),
      cst.VkeyWitness.fromCore,
    ),
  );
  tx.setWitnessSet(witnessSet);
  return tx.toCbor();
}

/**
 * Convenience wrapper used by deposit / withdraw / bulk-withdraw / mix:
 * call `provider.signTxBody(tx)`, then merge the returned witness. Throws
 * if the provider claims to be externally-signed but returns null.
 */
export async function mergeExternalCollateralWitness(
  provider: CollateralProvider,
  txCborHex: string,
): Promise<string> {
  const witness = await provider.signTxBody(txCborHex);
  if (!witness) {
    throw new Error(
      "mergeExternalCollateralWitness: provider returned null for an externally-signed " +
        "collateral. Did the provider's prepareCollateral() set externallySigned correctly?",
    );
  }
  return appendVkeyWitness(txCborHex, witness);
}
