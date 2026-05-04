# Next-redeploy bundle, queued validator changes

**Tracking issue:** [#90](https://github.com/logical-mechanism/Lovejoin/issues/90). Implementation lands on its own branch off `main` when the trigger conditions at the bottom of this file fire.

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

### Q-2, F-17: Bake the canonical NFT asset name into `one_shot_mint`

**Source finding:** [docs/audit-2026-05-03.md](audit-2026-05-03.md) F-17.
**Severity:** Informational. Not a security defect: the policy is one-shot regardless of which name fires it. The risk is operational. A typo at bootstrap (`"lovejon"` instead of `"lovejoin"`) would mint the protocol NFT under the wrong name, the rest of the bootstrap derives addresses from `(policy, name)`, and there's no recovery short of throwing the deployment away and starting over on a new seed.

**On-chain change.** [contracts/validators/one_shot_mint.ak](../contracts/validators/one_shot_mint.ak) currently checks "exactly one token under this policy at quantity 1" without constraining the name. Bake the literal `"lovejoin"` (hex `6c6f76656a6f696e`) into the validator so the only valid mint is the canonical pair.

```aiken
validator one_shot_mint(seed_tx_id: TransactionId, seed_idx: Int) {
  mint(_redeemer: Data, policy_id: assets.PolicyId, self: Transaction) {
    let seed =
      OutputReference { transaction_id: seed_tx_id, output_index: seed_idx }
    let seed_consumed =
      self.inputs |> list.any(fn(i) { i.output_reference == seed })

    let tokens_under_policy = assets.tokens(self.mint, policy_id)
    expect [Pair(asset_name, quantity)] =
      tokens_under_policy |> dict.to_pairs

    and {
      seed_consumed,
      asset_name == #"6c6f76656a6f696e",
      quantity == 1,
    }
  }

  else(_) {
    fail
  }
}
```

The pattern-match on `[Pair(_, _)]` already enforces `dict.size == 1`, so the explicit size check folds away.

**Off-chain mirror.** None required at the validator level. [infra/bootstrap/00-build-reference.sh:59](../infra/bootstrap/00-build-reference.sh#L59) already defaults `REF_NFT_ASSET_NAME=6c6f76656a6f696e`; with the literal baked in the env-var override is dead code, but leaving the variable in place doesn't hurt (the validator will reject any other value). Worth pruning the env-var read on the same pass for cleanliness.

**Encoding parity.** No FS preimage touched, no on-chain datum touched. No new parity vectors needed. Bake-in changes the compiled UPLC of `one_shot_mint`, which changes the policy id, but every other validator already takes the policy id as a runtime parameter from `addresses.json`. So downstream validators just see a different `(policy_id, asset_name)` pair after bootstrap, with nothing else to migrate.

**Tests.**

- Positive: mint with `asset_name = #"6c6f76656a6f696e"` and quantity 1, seed consumed. Must pass.
- Negative: mint under `asset_name = #"6c6f76656a6f6e"` (the "lovejon" typo) with everything else right. Must fail.
- Negative: mint with the canonical name but quantity 2. Must fail (already covered, retain).
- Negative: mint with the canonical name but seed unconsumed. Must fail (already covered, retain).

**Side effects.**

- Policy id changes (compiled UPLC differs). Same constraint as every other validator change in this bundle.
- Operators of forked deployments lose the freedom to pick a different asset name. That freedom was theoretical anyway: Lovejoin's identity is `(policy, name)` baked into spec, UI, and indexer; any fork using a different name is already running a different protocol.

**Exit criteria.**

- [ ] `aiken check` green over the rewritten validator + new positive / negative tests.
- [ ] [infra/bootstrap/00-build-reference.sh](../infra/bootstrap/00-build-reference.sh) sweeps the now-redundant `REF_NFT_ASSET_NAME` override (or leaves it documented as a cross-check).
- [ ] [contracts/validators/one_shot_mint.test.ak](../contracts/validators/one_shot_mint.test.ak) carries a `mint_rejects_wrong_asset_name` test on top of the existing positive / quantity / seed tests.

---

### Q-3, F-19: Property-based tests via `aiken-lang/fuzz`

**Source finding:** [docs/audit-2026-05-03.md](audit-2026-05-03.md) F-19.
**Severity:** Informational. Tests-only; no validator change. **Does NOT gate on a bundle redeploy.** Q-3 can land any time. It's tracked here so the work sits alongside the validator changes it complements (one CI green button, one PR shape).

**Why.** Every test today is hand-built from fixture constants. Decoders that admit a large input space (`try_decode_well_formed_data` over arbitrary `Data`, `decode_mix_datum_strict` over malformed shapes, `walk_outputs` over arbitrary output lists) are exactly where property-based generation buys the most: a hand-written suite covers the cases the author imagined, but a fuzzer hits the parser-state-machine seams a human misses. [aiken-lang/fuzz](https://github.com/aiken-lang/fuzz) ships generators + shrinking + seed-based reproducibility, integrated with `aiken check`.

**Add the dep.** [contracts/aiken.toml](../contracts/aiken.toml):

```toml
[[dependencies]]
name = "aiken-lang/fuzz"
version = "v2"           # pin to the latest tag at the time of landing
source = "github"
```

(Confirm the latest tag against the upstream repo at PR time. Aiken libraries are pinned, not floating.)

**High-leverage targets.** In rough priority order:

1. **[contracts/lib/lovejoin/mixbox.ak](../contracts/lib/lovejoin/mixbox.ak) `try_decode_well_formed_data`.** Fuzz over arbitrary `Data` (constr index, field count, byte-length combinations). Property: result is `Some(_)` iff the structural rules hold (Constr 0, two `B` fields, both length 48, fields differ); else `None`. The current hand-written suite covers happy path + a handful of negatives; fuzzing surfaces the corner cases (extra fields, wrong index, nested Data) that no one wrote.
2. **[contracts/lib/lovejoin/mixbox.ak](../contracts/lib/lovejoin/mixbox.ak) `decode_mix_datum_strict`.** Same input space, but the property is "if `try_decode_well_formed_data` returns `Some(md)`, then `decode_mix_datum_strict` returns the same `md` and does not abort; if it returns `None`, the strict decoder aborts." Pins the consistency the validator relies on (Mix outputs are decoded with `_strict`, mix-script inputs with the soft variant; they MUST agree on what is well-formed).
3. **[contracts/validators/mix_logic.ak](../contracts/validators/mix_logic.ak) `walk_outputs`.** Fuzz over `(outputs, prefix_remaining)` shapes. Property: for any list of N+ valid mix-output prefix entries followed by any number of non-mix-script trailing entries, the walk returns the expected `(stmts, datums_acc, values_acc)` triple; for any list that violates either rule (mix-script in tail, fewer than N prefix entries, malformed prefix datum), the walk aborts.
4. **[contracts/lib/lovejoin/value.ak](../contracts/lib/lovejoin/value.ak) `expect_ada_only_lovelace`.** Fuzz over arbitrary `Value` shapes. Property: returns the lovelace amount iff the value has exactly one policy (ada) with exactly one asset name (empty); aborts otherwise. Easy to break with hand tests; trivial to fuzz.
5. **[contracts/lib/lovejoin/sigma_or.ak](../contracts/lib/lovejoin/sigma_or.ak) `xor32` + the XOR fold.** Fuzz over random 32-byte arrays. Property: the fold over any list of 32-byte branches commutes with bytewise XOR and always lands at length 32; non-32-byte input aborts.
6. **Encoding parity (cross-language).** `serialise_data` byte stability is currently locked by [contracts/lib/lovejoin/encoding_parity_kat.test.ak](../contracts/lib/lovejoin/encoding_parity_kat.test.ak) over 1000 KAT vectors per N. Adding a small Aiken-side fuzz over random `MixDatum { a, b }` and `assets.from_lovelace(n)` (the value-bytes cache pinned by `value_serialise_parity.test.ak`) catches a bytecode-level shift in `serialise_data` that the KAT vectors might miss.

**Out of scope for Q-3.** The cross-language KAT regen still lives in the Rust reference impl (`crypto/ref/`) and the TS prover. We are not turning Aiken fuzz tests into the source of truth for cross-language vectors; we are using fuzz to widen the on-chain-only coverage where the inputs are infinite (datums, outputs, values).

**Exit criteria.**

- [ ] `aiken-lang/fuzz` pinned in [contracts/aiken.toml](../contracts/aiken.toml).
- [ ] At least one property test per high-leverage target above, running under `aiken check` with deterministic seeds (so CI is reproducible).
- [ ] CI runs `aiken check` (no extra command needed; fuzz tests are first-class `aiken check` citizens).

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
