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

/**
 * Approximate CBOR-encoded size of a single vkey witness (the chain
 * pad-fills required signers + wallet/collateral signatures with this
 * shape):
 *
 *   VkeyWitness = [bytes(32), bytes(64)]
 *                = 1 (array header) + 2 (bytes(32) header) + 32 + 2 + 64
 *                = 101 bytes
 *
 * mesh-csl's min-fee path counts these against `tx_size` even when the
 * unsigned tx hasn't yet had the witnesses appended. We mirror that so
 * `computeMinTxFee` matches mesh-csl's own min-fee number.
 */
export const VKEY_WITNESS_BYTES_APPROX = 101;

/**
 * Compute Cardano's minimum required tx fee from the four components
 * the chain checks at submission time:
 *
 *   * size_fee = a * (txSize + expectedVkeyWitnesses * 101) + b
 *   * step_fee = ceil(steps * priceStep)
 *   * mem_fee  = ceil(mem * priceMem)
 *   * ref_script_fee (Conway tier formula — see {@link computeRefScriptFee}).
 *
 * `expectedVkeyWitnesses` covers required signers + collateral signers
 * + wallet-input signers that the unsigned-tx CBOR doesn't carry yet
 * but the chain (and mesh-csl's own min-fee check) will charge for.
 * Passing 0 means "the tx is already fully witnessed in `txCborHex`."
 *
 * Use this when the SDK has to set a tx fee MANUALLY rather than letting
 * mesh's auto-fee path handle it. The two cases in Lovejoin are:
 *
 *   1. Mix shard mode — the validator pins `fee_in - fee_out == tx.fee`,
 *      which in turn pins the fee value directly (no wallet change to
 *      absorb slack), so mesh has no degree of freedom and we must pick
 *      a number ourselves.
 *   2. Withdraw box mode — same pattern; the single change-to-destination
 *      output absorbs the chosen fee.
 *
 * `txCborHex` is the body+witness CBOR (mesh's `tx.complete()` output). The
 * caller is responsible for passing a CBOR whose body size is a faithful
 * proxy for the post-fee-correction body — in practice fee values within
 * the same CBOR-uint-length tier (e.g. 65,536 ≤ fee < 4,294,967,296 → 5
 * bytes encoding) produce identical body sizes.
 */
export function computeMinTxFee(args: {
  txCborHex: string;
  totalExUnits: { mem: bigint; steps: bigint };
  refScriptBytes: number;
  expectedVkeyWitnesses?: number;
  params: {
    minFeeA: number;
    minFeeB: number;
    priceStep: number;
    priceMem: number;
    minFeeRefScriptCostPerByte: number;
  };
}): bigint {
  const witnessPad = BigInt(
    (args.expectedVkeyWitnesses ?? 0) * VKEY_WITNESS_BYTES_APPROX,
  );
  const txSize = BigInt(args.txCborHex.length / 2) + witnessPad;
  const sizeFee =
    BigInt(args.params.minFeeA) * txSize + BigInt(args.params.minFeeB);
  const stepFee = BigInt(
    Math.ceil(Number(args.totalExUnits.steps) * args.params.priceStep),
  );
  const memFee = BigInt(
    Math.ceil(Number(args.totalExUnits.mem) * args.params.priceMem),
  );
  const refFee = computeRefScriptFee(
    args.refScriptBytes,
    args.params.minFeeRefScriptCostPerByte,
  );
  return sizeFee + stepFee + memFee + refFee;
}

/**
 * Sum per-redeemer exec units returned from a mesh-shaped evaluator
 * (`{tag, index, budget: {mem, steps}}[]` — see
 * `BlockfrostProvider.meshProvider().evaluateTx` in `chain/blockfrost.ts`
 * for the shape). The result is what {@link computeMinTxFee} expects in
 * `totalExUnits`.
 */
export function sumEvaluatorExUnits(
  evaluatorOutput: ReadonlyArray<{
    budget?: { mem?: number; steps?: number };
  }>,
): { mem: bigint; steps: bigint } {
  let mem = 0n;
  let steps = 0n;
  for (const e of evaluatorOutput) {
    const b = e.budget;
    if (!b) continue;
    if (typeof b.mem === "number") mem += BigInt(b.mem);
    if (typeof b.steps === "number") steps += BigInt(b.steps);
  }
  return { mem, steps };
}
