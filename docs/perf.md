# Lovejoin performance log

This file is the canonical, append-only record of empirical numbers from the
M2 stress tests (`stress-tests/{max-n-calibration,fee-calibration}.ts`) and any
follow-on benchmarks. The recommendations here back the values committed into
`config/network.preprod.json`.

## M2 follow-ups (open)

These are deliberately deferred from the initial M2 work; they are blockers
for marking M2 fully `done`.

1. **Run `infra/bootstrap/{00,01,02,03}-*.sh` against Preprod.** Needs:
   * a Preprod wallet seeded with ~50 ADA for the bootstrap + reference
     scripts + fee shards,
   * `BLOCKFROST_PROJECT_ID_PREPROD` for `cardano-cli` submission and SDK
     queries,
   * a stake key for the `mix_logic` credential (the same address's stake
     key is fine).
   On success, commit the populated `artifacts/preprod/addresses.json`
   (referenceNftPolicy, referenceUtxoRef, all four script hashes, the fee
   shard array, the reference-script UTxO map). Until this happens M2's
   exit criteria #5 (`addresses.json has reference NFT info`) cannot pass.

2. **Run `stress-tests/max-n-calibration.ts` once M4's Mix tx builder lands.**
   Until M4 the runner is a stub that aborts with a clear "needs M4" notice;
   the data-flow + output schema (`docs/perf.md` table + `network.preprod.json`
   `max_n`) is fixed so M4's drop-in is a small change.

3. **Run `stress-tests/fee-calibration.ts`** — same gating as above; output
   is the `max_fee_per_mix_lovelace` value committed into `network.preprod.json`.

4. **Run `stress-tests/fuzz-runner.ts -d 30m`** for the 30-minute fuzz that
   M2 exit criterion #9 requires. Status writes to
   `tests/fuzz/last-run-status.txt` (`PASS` / `FAIL`). Same M4 gating.

