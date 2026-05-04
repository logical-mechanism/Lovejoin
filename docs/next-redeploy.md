# Next-redeploy bundle, queued validator changes

Touching any of `reference_holder`, `one_shot_mint`, `mix_box`, `mix_logic`, or `fee_contract` rotates that validator's script hash, which lives in either the validator's params or the on-chain `ReferenceDatum`. Because `reference_holder` is always-False and the protocol NFT is one-shot, that means **a fresh bootstrap per network**: new reference UTxO, new fee shards, old mix-boxes orphaned. Same irreversibility constraint that gated M4.5.

So we batch validator changes here and only redeploy when the bundle is worth it. Each entry is a queued change with the audit / spec finding it closes, the on-chain shape, the off-chain mirror, and the exit criteria.

The bundle is not a milestone, but it does block on the same shape of work each time:

1. Validator change + Aiken tests.
2. Off-chain mirror in TS (prover, ctx computation, parity vectors).
3. Encoding-parity KAT regen if any byte layout shifted.
4. Stress-test re-calibration on Preprod.
5. Bootstrap on a fresh seed UTxO. Old protocol on the network is left orphaned (its NFT is still at always-False; the new deployment is a parallel hyperstructure).

Document trigger conditions for the redeploy at the end of this file.

---

## Queued changes

### Q-1, F-4: Bind Owner Schnorr ctx to `tx.inputs[].output_reference`

**Source finding:** [docs/audit-2026-05-03.md](audit-2026-05-03.md) F-4.
**Severity:** Medium (griefing, not theft). Funds always reach the user's chosen destination; attacker pays tx fee for no monetary gain. Pre-condition is duplicate `(a, b)` across mix-boxes, which the standard SDK avoids via per-deposit HKDF index + per-deposit re-randomization scalar.

**On-chain change.** [contracts/validators/mix_logic.ak](../contracts/validators/mix_logic.ak) `validate_owner` currently computes:

```aiken
let outputs_bytes = builtin.serialise_data(self.outputs)
let ctx_preimage =
  outputs_bytes |> bytearray.concat(reference_datum.mix_script_hash)
let ctx = builtin.blake2b_256(ctx_preimage)
```

After the fix:

```aiken
let outputs_bytes = builtin.serialise_data(self.outputs)
let input_refs_bytes =
  builtin.serialise_data(
    self.inputs |> list.map(fn (i) { i.output_reference })
  )
let ctx_preimage =
  outputs_bytes
    |> bytearray.concat(input_refs_bytes)
    |> bytearray.concat(reference_datum.mix_script_hash)
let ctx = builtin.blake2b_256(ctx_preimage)
```

Binds to **all** input refs, not just the spending input. Mirrors the Mix branch's "one ctx, N proofs share it" pattern, costs one extra `serialise_data` per validator run, and Cardano's UTxO model already prevents anyone from rebuilding a tx with the same input set (those UTxOs are consumed once). Per-spending-input binding would need N distinct ctxs and more prover bookkeeping for zero extra security under the UTxO model.

**Off-chain mirror.** [offchain/src/tx/withdraw.ts](../offchain/src/tx/withdraw.ts) `computeOwnerCtx` currently does:

```ts
const preimage = new Uint8Array(args.outputsCbor.length + hashBytes.length);
preimage.set(args.outputsCbor, 0);
preimage.set(hashBytes, args.outputsCbor.length);
return blake2b256(preimage);
```

New shape:

```ts
const preimage = new Uint8Array(
  args.outputsCbor.length + args.inputRefsCbor.length + hashBytes.length,
);
preimage.set(args.outputsCbor, 0);
preimage.set(args.inputRefsCbor, args.outputsCbor.length);
preimage.set(hashBytes, args.outputsCbor.length + args.inputRefsCbor.length);
return blake2b256(preimage);
```

The caller (`buildWithdrawTx`) already has the input set in scope at proof construction time (it picks the mix-box plus collateral). Add a `serializeInputRefsForCtx` helper next to `serializeOutputsForCtx` so the byte layout is in one place.

**Encoding-parity vector.** Add a vector to [crypto/test-vectors/encoding-parity.json](../crypto/test-vectors/encoding-parity.json) covering `serialise_data(List<OutputReference>)` over a few representative input shapes (1 input, N inputs, varying tx_id bytes, varying output_index ints). Mirror in [contracts/lib/lovejoin/encoding_parity_kat.test.ak](../contracts/lib/lovejoin/encoding_parity_kat.test.ak) and [offchain/test/crypto/encoding-parity.test.ts](../offchain/test/crypto/encoding-parity.test.ts). This is the build-blocker risk per [docs/spec/12-build-guide.md](spec/12-build-guide.md) §"Risk 1", do not skip.

**Tests.**

- Aiken positive: existing Owner happy-path tests must pass after the ctx layout change (will need to regenerate any KAT that bakes the old ctx).
- Aiken negative regression for F-4: build two mix-boxes with identical `(a, b)`, submit Owner withdraw of box 1 with proof π, then in a separate tx attempt to spend box 2 with π copied verbatim. Today (no fix) passes. After fix, fails.
- Encoding-parity tests over the new input-refs layout.
- TS prover round-trips with the new ctx shape.

**Side effects.**

- Owner-redeemer txs see one extra `serialise_data` call. Negligible CPU cost (input refs are 32 + ~2 bytes per input, list serialize over typically 1, 3 entries).
- Bulk Owner withdraws (`n >= 1`) all get the same ctx, so prover work is unchanged from today's "compute ctx once, sign N times" pattern.

**Exit criteria.**

- [ ] `aiken check` green over the rewritten validator + new negative regression.
- [ ] TS prover regenerated; encoding-parity test green over 1000 vectors.
- [ ] Replay-against-duplicate-(a,b) test added to [contracts/validators/mix_logic.test.ak](../contracts/validators/mix_logic.test.ak) and to a corresponding offchain integration test.

---

## Trigger conditions for the bundle redeploy

Don't redeploy for any single change unless the change is itself a P0/P1. The bundle ships when one of these is true:

1. **A P0/P1 finding** lands that requires a validator change (independent audit, post-mainnet incident, etc).
2. **Two or more mediums** are queued in this file.
3. **`max_tx_ex_units` rises on Cardano** by enough that revisiting the N ceiling makes economic sense (M4.5 was parked on this).
4. **Mainnet bootstrap** (a separate, larger-scope decision, but it would consume the bundle anyway).

When triggered, the redeploy follows [infra/bootstrap/](../infra/bootstrap/) on a fresh seed UTxO, leaving the prior network's reference UTxO orphaned. Coordinate UI cutover via the network config (`network.<net>.json`).

---

## Out of scope for this bundle

- F-3 (`b == identity` not rejected): on-chain fix would only relabel the failure mode (forgery sweep → Rule-2 sweep). SDK guard already covers it. See audit F-3 disposition.
- F-5 (Conway cert matrix tests): no validator change. Landed on the `issue/85` branch as 10 negative tests in [contracts/validators/mix_logic.test.ak](../contracts/validators/mix_logic.test.ak).
- F-19 (property-based tests): no validator change.
- Spec drift §5.1 / §5.2 (`max_n` / `fee_shard_target` removed from `ReferenceDatum`): docs-only reconciliation; the implementation is already consistent.
