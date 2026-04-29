// Conway-era fee math that mesh-csl @1.8.14 doesn't implement.
//
// Specifically: mesh's CSL serializer never calls
// `set_ref_script_coins_per_byte` on the underlying rust builder, so
// `min_ref_script_fee` is computed as 0 and the resulting tx fee
// under-pays the chain by `total_ref_script_bytes ×
// min_fee_ref_script_cost_per_byte`. Symptom is `FeeTooSmallUTxO`.
//
// Workaround: compute the correction ourselves, pin the total via
// `tx.setFee(...)` on a re-build pass, and let mesh balance the rest
// (in withdraw "box" mode this is a single change-to-destination
// output, so the destination shrinks by exactly the missing fee).

/**
 * Extract the `fee` field (body key 2) from a completed tx CBOR via
 * mesh's CST. We deliberately don't roll a bespoke CBOR parser — CST
 * already knows the body shape and gives us a typed lovelace value.
 */
export function extractFeeFromTxCbor(
  txCborHex: string,
  cst: typeof import("@meshsdk/core-cst"),
): bigint {
  const tx = cst.deserializeTx(txCborHex);
  const fee = tx.body().fee();
  return BigInt(fee);
}

/**
 * Conway reference-script fee for a tx that consumes `totalRefBytes` of
 * UNIQUE reference scripts. Implements the tiered-pricing formula from
 * the Conway spec:
 *
 *   for size ≤ stride:                  size * b_min
 *   for size in (stride, 2·stride]:     stride*b_min + (size-stride) * b_min * mult
 *   ...
 *
 * Defaults match mainnet / preprod (stride = 25_600, multiplier = 1.2).
 *
 * The result is rounded UP — Conway's actual formula uses floor, so this
 * may over-pay by ≤ 1 lovelace per tier. The chain accepts higher fees,
 * so over-paying is safe and we keep the off-chain math simple.
 *
 * Even with the exact formula we may under- or over-shoot the chain by a
 * small amount (mesh's fee math has its own off-by-N quirks). Callers
 * can pad the result with a small safety margin if they want a single
 * submit attempt to always succeed; we don't pad here so the cost is
 * visible to the caller.
 */
export function computeRefScriptFee(
  totalRefBytes: number,
  costPerByte: number,
  stride = 25_600,
  multiplier = 1.2,
): bigint {
  if (totalRefBytes <= 0 || costPerByte <= 0) return 0n;
  let remaining = totalRefBytes;
  let pricePerByte = costPerByte;
  let acc = 0;
  while (remaining > 0) {
    const chunk = Math.min(remaining, stride);
    acc += Math.ceil(chunk * pricePerByte);
    remaining -= chunk;
    pricePerByte *= multiplier;
  }
  return BigInt(acc);
}