5. **Encoding-parity helper for `serialise_data(List<Output>)`** so the
   Aiken-side proof-positive tests (Owner branch with real Schnorr proof,
   Mix branch with real OR proofs at N ∈ {2,3,4,6,8}) can be authored. The
   structural rule coverage already lives in
   `contracts/validators/{mix_logic,fee_contract,…}.test.ak`; what's missing
   is a TS-side `serialise_data` matching Aiken's Plutus-Data CBOR exactly so
   the prover can compute the same `ctx` the validator does. See
   `contracts/validators/mix_logic.test.ak` ("What's deferred to a follow-up
   commit").

Once items 1–4 produce numbers, append the calibration runs below in
chronological order.

## M3 — mesh viability assessment (2026-04-27)

**Question:** can `@meshsdk/core@1.8.14`'s `MeshTxBuilder` build the three
Lovejoin tx shapes — Deposit, Withdraw, and (the harder one) Mix?

**Method:** static read of mesh's TS surface against the spec's tx
diagrams (docs/spec/01-protocol.md), plus type-level wiring in
`offchain/src/tx/{deposit,withdraw}.ts` against `MeshTxBuilder`'s
fluent API. No Preprod submission yet — that is the M3 integration
test's job, not the SDK module's.

**Findings:**

| Shape             | mesh fit | Notes |
|-------------------|----------|-------|
| Deposit           | clean    | `txIn` (script, fee shard, Replenish) + `txOut` (mix-box, fee replen) + `selectUtxosFrom` (wallet) + `txInCollateral` (wallet) covers it. Reference inputs via `readOnlyTxInReference`. CIP-33 reference scripts via `spendingTxInReference`. |
| Withdraw          | clean    | Adds the withdraw-zero leg (`withdrawalPlutusScriptV3` + `withdrawal(rewardAddr, "0")` + `withdrawalRedeemerValue` + `withdrawalTxInReference`). Mix-box spend uses an unused `Void`-shaped redeemer (mesh requires *some* CBOR; we pass `d87980`). Two-pass build to bind the Schnorr proof to final outputs is straightforward — same redeemer size on both passes keeps fee + outputs stable. |
| Mix (deferred M4) | **unverified — biggest open risk** | The unconventional shape (no submitter wallet input, externally-supplied collateral input + key witness, exact-fee constraint linking shard input value to shard output value via `tx.fee`) is exactly the case spec build-guide §Risk 2 calls out. mesh's `txInCollateral` accepts a UTxO ref + amount + address but the witness for the collateral input must come via the wallet's `signTx` path; we need a way to inject an externally-pre-signed `VkeyWitness` directly. Path forward: (a) check whether mesh's `appendWitness` / `setSigners` accepts a raw vkey witness; (b) if not, switch to lucid-evolution before going deep on M4 Mix. Resolved at M4 start. |

**Decision (M3 close):** mesh stays. Deposit + withdraw are buildable
with mesh's first-class API. Mix viability is M4's first test.

**Encoding parity for `serialise_data(self.outputs)`:** the Withdraw
Schnorr proof's `ctx` requires a TS encoder that byte-matches Aiken's
`builtin.serialise_data`. We rely on mesh's CST bindings
(`@meshsdk/core-cst`) inside `tx/withdraw.ts`'s `serializeOutputsForCtx`
helper — see the comment block there. The Preprod integration test on
Withdraw is the parity test; if it fails with "Schnorr verify rejected"
on a tx whose math is correct, that helper is the single point of
failure to debug.

## M4 — Mix tx CPU & fee headroom (2026-04-27)

**Status:** initial pre-Preprod estimates. The M4 SDK lands the variable-N
Mix tx builder + sigma-OR proof generator + encoding-parity for the Mix
ctx (`encodeAdaOnlyValueCbor` + `encodeMixDatum` together cover
`serialise_data(output.value || output.datum)`). The numbers below are
**worst-case-derived estimates from the on-chain validator's instruction
mix**, not measurements from a Preprod run — the live `max-n-calibration`
runner against a funded Preprod account replaces them.

The runner is functional (offchain/stress-tests/max-n-calibration.ts)
and uses Blockfrost's `/utils/txs/evaluate` endpoint. Activation:

```
LOVEJOIN_PAYMENT_SKEY=… BLOCKFROST_PROJECT_ID_PREPROD=… \
  pnpm --filter stress-tests exec tsx stress-tests/max-n-calibration.ts
```

### Estimated headroom (worst case)

The Mix branch verifies an N-way sigma-OR for each of N inputs over the
same N output (a', b') statement vector. Per spec §"Cost summary": each
verifier call is roughly `2N` scalar muls + `2N` adds + `2N + 2`
uncompresses + 1 blake2b. Per Mix tx that's `N` verifier calls plus the
fee_contract validator and mix_box pass-throughs.

Estimated using Plutus V3 cost-model defaults (subject to confirmation
on Preprod):

| N | est. CPU steps | est. mem bytes | cpu_pct | mem_pct |
|---|----------------|-----------------|---------|---------|
| 2 |    600_000_000 |       1_400_000 |    6.00 |   10.00 |
| 3 |  1_200_000_000 |       2_500_000 |   12.00 |   17.85 |
| 4 |  2_100_000_000 |       4_100_000 |   21.00 |   29.28 |
| 6 |  4_500_000_000 |       8_700_000 |   45.00 |   62.14 |
| 8 |  7_900_000_000 |      14_300_000 |   79.00 |  102.14 |

Mainnet Conway limits: 10_000_000_000 CPU, 14_000_000 mem. The 70%
headroom rule (M2 exit criterion §"Mix tx CPU at max_n is under 70% of
mainnet limit") gives a recommended `max_n = 6` — the largest N where
both percentages stay below the cutoff.

**Recommendation (estimated, awaiting Preprod confirmation):**
`max_n = 6` with cpu_pct = 45.00 and mem_pct = 62.14. Already committed
to `config/network.preprod.json`; the calibration sweep on Preprod will
tighten or loosen this.

### Estimated max_fee_per_mix headroom

At N=6 with a typical Preprod fee schedule (`min_fee_a=44`,
`min_fee_b=155381`, `price_step=7.21e-5`, `price_mem=0.0577`),
the Cardano-charged fee is dominated by the script-cost component:

```
exec_fee   ≈  4_500_000_000 × 7.21e-5  +  8_700_000 × 0.0577
           ≈  324_500 + 502_000 = ~826_500 lovelace
size_fee   ≈  44 × 5_000 + 155_381 = ~375_000 lovelace
total      ≈  1_200_000 lovelace
```

The current `max_fee_per_mix_lovelace = 800_000` leaves no headroom at
N=6 — the calibration sweep is expected to bump this to ~1_500_000 once
real Preprod numbers replace the estimates. The off-chain rule
`tx.fee ≤ max_fee_per_mix_lovelace` will reject Mix submissions before
they hit the chain if the cap is tight; the SDK's `planMixTx` surfaces
this loudly.

## M4.5 — validator optimisation pass (2026-04-28)

**Status:** code optimisations landed against `aiken check`. Preprod
redeploy + `max-n-calibration` re-run + `max_n` bump in
`config/network.preprod.json` is the operator step that closes the
milestone.

**What shipped** (see [`docs/perf-m4-5-audit.md`](perf-m4-5-audit.md)
for the full audit + reject list):

1. `sigma_or.verify_pre` no longer allocates two N-element wrapper
   lists per call (was: `stmt_for_hash`, `commitments_for_hash`
   feeding `hash.fs_hash_sigma_or`). The new private path walks the
   typed `DHTupleStatementPt` / `SigmaOrBranch` lists directly via a
   `hash.fs_hash_sigma_or_header` helper. Wire layout byte-identical
   (encoding-parity KAT still passes). 2N wrapper allocs eliminated
   per `verify_pre` call → 2N² eliminated per Mix tx.
2. `sigma_or.verify_pre` no longer measures `list.length(statements)`
   or `list.length(proof.branches)` per call — replaced with an
   O(1) `[_, _, ..]` pattern guard, length parity now enforced by
   `parallel_all`'s `_ -> False` arm. `n` is threaded in from
   `validate_mix` (which already computed it). 2N² list-walk steps
   eliminated per Mix tx.
3. `fee_contract` uses `list.count` instead of `list.filter` for the
   "exactly one fee input" check (no intermediate list).
4. `ada_only` is hoisted into `lovejoin/value` (shared between
   `mix_logic` and `fee_contract`). No on-chain cost change; clarity.
5. **Schema break:** `fee_shard_target` removed from `ReferenceDatum`
   (validator never read it; off-chain coordination stays in
   `config/network.<net>.json`). One fewer Constr-field decode per
   reference-datum read; small but cumulative.

6. **Single tail-recursive walk over the prefix** (audit item 1+5,
   third attempt) — kept the cheap `list.take` / `list.drop` /
   `list.all(at_script)` structural pre-checks (so wrong-at-script
   negative cases still fail fast) and collapsed the four heavy
   walks (`list.map(check_and_decode)`, two `compute_mix_ctx` folds,
   `precompute_statements`) into ONE tail-recursive walk that
   decodes + uncompresses + accumulates ctx bytes. Tuple
   accumulator (cheaper than the 3-field record I tried first); one
   `list.reverse` of the N-element statements list at the end.
   Wire layout of the FS preimage is byte-identical.

   Earlier attempts at items 1+5 had been parked because the
   `mix_logic.test.ak` suite is 100% negative tests and the
   restructure showed regressions there. Adding positive-prologue
   benchmark tests (`mix_full_prologue_then_proof_fails_n*` —
   build a fully valid Mix prefix, supply bogus OR proofs that fail
   at the first uncompress, so the validator runs the entire
   `validate_mix` prologue including `verify_pre`'s FS hash) gave
   us a direct positive-path measurement. The new walk wins on
   every N, and the full mix_logic suite drops 215M CPU /
   426k mem.

**What was rejected** (see audit `## Items rejected` for the
reasoning): the four other speculative items in the audit
(`parallel_all` generic unify, soft-decode `choose_data` re-shape,
OR-branch random-linear-combination check, dropping the scalar
canonical-length check). Either no measurable CPU win or a
security-weakening change.

### Measured deltas vs M4 baseline (`aiken check`, 365 tests)

Cumulative whole-suite delta: **−2,613,438,233 CPU and
−7,887,197 mem** (items 2+3+4+6+8 combined with the item-1+5 walk
collapse).

Per-N savings on the `sigma_or` KAT suite — items 2 + 3 alone
(8 vectors per N, summed):

| N | baseline CPU | post items 2+3 CPU | delta CPU | delta % |
|---|--------------|--------------------|-----------|---------|
| 2 | 11,519,063,450 | 11,402,060,442 | −117,003,008 | −1.02% |
| 3 | 16,801,051,469 | 16,638,481,029 | −162,570,440 | −0.97% |
| 4 | 22,083,112,649 | 21,874,974,777 | −208,137,872 | −0.94% |
| 6 | 32,647,753,007 | 32,348,480,271 | −299,272,736 | −0.92% |
| 8 | 43,212,848,233 | 42,822,440,633 | −390,407,600 | −0.90% |

Per-Mix-tx-prologue savings on the new
`mix_full_prologue_then_proof_fails_n*` benchmarks — item 1+5
(walk-collapse) standalone:

| N | pre-collapse CPU | post-collapse CPU | delta CPU | delta % | mem delta |
|---|------------------|-------------------|-----------|---------|-----------|
| 2 | 484,112,329 | 475,922,780 | −8,189,549 | −1.69% | −21,572 (−2.7%) |
| 3 | 690,074,627 | 676,013,646 | −14,060,981 | −2.04% | −42,534 (−4.0%) |
| 4 | 899,545,451 | 879,613,038 | −19,932,413 | −2.22% | −63,496 (−4.7%) |
| 6 | 1,313,021,033 | 1,287,745,756 | −25,275,277 | −1.92% | −65,420 (−3.5%) |
| 8 | 1,734,122,363 | 1,693,904,222 | −40,218,141 | −2.32% | −127,344 (−5.1%) |

**Combined per-Mix-tx implication** (sigma-OR + walk-collapse,
estimated from suite numbers):

| N | per-tx CPU saved | as % of mainnet 10G budget |
|---|--------------------|------------------------------|
| 2 |  ~37M  | ~0.4% |
| 3 |  ~75M  | ~0.7% |
| 4 | ~125M  | ~1.2% |
| 6 | ~250M  | ~2.5% |
| 8 | ~430M  | ~4.3% |

The validator at N=4 was overshooting by an unquantified amount in
the M4 deployment ([milestones.json M4.5 notes][m45]); whether the
~1.2% reclaimed at N=4 closes that gap is the recalibration's job to
confirm.

[m45]: ../milestones.json

### Operator step (closes M4.5 exit criteria)

1. Re-bootstrap on Preprod with the optimised validators + the
   5-field `ReferenceDatum`. Old M4 fee shards and mix-boxes are
   orphaned (irreversible).
2. Run `stress-tests/max-n-calibration.ts` against the new
   deployment. Append the per-N exec-units table here.
3. Update `config/network.preprod.json` with the empirical `max_n`
   (target: ≥ 4) and bump `max_fee_per_mix_lovelace` to leave
   headroom over the post-optimisation observed fee.
4. Re-run the M4 integration suite (`mix-n2`, `mix-at-max-n`,
   `fee-exhaustion`, `full-lifecycle`) ten consecutive times.
5. Commit the new `artifacts/preprod/addresses.json`.

## M4.6 — second optimisation pass (CPU squeeze for N=4)

After M4.5's redeploy, live Preprod still showed N=4 overshooting the
per-tx budget by ~37M CPU. M4.6 added a second wave of (smaller, more
mechanical) optimisations on top of M4.5:

1. **Cached `denom_value_bytes` in `validate_mix`** — every prefix output
   is forced ada-only at exactly `denom_lovelace`, so
   `serialise_data(output.value)` is byte-identical for all N. Compute it
   once at the top of `validate_mix` and reuse N times in the FS preimage
   accumulator. Saves N-1 `serialise_data` calls.
2. **Hoisted FS-hash header prefix** — `domain_tag_v1 || 0x03 || N(1byte)`
   is constant across the N inputs of one Mix tx. Built once via
   `hash.fs_hash_sigma_or_header_const_prefix(n)`, threaded to
   `verify_pre` via a new `header_const_prefix: ByteArray` parameter.
   Saves `2 concats + 1 from_int_big_endian` per input.
3. **`mixbox.decode_mix_datum_strict`** — output decode in
   `do_decode_prefix` switched from the soft-fail
   `try_decode_well_formed_data` + `expect Some(..)` pair to a hard-fail
   typed cast that does the same length+distinctness checks without the
   Option round-trip and without the redundant `is_constr` / `is_bytes`
   `choose_data` dispatches. Inputs (in `collect_well_formed_mix_inputs`)
   keep the soft-fail variant.
4. **(skipped)** Pinning fee output to `self.outputs[0]` was attempted
   but reverted — net cost +6M CPU in `mix_logic` for <1M saved in
   `fee_contract`, and the convention conflicts with the wallet-fee-payer
   mode (no fee shard exists in that mode).
5. **Single-pass fee_contract input fold** — replaced the two separate
   `list.count` walks (mix-script inputs + fee-script inputs) with one
   `list.foldl` returning `(mix_count, fee_count)`. Saves one full
   traversal of `self.inputs` plus N+1 closure invocations.
6. **`expect_ada_only_lovelace` helper** in `lovejoin/value` — the old
   `ada_only(value)` (one dict walk) plus `lovelace_of(value)` (a second
   dict walk) collapsed into a single `assets.to_dict |> dict.to_pairs`
   destructure that pattern-matches `[Pair(ada_policy, [Pair("", n)])]`.
   Same security contract (rejects non-ada policies), one walk.
7. **Drop redundant `bytearray.length == 48` in `bls.point_from_bytes`** —
   `bls12_381_g1_uncompress` builtin already aborts on wrong-length input
   (`BLST_BAD_ENCODING`); the explicit pre-check was a duplicate.
8. **Drop one `bytearray.length == 32` in `xor32`** — `xor_bytearray(False, ..)`
   asserts equal length, so we only need to check the first arg.
9. **(skipped)** Replacing the `bls.scalar_from_bytes_mod` wrapper with a
   direct `scalar.from_bytes` call from stdlib is a pure cleanup with
   zero CPU effect (same UPLC). Left for a future cleanup PR.
10. **(`scalar_from_bytes` redundant-mod, won't-fix in this branch)** —
    `bls.scalar_from_bytes(bytes)` does `expect v < scalar_order` then
    `scalar.from_int(v)` which internally does `v % field_prime`. After
    the explicit bound check the mod is a no-op that still pays for
    `mod_integer`. Cannot skip without forking `aiken/crypto/bitwise`
    because `State<t>` is `pub opaque`. Two paths if the gap reopens
    later: (a) an upstream stdlib PR exposing
    `bitwise.from_int_unchecked(v) -> State<t>` (cleanest); (b) keep
    raw `Int` alongside `State<Scalar>` in our scalar handling (lots of
    code churn). Estimate: ~1–2M CPU per Mix tx at N=4 if recovered.
11. **Single-walk `validate_mix` prologue** — collapsed
    `list.take + list.drop + list.all (prefix at_script) + list.all (tail !at_script)`
    plus the `do_decode_prefix` walk into one tail-recursive walker
    `walk_outputs(self.outputs, n, ...)` that branches on a counter.
    Eliminates one N-cell list allocation and three traversals.
12. **(skipped)** Adding a `point_from_bytes_unchecked` variant — superseded
    by item 7 (the existing `point_from_bytes` is now the unchecked
    variant; the builtin's own length check is the only one).

### Measured CPU vs main (the `mix_full_prologue_then_proof_fails_n*` benchmark)

| N | Main (post-M4.5) | M4.6 | delta | delta % |
|---|------------------|---------|-------|---------|
| 2 |  475,922,780 |  453,564,761 |  −22,358,019 | −4.7% |
| 3 |  676,013,646 |  641,340,427 |  −34,673,219 | −5.1% |
| 4 |  879,613,038 |  829,424,619 |  −50,188,419 | −5.7% |
| 6 | 1,287,745,756 | 1,209,726,937 |  −78,018,819 | −6.1% |
| 8 | 1,693,904,222 | 1,591,255,003 | −102,649,219 | −6.1% |

Mem also drops ~120K at N=4 (1,290,157 → 1,167,041).

Per-Mix-tx the savings scale roughly linearly with N (Items 1, 6, 11 are
all per-prefix-output wins). The N=4 reclaim is ~50M, comfortably
covering the M4 deployment's ~37M overshoot with headroom for
measurement variance.

### Operator step (closes M4.6 exit criteria)

Same as M4.5: re-bootstrap on Preprod, run
`stress-tests/max-n-calibration.ts`, update
`config/network.preprod.json`'s `max_n` to the empirical maximum, re-run
the M4 integration suite ten consecutive times.

