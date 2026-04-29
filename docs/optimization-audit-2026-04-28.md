# Optimization Audit Report — `mix_logic.Mix`, `mix_box.spend`, `fee_contract.PayMixFee`

Senior-engineering optimization review of the three hot validators in
[`contracts/`](../contracts/). Goal: squeeze CPU out of the on-chain
spend path while preserving every protocol semantic — including the
hyperstructure escape hatches in [`mix_box.ak`](../contracts/validators/mix_box.ak)
(Rule 2 datum tolerance) and [`fee_contract.ak`](../contracts/validators/fee_contract.ak).

The repo has already been through two optimisation passes (M4.5 and
M4.6 — see [`docs/perf-m4-5-audit.md`](perf-m4-5-audit.md) and
[`docs/perf.md`](perf.md) §M4.5/M4.6). This audit is a third pass and
focuses on what remains after those landed.

## Executive Summary

- **Overall optimization potential**: **Medium**. The cheap obvious wins
  have been booked (statement pre-uncompression, single-walk
  `validate_mix` prologue, cached `denom_value_bytes`, hoisted FS-hash
  prefix, single-pass fee-input fold). The dominant remaining cost is
  *inherent* to the N-way sigma-OR construction (≈ 4N² scalar muls + 2N²
  uncompresses + 2N² adds + 2N² point-equals + N blake2b inside
  [`sigma_or.verify_pre`](../contracts/lib/lovejoin/sigma_or.ak)).
  Algorithmic reductions there require a soundness re-derivation
  (already rejected for M4.5 — see audit item 11).
- **Estimated CPU reduction range** (from items in this audit, *cumulative,
  per-Mix-tx*):
  | N | reclaim (CPU) | as % of mainnet 10 G budget |
  |---|---|---|
  | 2 |  ~6 M | ~0.06 % |
  | 3 |  ~9 M | ~0.09 % |
  | 4 | ~13 M | ~0.13 % |
  | 6 | ~22 M | ~0.22 % |
  | 8 | ~32 M | ~0.32 % |

  This is one order of magnitude smaller than M4.6's reclaim. There is
  no single big lever left without an algorithmic / protocol change.
- **Biggest CPU sinks** (unchanged from prior audits):
  1. `bls12_381_g1_uncompress` on `t0`/`t1` per OR branch — N² uncompresses
     per Mix tx, ≈ 25–30 M CPU each.
  2. `bls12_381_g1_scalar_mul` — 4N² per Mix tx, ≈ 10 M each.
  3. `bls12_381_g1_add` and `bls12_381_g1_equal` — 2N² each, ≈ 1 M each.
- **Biggest easy wins** (this audit):
  1. **Fuse `list.find(own_input)` with the input-count fold in
     `fee_contract.validate_pay_mix_fee`** — saves one full
     `self.inputs` traversal per Mix tx.
  2. **Reorder `mix_box.spend` to soft-decode `_datum: Option<Data>`
     before the `list.find`** — recovery paths skip the input walk;
     hot path unchanged in cost; F-2 invariant preserved.
  3. **Drop the redundant `expect bytearray.length(left) == 32` in
     `sigma_or.xor32`** — the underlying `xor_bytearray(False, ..)`
     builtin enforces equal-length; `acc` is always 32 by construction.
- **Biggest risky wins** (deferred / not recommended now):
  - Dropping the asymmetry between `mix_box`'s typed-`Datum` walk and
    `mix_logic`'s `InlineDatum`-only filter (would close F-2 by
    mix_logic-side rejection rather than mix_box-side disambiguation;
    significant protocol surface change).
  - Using `choose_data` as a 5-way dispatcher for soft-decoding (same
    laziness concern that blocked M4.5 item 10).
  - Compressing the 2-equation OR-branch check into a random-linear-
    combination single equality (already rejected for M4.5 as soundness-
    sensitive).
- **Stdlib usage in hot paths**: acceptable. The remaining stdlib calls
  in the hot loop are `list.foldl` (necessary), `bytearray.concat`
  (necessary for FS preimage), `pairs.has_key` (small input — fine).
  No `assets.flatten`, `dict.from_pairs`, `list.sort`, `list.zip` in
  any production path.

## Contract Map

| File | Validator/Policy | Purpose | Hot path? | Notes |
|---|---|---|---|---|
| [`mix_logic.ak`](../contracts/validators/mix_logic.ak) | `mix_logic` | withdraw / publish | **YES — Mix branch** | Once per Mix tx. Owner branch is hot under bulk owner withdraws. |
| [`mix_box.ak`](../contracts/validators/mix_box.ak) | `mix_box` | spend | **YES** | Runs N times per Mix tx (once per mix-script input). |
| [`fee_contract.ak`](../contracts/validators/fee_contract.ak) | `fee_contract` | spend | **YES — PayMixFee** | Once per Mix tx. Replenish is once per Deposit. |
| [`one_shot_mint.ak`](../contracts/validators/one_shot_mint.ak) | `one_shot_mint` | mint | NO | Bootstrap-only, single lifetime invocation. |
| [`reference_holder.ak`](../contracts/validators/reference_holder.ak) | `reference_holder` | spend | NO | Always-False; reference UTxO is read-only via `reference_inputs`. |
| [`lib/lovejoin/sigma_or.ak`](../contracts/lib/lovejoin/sigma_or.ak) | — | OR-proof verifier | **YES** | Called N times per Mix tx; dominant CPU. |
| [`lib/lovejoin/schnorr.ak`](../contracts/lib/lovejoin/schnorr.ak) | — | Schnorr verifier | YES under bulk-owner | Called N times per Owner tx. |
| [`lib/lovejoin/bls.ak`](../contracts/lib/lovejoin/bls.ak) | — | BLS12-381 G1 wrappers | YES | Inlined into `sigma_or` / `schnorr`. |
| [`lib/lovejoin/hash.ak`](../contracts/lib/lovejoin/hash.ak) | — | FS-hash preimage builders | YES | `fs_hash_sigma_or_header_with_prefix` per input + per-tx const prefix. |
| [`lib/lovejoin/value.ak`](../contracts/lib/lovejoin/value.ak) | — | `expect_ada_only_lovelace` | YES | One dict walk per output / fee-input. |
| [`lib/lovejoin/mixbox.ak`](../contracts/lib/lovejoin/mixbox.ak) | — | datum decoders + script-cred helpers | YES | Per input + per output. |
| [`lib/lovejoin/fee.ak`](../contracts/lib/lovejoin/fee.ak) | — | fee-shard helpers | YES | Per input + per output (PayMixFee). |
| [`lib/lovejoin/reference.ak`](../contracts/lib/lovejoin/reference.ak) | — | reference-UTxO lookup | YES | One reference-input walk per validator run. |

## Hot path inventory (per Mix tx, N = mix width)

For a Mix tx with N mix inputs and 1 fee-shard input:

| Step | Walks | Where |
|---|---|---|
| `mix_box.spend` × N | N × `list.find(self.inputs)` (≈ M comparisons each) + N × soft-decode | [`mix_box.ak`](../contracts/validators/mix_box.ak) |
| `fee_contract.spend` (PayMixFee) | 1 × `read_reference_datum` (walks `reference_inputs`) + 1 × `list.find(own_input)` + 1 × `list.foldl` for mix/fee count + 1 × `list.filter` for fee_outputs + 1 × `pairs.get_first` (redeemers) | [`fee_contract.ak`](../contracts/validators/fee_contract.ak) |
| `mix_logic.withdraw` (Mix) | 1 × `read_reference_datum` (a SECOND walk of `reference_inputs`) + 1 × `collect_well_formed_mix_inputs` (walks `self.inputs`) + 1 × `list.length(mix_inputs)` + 1 × `list.length(proofs)` + `walk_outputs` (walks `self.outputs` once) + `list.reverse(statements)` + N × `verify_pre` | [`mix_logic.ak`](../contracts/validators/mix_logic.ak) |
| Per `verify_pre` | 2 × `point_from_bytes(a, b)` + `fs_hash_sigma_or_header_with_prefix` (2 concats) + `list.foldl` over statements (2N concats) + `list.foldl` over branches (2N concats) + `blake2b_256` + `list.foldl` xor over branches (N × xor32) + `parallel_all` over (statements, branches) running 2 mul + 1 add + 1 mul + 1 add + 1 eq + 1 mul + 1 add + 1 mul + 1 add + 1 eq per branch | [`sigma_or.ak`](../contracts/lib/lovejoin/sigma_or.ak) |

Two `read_reference_datum` invocations per Mix tx (`fee_contract` + `mix_logic`)
walk the same `reference_inputs` list separately. Cardano runs each
validator in its own UPLC instance — they cannot share. This is a
ledger-level constant cost, not an in-script duplication.

## Baseline Benchmark Plan

The repo already has the right benchmark scaffold:

- **`mix_logic.test.ak: mix_full_prologue_then_proof_fails_n{2,3,4,6,8}`** —
  positive-prefix Mix tx with bogus proofs that abort at the first
  `point_from_bytes(br.t0)`. Exercises the full `validate_mix` prologue
  (structural checks, datum decode, ctx build, statement
  pre-uncompression) plus the FS-hash construction inside the first
  `verify_pre`. **This is the main per-tx-cost proxy.**
- **`fee_contract.test.ak: pay_mix_fee_positive_n{2,6}`** — happy-path
  PayMixFee; no proof verification. Per-tx structural cost only.
- **`mix_box.test.ak: mix_box_accepts_when_mix_logic_withdraws_zero`** —
  happy-path mix_box spend.

What's **missing** for the items below:

1. **Bulk Owner happy-path benchmark** — none exists today. There is no
   positive-Owner test because the `ctx` requires a TS-side
   `serialise_data(self.outputs)` shim (deferred to a follow-up commit per
   `mix_logic.test.ak` header). For optimisation work on `validate_owner`
   we can instead use the equivalent of the Mix
   `_full_prologue_then_proof_fails` pattern — supply correctly-sized
   bogus Schnorr proofs that fail at `point_from_bytes` after all
   structural checks pass. **Add `owner_full_prologue_then_proof_fails_n{1,4,8}` tests.**

2. **`mix_box` per-spend cost benchmark across (NoDatum, malformed-inline,
   well-formed-inline, DatumHash) inputs at varying input list size**.
   The existing tests only cover correctness, not per-call cost across
   the four input shapes. **Add four micro-benchmark tests** in
   `mix_box.test.ak`, each with `M = 8` inputs of mixed shapes so a
   `list.find` is non-trivial. Capture CPU per shape; expectation:
   recovery shapes drop to ~⅓ of the well-formed inline cost after the
   reorder in §1.

3. **`fee_contract.PayMixFee` cost benchmark with M = 1 + N input txs at
   N ∈ {2,3,4,6,8}**. Today only N=2 and N=6 happy paths are covered.
   Add the 3 / 4 / 8 cases so the `list.foldl` reduction in §2 is
   visible at the same N values as the mix_logic prologue benchmark.

4. **Owner-redeemer attacker benchmark (F-1 regression)**. Already
   exists (`pay_mix_fee_rejects_owner_redeemer_n{2,6}`). After §2, the
   reject should land *before* any input walk; CPU should drop sharply
   on this test. Capture the pre/post numbers as a fail-fast proof.

For each of the items below, the **measurement procedure** is:

1. `cd contracts && aiken check` — read the per-test CPU/mem from the
   trace report.
2. Diff the cumulative-suite-CPU against `main` (the repo's M4.6 head)
   with the audit's git-tracked baseline. (M4.5/M4.6 do this in
   `docs/perf.md`.)
3. For each ranked optimisation, the per-N delta from the relevant
   benchmark above is the headline number; the cumulative-suite delta
   is the safety net (catches regressions in the rest of the validator
   suite).

## High-Impact Findings

### H1 · `fee_contract.PayMixFee` — fuse `list.find(own_input)` with the input-count fold

- **Location**: [`fee_contract.ak:59-68, 89-128`](../contracts/validators/fee_contract.ak#L59-L128).
- **Current cost problem**: `validate_pay_mix_fee` walks `self.inputs` **twice**:
  - Once via `list.find(self.inputs, fn(input) { input.output_reference == utxo })` in the spend handler (line 60).
  - Again via `list.foldl(self.inputs, (0, 0), …)` for the mix/fee count (line 113).

  Each Cardano `Input` carries a 32-byte `transaction_id` and an `Int`
  index in its `output_reference`; equality per element is cheap but
  not free. With `M = N + 1` inputs, that's an extra `M` list traversals
  per Mix tx that buy nothing.
- **Proposed fix**: collapse both into a single `list.foldl` returning
  `(mix_count, fee_count, own_lovelace)`. The own input is identified
  by the pre-known `OutputReference utxo` argument; in the same pass
  we extract its lovelace via `expect_ada_only_lovelace`. Move the
  redeemer-Mix gate (currently the first thing in
  `validate_pay_mix_fee`) **above** the fold so attacker txs with an
  Owner redeemer abort before the walk.
- **Expected impact**: **Medium**. At N=4 (M=5), saves ≈ 5 list-walk
  steps + 1 list.find pattern overhead ≈ 5–8 M CPU. At N=8 (M=9),
  ≈ 9–12 M CPU. Plus a small wall-clock win on attacker txs (Owner
  redeemer rejected before any traversal).
- **Risk**: **Low**. Pure restructure. Behaviour-equivalent except the
  failure-trace order changes (fee-shard input not at fee script now
  fails inside the fold instead of at the upfront `expect Script(_) =
  …`).
- **Behaviour change**: No (same accept set; attacker txs reject equal
  or earlier than today).
- **Tests need updating**: No — the existing `fee_contract.test.ak`
  positive + negative cases keep passing. **Add** the missing
  N ∈ {3,4,8} positive cases (see Baseline Benchmark Plan §3).
- **Suggested benchmark**: cumulative `fee_contract.test.ak` CPU before
  and after.
- **Code replacement**: see [Patch sketch H1](#patch-sketch-h1) below.

### H2 · `mix_box.spend` — short-circuit on `_datum: Option<Data>` before the input walk

- **Location**: [`mix_box.ak:40-69`](../contracts/validators/mix_box.ak#L40-L69).
- **Current cost problem**: every mix_box spend pays for
  `list.find(self.inputs, …)` (≈ M/2 comparisons) before it knows whether
  the typed datum is `InlineDatum`, `DatumHash`, or `NoDatum`. For
  recovery-path spends (NoDatum, malformed-inline, DatumHash with
  arbitrary witness data) the walk is wasted: those cases hit the
  `_ -> True` arm regardless. mix_box runs **N times per Mix tx**, so
  even small per-spend constants compound.
- **Proposed fix**: reorder the validator to do the cheap soft-decode on
  `_datum: Option<Data>` first, and *only* walk `self.inputs` when the
  datum decodes as a well-formed `MixDatum`:

  ```aiken
  spend(datum: Option<Data>, _redeemer: Data, utxo: OutputReference, self: Transaction) {
    when datum is {
      None -> True   // NoDatum: recovery (Rule 2). Skip walk.
      Some(d) ->
        when try_decode_well_formed_data(d) is {
          None -> True   // Malformed inline OR malformed-resolved hash: recovery.
          Some(_md) -> {
            // Well-formed MixDatum bytes. We still need to disambiguate
            // InlineDatum vs DatumHash for F-2: only InlineDatum mix-script
            // inputs are part of the privacy pool (mix_logic's collector
            // silently drops DatumHash even when its witness data resolves
            // to a valid MixDatum).
            expect Some(own_input) =
              list.find(self.inputs, fn(input) { input.output_reference == utxo })
            when own_input.output.datum is {
              InlineDatum(_) -> {
                let mix_logic_credential: Credential = Script(mix_logic_script_hash)
                pairs.has_key(self.withdrawals, mix_logic_credential)
              }
              _ -> True   // DatumHash (F-2 critical) or NoDatum (impossible here): recovery.
            }
          }
        }
    }
  }
  ```

- **Expected impact**: **Medium for recovery cases, neutral for hot
  path**.
  - **Recovery (NoDatum)**: skip the M-input walk + Datum match. ~3–5 M
    CPU saved per spend. With the recovery being rare today (≤1 in
    practice), per-tx win is small. But it IS a strict improvement.
  - **Recovery (Malformed inline)**: ~2–4 M CPU saved.
  - **Hot path (well-formed inline)**: same total cost; the soft-decode
    moves from inside the `InlineDatum` branch to before the `list.find`,
    but the same builtins run.
  - **Net at N=4**: maybe 0–2 M CPU per Mix tx (almost no recovery
    inputs in honest Mix txs).

  The *main* value of this change is **correctness clarity** — the
  hyperstructure recovery branches now visibly cost less than the
  proof-required branch, matching the spec's description of them as
  "cheap escape hatches."
- **Risk**: **Low–Medium**. F-2 invariant must be preserved. The
  proposed code keeps the typed-Datum disambiguation in the well-formed
  branch (mandatory: a DatumHash mix-script UTxO whose resolved data is
  a valid MixDatum still must NOT route through the `pairs.has_key`
  gate, because mix_logic silently drops it). Direct verification:
  the existing `mix_box_datum_hash_with_well_formed_preimage_takes_recovery_path`
  test already covers the F-2 critical case.
- **Behaviour change**: No.
- **Tests need updating**: **Yes — important.** All existing
  `mix_box.test.ak` tests pass `None` for the spend handler's
  `_datum` (line 85, 97, etc.) regardless of the typed Datum on the
  input. After this change, the `_datum` argument is *load-bearing*:
  - `mix_box_accepts_when_mix_logic_withdraws_zero` should pass
    `Some(well_formed_datum())`.
  - `mix_box_accepts_a_eq_b_datum_no_withdraw` should pass
    `Some(MixDatum { a: a48, b: a48 })`.
  - `mix_box_accepts_short_bytes_datum_no_withdraw`
    → `Some(MixDatum { a: #"01", b: b48 })`.
  - `mix_box_accepts_int_datum_no_withdraw` → `Some(42)`.
  - `mix_box_accepts_wrong_constr_idx_datum_no_withdraw` → `Some(Replenish)`.
  - `mix_box_no_datum_takes_recovery_path` → keep `None`.
  - `mix_box_datum_hash_with_well_formed_preimage_takes_recovery_path`
    → `Some(well_formed_datum())` (because the resolver hands us the
    resolved data even for DatumHash).
- **Suggested benchmark**: add `mix_box_recovery_no_datum_perf`,
  `mix_box_recovery_malformed_perf`, `mix_box_well_formed_inline_perf`,
  `mix_box_recovery_datum_hash_perf` micro-benchmarks (all with M=8
  inputs to make the walk non-trivial).

### H3 · `sigma_or.xor32` — drop the redundant length-32 expect

- **Location**: [`sigma_or.ak:80-83`](../contracts/lib/lovejoin/sigma_or.ak#L80-L83).
- **Current cost problem**:
  ```aiken
  fn xor32(left: ByteArray, right: ByteArray) -> ByteArray {
    expect bytearray.length(left) == 32
    builtin.xor_bytearray(False, left, right)
  }
  ```
  - `builtin.xor_bytearray(False, l, r)` already aborts when
    `length(l) != length(r)` — that's the documented contract of the
    `False` padding flag.
  - The XOR fold seed is `zero32` (32 bytes by definition), and
    `xor_bytearray` with two 32-byte inputs returns 32 bytes. By
    induction, `acc` is **always** 32 bytes, so the explicit `expect
    bytearray.length(left) == 32` is True every call.
  - The right side's length is implicitly enforced by the builtin: if
    `br.c` is not 32 bytes, the builtin aborts on the first iteration
    (because the seed `zero32` is exactly 32 bytes).
  - Per-Mix-tx cost: `xor32` runs N × N = N² times. The redundant `expect
    bytearray.length(left) == 32` is `1 length` + `1 ==` builtin pair —
    ~0.2–0.5 M CPU each.
- **Proposed fix**:
  ```aiken
  fn xor32(left: ByteArray, right: ByteArray) -> ByteArray {
    builtin.xor_bytearray(False, left, right)
  }
  ```
  At this point the helper is a one-liner — consider inlining it at the
  single call site in `verify_pre` and deleting the helper entirely.
- **Expected impact**: **Low–Medium**. At N=4: 16 calls × ~0.4 M = ~6 M
  CPU. At N=8: 64 × ~0.4 M = ~25 M CPU.
- **Risk**: **Low**. The builtin's abort-on-length-mismatch is still in
  place; the only change is *which* failure mode trips on a length-≠-32
  per-branch `c`.
- **Behaviour change**: No.
- **Tests need updating**: No — the existing sigma-OR negative tests for
  malformed `c` lengths still reject (via the builtin).
- **Suggested benchmark**: cumulative `sigma_or_kat.test.ak` CPU before
  and after, especially the per-N totals at N ∈ {6, 8}.

## Medium-Impact Findings

### M1 · `mix_logic.validate_mix` — fuse `collect_well_formed_mix_inputs` with `list.length(mix_inputs)` — **REJECTED on measurement**

- **Outcome**: attempted **and reverted** in the M4.7 implementation
  pass (2026-04-28). Both shapes regressed cumulative-suite CPU:
  - Hand-recursive 4-arg helper (`do_collect(inputs, hash, acc, n)`):
    **+24,591,771 CPU, +67,648 mem** vs H3 head.
  - `list.foldr` over `self.inputs` accumulating a `(List<MixDatum>, Int)`
    tuple: **+14,523,876 CPU, +11,808 mem** vs H3 head.

  Per-N prologue benchmark (foldr variant):
  | N | Before (H3 head) | After M1 (foldr) | Delta |
  |---|---|---|---|
  | 2 |   453,414,279 |   454,123,641 |    +709,362 |
  | 3 |   641,189,945 |   642,173,165 |    +983,220 |
  | 4 |   829,274,137 |   830,531,215 |  +1,257,078 |
  | 6 | 1,209,576,455 | 1,211,381,249 |  +1,804,794 |
  | 8 | 1,591,104,521 | 1,593,457,031 |  +2,352,510 |

  **Why the audit's estimate was wrong**: the audit treated `list.length`
  on a small (N-element) filtered list as 0.5–2 M CPU. In compiled
  UPLC, `list.length` traversing N cells of a freshly-filtered list is
  *cheaper* than carrying a 2-tuple `(List, Int)` accumulator through
  every step of an M-element fold — the per-step pair allocation +
  destructure dominates the saved length walk. `list.filter_map` is
  a tightly-compiled stdlib helper with a 2-arg recursive shape; mine
  is a 4-arg recursion (hand) or 2-tuple-acc fold (foldr). Both lose.
- **Recommendation**: **Skip.** The reverted code is the existing
  `list.filter_map` + `list.length` pair. **Update of audit estimate
  for future passes**: the cost of replacing a small `list.length`
  call with a fused-count fold is **negative** (regresses by ~1–2 M
  per element of `self.inputs` from tuple-allocation overhead).
- **For reference, the rejected proposed fix was**: replace `list.filter_map` with a hand-recursive
  helper that returns `(filtered_list, count)` in one pass:

  ```aiken
  fn collect_well_formed_mix_inputs_with_count(
    self: Transaction,
    mix_script_hash: ByteArray,
  ) -> (List<MixDatum>, Int) {
    do_collect(self.inputs, mix_script_hash, [], 0)
  }

  fn do_collect(
    inputs: List<Input>,
    mix_script_hash: ByteArray,
    acc: List<MixDatum>,
    n: Int,
  ) -> (List<MixDatum>, Int) {
    when inputs is {
      [] -> (list.reverse(acc), n)
      [input, ..rest] ->
        if input_at_script(input, mix_script_hash) {
          when try_decode_well_formed_inline(input.output.datum) is {
            Some(md) -> do_collect(rest, mix_script_hash, [md, ..acc], n + 1)
            None -> do_collect(rest, mix_script_hash, acc, n)
          }
        } else {
          do_collect(rest, mix_script_hash, acc, n)
        }
    }
  }
  ```

  Then `let (mix_inputs, n) = collect_well_formed_mix_inputs_with_count(…)`
  and skip the subsequent `list.length`.
- **Measured impact**: **negative** — see Outcome above. The estimate
  underweighted the cost of the accumulator pair vs. the small
  `list.length` walk it replaces.
- **Risk** (theoretical): Low.
- **Behaviour change**: No.
- **Tests need updating**: No.

### M2 · `mix_logic.validate_mix` — drop `list.reverse(statements_rev)` by walking outputs in REVERSE for the FS preimage

Skipping this one. The current `walk_outputs` accumulates statements
in reverse (cheap cons), then the caller does one final `list.reverse`.
Cost: one O(N) walk per Mix tx ≈ 0.4 M @ N=4. Restructuring to right-fold
is non-trivial (datums/values accumulators are byte-string concatenations
that *must* be left-to-right for the canonical FS preimage). Net win
< 1 M, not worth the readability hit.

### M3 · `hash.fs_hash_sigma_or_header_const_prefix` — pre-concat `domain_tag_v1 || #"03"`

- **Location**: [`hash.ak:93-98`](../contracts/lib/lovejoin/hash.ak#L93-L98).
- **Current cost problem**:
  ```aiken
  pub fn fs_hash_sigma_or_header_const_prefix(n: Int) -> ByteArray {
    let n_byte = bytearray.from_int_big_endian(n, 1)
    domain_tag_v1
      |> bytearray.concat(statement_id_sigma_or_n)
      |> bytearray.concat(n_byte)
  }
  ```
  Every Mix tx pays for `bytearray.concat(domain_tag_v1, #"03")` even
  though those two are protocol constants. Once-per-tx, but free.
- **Proposed fix**: hoist a precomputed const:
  ```aiken
  pub const sigma_or_header_static_prefix: ByteArray =
    "lovejoin/sigmajoin/v1/\x03"
  ```
  (or build it via `pub const … = domain_tag_v1 |> bytearray.concat(statement_id_sigma_or_n)`
  if Aiken supports const-eval of `concat`; otherwise inline the raw
  bytes and add a compile-time test that asserts equality with the
  derived form). Then the runtime function only does `concat(prefix, n_byte)`.
- **Expected impact**: **Low**. ~0.5 M CPU per Mix tx. One concat saved.
- **Risk**: **Low**. Static; verified by an existing parity test
  (`encoding_parity_kat.test.ak`).
- **Behaviour change**: No.
- **Tests need updating**: keep parity KAT.

### M4 · `fee_contract.validate_replenish` — fuse `list.find(own_input)` with `list.count(input_at_fee)`

- **Location**: [`fee_contract.ak:59-69, 150-170`](../contracts/validators/fee_contract.ak#L150-L170).
- **Current cost problem**: same shape as H1, on the Replenish path.
  `list.find` walks self.inputs once (in the spend handler), then
  `list.count` walks again in `validate_replenish`. Replenish runs
  once per Deposit, not per Mix, so the per-tx-cost angle is lower —
  but the savings are free if we touch this file for H1 anyway.
- **Proposed fix**: same pattern as H1 — single-pass fold returning
  `(fee_count, own_lovelace)`. (No mix-input count needed.)
- **Expected impact**: **Low**. ~2–3 M CPU per Deposit tx.
- **Risk**: **Low**.
- **Behaviour change**: No.
- **Tests need updating**: No.

### M5 · `mix_box.spend` — bypass the `list.find` on the F-2 disambiguation by widening `mix_logic`'s input filter

- **Location**: [`mix_box.ak:52-69`](../contracts/validators/mix_box.ak#L52-L69) + [`mix_logic.ak:292-306`](../contracts/validators/mix_logic.ak#L292-L306).
- **Current cost problem**: F-2 forces `mix_box` to walk `self.inputs`
  (via `list.find`) **purely to read the typed `Datum` field** so it
  can distinguish `InlineDatum` vs `DatumHash`. The hot-path mix_box
  spend pays for that walk on every input — N times per Mix tx.
- **Proposed fix (architectural)**: change `mix_logic.collect_well_formed_mix_inputs`
  to also accept `DatumHash(_)` mix-script inputs **and resolve their
  data via `tx.datums`**, so a DatumHash mix-script input with valid
  resolved data joins the proof set just like an InlineDatum input.
  Then F-2's asymmetry vanishes: the rule becomes "any well-formed
  resolved data is in the pool, regardless of inline/hash." `mix_box`
  no longer needs the typed-Datum check — it can decide entirely from
  the spend handler's `_datum: Option<Data>`:
  ```aiken
  spend(datum: Option<Data>, _r: Data, _utxo: OutputReference, self: Transaction) {
    when datum is {
      None -> True
      Some(d) ->
        when try_decode_well_formed_data(d) is {
          None -> True
          Some(_) -> pairs.has_key(self.withdrawals, Script(mix_logic_script_hash))
        }
    }
  }
  ```
  The `list.find` and the `Input` import disappear.
- **Expected impact**: **Medium–High**. At N=4 (M=5) we save 4 ×
  list.find cost = 4 × ~M/2 × ~1 M = ~10 M CPU per Mix tx. At N=8
  (M=9): 8 × ~4.5 × 1 M = ~35 M CPU.
  - **However**: `mix_logic` now also has to walk `tx.datums` (a
    `Pairs<DatumHash, Data>` list) for each `DatumHash(_)` input it
    counts. In practice, today *no* SDK creates DatumHash mix-script
    UTxOs, so `tx.datums` is typically empty for mix-script entries
    and the new lookups are O(0) for honest txs.
- **Risk**: **Medium**. This is a **protocol-surface change**:
  (a) DatumHash mix-script UTxOs become legitimate members of the pool
  if their resolved data is well-formed. Users who deliberately store a
  mix-box as a DatumHash (which no SDK does today) gain pool eligibility.
  (b) `tx.datums` lookup adds attack surface — an adversary could try
  to omit the witness for a DatumHash input and force `mix_logic` to
  fail; but the ledger requires witnesses for all DatumHash inputs at
  spend time, so this is already prevented at validation entry.
  (c) The Rule 2 escape hatch for "garbage at the mix script" still
  works: anything that doesn't decode as a well-formed MixDatum still
  hits the `None -> True` branch.
  (d) **Audit-grade soundness check is non-trivial** — the F-2 audit
  finding's reasoning relied on the asymmetry being closed by the spend
  validator, not by the withdraw validator. This change moves the
  closure to mix_logic. Re-derive the proof obligation explicitly.
- **Behaviour change**: **Yes** — DatumHash mix-script UTxOs move from
  the "recovery / sweepable" set to the "pool member, requires proof"
  set. SDK / off-chain unchanged because no SDK creates them today.
- **Tests need updating**: significant. The F-2 negative test
  `mix_box_datum_hash_with_well_formed_preimage_takes_recovery_path`
  inverts: that scenario must now end in the proof-required path, not
  recovery. New positive test: a Mix tx with a DatumHash mix-script
  input + valid witness data + valid OR proof verifies.
- **Recommendation**: **Defer to post-M4.6 architectural review**. The
  gain is real but bundles with a Rule-2 semantics shift that the
  audit committee should bless before shipping. Capture as the M5
  candidate (architectural) and re-evaluate alongside any other
  protocol-level cleanups planned for the next redeploy.

## Low-Impact Findings

### L1 · `bls.scalar_from_bytes` redundant mod (M4.6 §10, still won't-fix)

Documented in the M4.6 changelog. `expect v < scalar_order` is followed
by `scalar.from_int(v)`, which internally does `v % field_prime` —
wasted `mod_integer` on every per-branch z-scalar. ~1–2 M CPU per Mix
tx at N=4. **Blocker**: stdlib's `State<t>` is `pub opaque`; cannot
construct a `State<Scalar>` without going through `from_int`. Two
upstream paths (stdlib PR exposing an unchecked constructor; or
threading raw `Int` alongside `State<Scalar>`) — both larger than the
local optimisation justifies.

### L2 · `mix_logic.validate_owner` — drop the `expect list.length(proofs) == n` (REJECTED)

Considered, then rejected. Without the upfront check,
`pairs_match_and_all` would run up to N expensive `schnorr.verify`
calls before catching a length mismatch via its `_ -> False` arm.
A length-mismatch attacker tx at N=8 would force ~8 × ~150 M = ~1.2 G
wasted CPU before reject — the upfront `list.length` check costs ~1 M
and prevents the wasted work. **Keep the check.** Same logic for
`validate_mix`'s `expect list.length(proofs) == n`.

### L3 · `reference.read_reference_datum` — `list.filter` + singleton `expect`

Walks `tx.reference_inputs` (typically size 1–2). Could be a
recursive helper that fails fast on the first match if it sees a
second match. Saves ≈ 0.1 M CPU. Not worth the source diff.

### L4 · `one_shot_mint` — two passes over `tokens_under_policy`

`dict.foldr` for the sum + `dict.size` for the count. Two passes.
Not in the hot path (mints once per protocol lifetime). **Keep**.

## Stdlib Hot Path Review

| Function | Used in | Replace? | Why |
|---|---|---|---|
| `list.foldl` | `verify_pre` (FS-hash branches/commitments + xor), `validate_pay_mix_fee` (input fold) | **Keep** | Single-pass; correct accumulator usage. |
| `list.filter_map` | `collect_well_formed_mix_inputs` | Replace with hand recursion (M1) | Saves the subsequent `list.length`. |
| `list.find` | `mix_box.spend`, `fee_contract.spend` | **Reduce** (H1, H2) | Fuse with adjacent walks; short-circuit recovery cases. |
| `list.filter` | `fee_contract.validate_pay_mix_fee` (fee_outputs) | Keep | Walks `self.outputs`; `[fee_output] = …` requires the filtered list anyway. Replacing with `list.find` and a count would not save measurable CPU. |
| `list.count` | `fee_contract.validate_replenish` | Replace (M4) | Same shape as H1. |
| `list.length` | `validate_mix`, `validate_owner` (input + proof lengths) | Reduce (M1) | Fold count into `collect_well_formed_mix_inputs`; keep proofs check. |
| `list.reverse` | `walk_outputs` | Keep | Statements list is built reverse-cons; one final reverse is cheaper than `list.foldr`. |
| `pairs.has_key` | `mix_box.spend` | Keep | Withdrawals list ≤ 2 typically. |
| `pairs.get_first` | `fee_contract.validate_pay_mix_fee` | Keep | Redeemers list is small; sorted scan. |
| `dict.to_pairs` | `expect_ada_only_lovelace` | Keep | One walk per call; the canonical-shape destructure replaces two prior dict walks. |
| `dict.foldr` | `one_shot_mint.mint` | Keep | Bootstrap-only. |
| `assets.flatten` / `restricted_to` / `policies` | NONE | n/a | Not used in any production path — good. |
| `list.map` / `list.zip` / `list.sort` / `dict.from_pairs` / `dict.keys` / `dict.values` / `list.flat_map` | NONE | n/a | Already eliminated in M4.5/M4.6 passes. |

## Repeated Traversal Review

| Path | Repeated? | Single-pass replacement |
|---|---|---|
| `fee_contract.PayMixFee` walks `self.inputs` 2× (find + foldl). | **Yes** | H1 — fuse to single foldl with `(mix_count, fee_count, own_lovelace)`. |
| `fee_contract.Replenish` walks `self.inputs` 2× (find + count). | **Yes** | M4 — same fuse. |
| `mix_box.spend` walks `self.inputs` once via `list.find`. | No | H2 reorder lets some recovery paths skip the walk; hot path keeps it. |
| `mix_logic.validate_mix` walks `self.inputs` 1× (collect) + `mix_inputs` 1× (length). | One redundant | M1 — fold count into collect. |
| `mix_logic.validate_mix` walks `self.outputs` 1× (`walk_outputs`). | No (already collapsed at M4.6 §11) | n/a |
| `verify_pre` walks `proof.branches` 2× (xor fold + parallel_all). | **Yes**, but separation is intrinsic | The xor fold needs the global c first; the per-branch verify needs c-derived per-branch c_i. Cannot combine without breaking soundness model. **Keep.** |
| `verify_pre` walks `statements` 2× (FS-preimage fold + parallel_all). | **Yes**, but separation is intrinsic | Same reasoning. **Keep.** |
| `read_reference_datum` walks `tx.reference_inputs` 1× via `list.filter`. | No | n/a |

## Branch Ordering Review

| Site | Current order | Proposed | Equivalence |
|---|---|---|---|
| `fee_contract.spend` (PayMixFee) | (1) `is_unit_optional(datum)` (2) `read_reference_datum` (3) `list.find(own_input)` (4) cast & hash check (5) `validate_pay_mix_fee`'s redeemer-Mix gate (6) input fold | After H1: (1) `is_unit_optional` (2) `read_reference_datum` (3) **redeemer-Mix gate** (4) single-pass input fold (which captures own input + mix/fee counts) | Owner-redeemer attacker txs reject *before* any input walk (today: walk first, gate second). Honest tx: identical accept set. |
| `mix_box.spend` | (1) `list.find(own_input)` (2) match typed Datum (3) soft-decode (4) `pairs.has_key` | After H2: (1) match `_datum: Option<Data>` (2) soft-decode (3) `list.find(own_input)` only on well-formed (4) match typed Datum (5) `pairs.has_key` | Same accept set. Recovery cases skip `list.find`; hot path identical cost. |
| `mix_logic.validate_mix` | (1) `n = list.length(mix_inputs)` (2) `expect n >= 2` (3) `expect list.length(proofs) == n` (4) walk_outputs (5) verify | unchanged | The `expect n <= 255` for the header prefix is currently *after* walk_outputs, but moving it earlier saves only constant work; keep current order (current matches the documented "structural pre-checks → ctx build → proofs" order in the source comment). |
| `validate_pay_mix_fee` | After redeemer-Mix gate: input fold → fee_outputs filter → ADA-only checks → `is_unit_inline_datum` → `fee_in - fee_out == self.fee` → `self.fee <= max_fee_per_mix_lovelace` | Move `is_unit_inline_datum` *into* the fee_outputs filter callback so a non-unit-datum fee output rejects without the lovelace extract. Saves 1 `expect_ada_only_lovelace` call on attacker txs only. **Marginal; skip.** | n/a |
| `verify_pre` per branch | scalar_mul ×4, point_add ×2, point_equal ×2 (`&&`-chained) | Computing `lhs1, rhs1` is strict before the `&&`. Restructuring with `if` could lazy lhs1/rhs1 on a failed lhs0/rhs0 check — saves work on **invalid proofs only**. Honest tx unchanged. **Skip.** | n/a |

## Datum/Redeemer Optimization Review

- **`mix_box`** `_datum: Option<Data>` is currently underscored and
  unused; H2 promotes it to load-bearing. Tests must follow.
- **`mix_logic` `MixLogicRedeemer`** — two-constructor tagged union
  (`Owner` vs `Mix`). Validator does early redeemer dispatch; cheap.
  No redundant decode.
- **`fee_contract` `FeeRedeemer`** — `PayMixFee` / `Replenish`
  constructors. Cheap dispatch.
- **`MixDatum`** — 2-field record (a, b: ByteArray). The strict variant
  (`decode_mix_datum_strict`) is used for outputs (M4.6 §3) — already
  optimal. The soft variant (`try_decode_well_formed_data`) does
  `is_constr` + `un_constr_data` + `is_bytes` + `un_b_data` × 2 +
  length checks + inequality. ~12 builtins per call.

  **Possible micro-opt**: for the 5-way Plutus Data shape dispatch in
  `try_decode_well_formed_data`, replacing the
  `if is_constr(d) { un_constr_data(d) … }` pattern with a single
  `choose_data(d, k_constr, k_map, k_list, k_int, k_bytes)` would save
  one `choose_data` builtin per call. **However**, M4.5 §10 documents
  the laziness blocker: Aiken-compiled UPLC evaluates all five branches
  strictly, which would call `un_constr_data` on non-Constr data and
  abort the script — defeating the soft-fail. **Skip until Aiken
  exposes lazy `choose_data`.**

- **`ReferenceDatum`** — 5-field record after the M4.5 cleanup. No
  reorder needed; reading happens via the typed cast.

## Asset/Value Optimization Review

- **`expect_ada_only_lovelace`** ([`value.ak:45-52`](../contracts/lib/lovejoin/value.ak#L45-L52)):
  optimal. One `to_dict |> dict.to_pairs` walk + canonical-shape
  destructure. Reject set: empty value, extra policies, non-`""`
  asset name, multiple ada entries, anything not exactly
  `[Pair(ada_policy_id, [Pair("", n)])]`.
- **`from_lovelace(denom_lovelace)` + `serialise_data` cached as
  `denom_value_bytes`** — already optimal (M4.6 §1).
- **`output_at_script` / `input_at_script` / `output_at_fee` / `input_at_fee`**
  — single field projection + bytearray equality. Cannot be cheaper.
  All four are tiny enough that Aiken inlines them (verify in compiled
  UPLC if uncertain).
- **`assets.quantity_of(input.output.value, ref_nft_policy, ref_nft_name)`**
  in `holds_reference_nft` — walks the value's dict to find the policy,
  then the asset name. Reference-input values are tiny (1–2 entries),
  so this is fine. No cheaper alternative without flattening.

## Minting Policy Optimization Review

`one_shot_mint` is bootstrap-only (single lifetime invocation per
protocol). Optimisations here have zero per-Mix-tx impact. The current
implementation:

- `list.any(self.inputs, fn(input) { input.output_reference == seed })` — single pass, correct.
- `assets.tokens(self.mint, policy_id)` — extracts the policy's token
  dict.
- `dict.size(tokens_under_policy) == 1` + `dict.foldr` summing
  quantities + `total_minted == 1` — two passes over what is at most a
  1-entry dict. **Not worth fusing.**

If a future bootstrap script ever wanted to mint many one-shot NFTs in
one tx, the two passes would matter. Not the case today.

## Cryptographic Optimization Review

The dominant per-tx cost is structurally:

- `2N + 2 × N²` ≈ **2N² G1 uncompresses** (statements pre-uncompressed at
  M4.5; remainder is `t0`/`t1` per branch).
- `4N²` G1 scalar muls.
- `2N²` G1 adds.
- `2N²` G1 equals.
- `N` blake2b (one per `verify_pre`).
- `1` blake2b for the Mix `ctx`.
- `N` G1 a/b uncompresses (per-input; cannot share — each input is unique).

What **cannot** be reduced without an algorithmic change:

- The 4N² scalar muls (Cramer-Damgård OR has 2 equations × N branches × N inputs).
- The 2N² uncompresses for `t0`/`t1` (each per-branch commitment is unique to its branch *and* unique per input, so no caching is possible).
- The 2N² equals (one per equation).

What **could** be reduced with an algorithmic change (rejected for
M4.5; documented for completeness):

- **Random-linear-combination check** — collapse the two
  `point_equal(lhs_k, rhs_k)` per branch into one
  `point_equal(lhs_combined, rhs_combined)` after a transcript-derived
  scalar α. Saves N² scalar muls + N² point_adds + N² point_equals
  per Mix tx. **Soundness re-derivation required** (Schwartz–Zippel
  argument needs α to be transcript-bound and unpredictable to the
  prover). Audit-grade work; rejected for the M4.5 / M4.6 passes;
  recommend deferring to a formal-methods pass in a later milestone.

What **is already optimal** in this codebase:

- Statements pre-uncompressed once per tx (saves N² uncompresses).
- FS-hash header prefix hoisted once per tx.
- `denom_value_bytes` cached once per tx.
- Single-pass `walk_outputs` in `validate_mix`.
- No redundant hashing.
- No redundant point/scalar parsing inside the inner loop.

## Hyperstructure Escape Hatch Review

Per the audit brief: every always-true branch is intentional. Listed
here with a "can it be cheaper?" verdict.

| Location | Branch | Purpose | Current cost | Cheaper? | Recommendation |
|---|---|---|---|---|---|
| [`mix_box.ak:64`](../contracts/validators/mix_box.ak#L64) | `Some(_md) -> { … } / None -> True` (after `try_decode_well_formed_data`) | Inline-but-not-well-formed `MixDatum` (a==b, wrong length, wrong constructor) → recovery. | After H2: ~2 builtins past the soft-decode (cheap). | **Yes — already cheaper after H2** (skips `list.find`). | Land H2. |
| [`mix_box.ak:67`](../contracts/validators/mix_box.ak#L67) | `_ -> True` for `NoDatum`/`DatumHash(_)` | Datum-less or hash-stored UTxO at mix script → recovery (F-2). | Currently pays `list.find` + Datum match before reaching this arm. | **Yes — H2 makes NoDatum free**. DatumHash still pays the `list.find` (F-2 disambiguation). M5 (architectural) eliminates that too, with a Rule-2 semantics shift. | H2 now; M5 only with audit blessing. |
| [`fee_contract.ak:53`](../contracts/validators/fee_contract.ak#L53) | `if !is_unit_optional(datum) { True }` | Non-unit datum at fee script → recovery (parked UTxO sweepable). | One `is_unit_optional` call — already minimal. | No. | Keep as-is. |
| [`mix_logic.ak:296-306`](../contracts/validators/mix_logic.ak#L296-L306) (`collect_well_formed_mix_inputs`) | Bad-datum mix-script inputs are silently dropped. | Inputs with bad/missing datums "exit via `mix_box`'s True path" — they're never counted in the proof set. | One filter pass; M1 reduces it slightly. | Marginally (M1). | Apply M1; keep semantics. |
| [`reference_holder.ak:29`](../contracts/validators/reference_holder.ak#L29) | `False` | Always-False spend (defense-in-depth: the reference UTxO is read-only via `reference_inputs`; nothing should ever spend it). | Returns False immediately. | n/a — already a constant. | Keep. |

None of these branches change semantics under any optimisation in this
audit.

## Top 10 Optimization Actions (ranked by expected per-Mix-tx CPU savings)

1. **H1** — `fee_contract.PayMixFee` single-pass input fold + early
   redeemer-Mix gate. Saves ≈ 5–12 M CPU. **Land first.**
2. **H3** — drop redundant `bytearray.length(left) == 32` in `xor32`.
   Saves ≈ 6–25 M CPU. **Self-contained, low risk.**
3. **H2** — `mix_box.spend` short-circuit on `_datum`. Saves ≈ 0–5 M CPU
   (mostly reorders; main value is recovery-path speedup + clarity).
   **Requires test updates** (load-bearing `_datum`).
4. **M3** — `hash` module pre-concatted static prefix. Saves ≈ 0.5 M
   CPU. **Trivial.**
5. ~~**M1** — fuse `list.length` into `collect_well_formed_mix_inputs`.~~
   **Attempted and reverted** (M4.7 implementation pass): both
   hand-recursive and `list.foldr`-with-tuple-acc shapes regressed
   cumulative CPU by 14–24 M. The 2-tuple accumulator's per-step
   alloc+destructure cost exceeds the saved small-list `list.length`
   walk in compiled UPLC. **Do not retry without a UPLC-level
   investigation.**
6. **M4** — `Replenish` single-pass input fold (mirror of H1). Saves
   ≈ 2–3 M CPU per **Deposit** tx (not Mix).
7. **L1** — `bls.scalar_from_bytes` redundant mod (M4.6 §10, blocked on
   stdlib).
8. **M5** — eliminate `mix_box`'s `list.find` by widening
   `mix_logic`'s filter. Saves ≈ 10–35 M CPU per Mix tx **but**
   requires Rule-2 semantics shift. **Defer until next architectural
   review.**
9. **(speculative)** — random-linear-combination OR-branch check.
   Saves N² muls + N² adds + N² equals (≈ 200 M @ N=4, ≈ 800 M @ N=8).
   **Audit-grade soundness work required.** Rejected for M4.5;
   re-evaluate only if N=4 still doesn't fit comfortably after items
   1–6.
10. **(speculative)** — lazy `choose_data` via stdlib upstream PR for
    `try_decode_well_formed_data` & `is_unit_data`. Saves ≈ 1 M per
    soft-decode. Blocked on Aiken evaluation-order verification.

## Patch Plan

1. **Add benchmarks** (no behaviour change, no validator code touched):
   - Add `owner_full_prologue_then_proof_fails_n{1,4,8}` mirrors of the
     `mix_full_prologue_then_proof_fails` family in
     `mix_logic.test.ak`.
   - Add `mix_box_recovery_no_datum_perf`, `mix_box_recovery_malformed_perf`,
     `mix_box_well_formed_inline_perf`, `mix_box_recovery_datum_hash_perf`
     micro-benchmarks (M=8 inputs each).
   - Add `pay_mix_fee_positive_n{3,4,8}` to round out the
     `fee_contract` cost coverage.
   - **Capture baseline CPU/mem** for every test in
     `docs/optimization-audit-2026-04-28-baseline.txt` (or similar) to
     diff against later.
2. **Land H3** (`xor32` length check). Smallest diff, lowest risk.
   Re-run `aiken check`, capture diff.
3. **Land M3** (pre-concatted const prefix). Trivial; bundle in the
   same commit as H3 if the diff is co-located.
4. ~~**Land M1** (fuse `list.length` into collector).~~ **Skip — measured regression**; see §M1 outcome.
5. **Land H1 + M4** (`fee_contract` single-pass folds; one PR). H1
   includes the redeemer-gate-first reorder.
6. **Land H2** (`mix_box._datum` reorder). **Update all `mix_box.test.ak`
   tests to pass the resolved data through `_datum: Option<Data>`** —
   this is the riskiest step in the audit because it surfaces a
   previously-unused validator parameter.
7. **Measure**. The cumulative-suite delta should land in the 6–32 M
   CPU range per the table at top. If anything is regressing, revert
   that step before continuing.
8. **(Optional) Run the M4.6 redeploy operator step**. If the live
   Preprod numbers after items 2–6 still need more headroom, evaluate
   M5 (mix_box-mix_logic asymmetry collapse) or the OR-branch RLC
   speculative item under audit blessing.

The total expected reclaim is **≈ 30 M CPU at N=8**, which is well
below the M4.6 reclaim (≈ 100 M @ N=8) but real and risk-free if H2's
test updates land cleanly. After this audit's items, the Mix validator
is approaching the algorithmic floor of the Cramer-Damgård OR
construction; further gains require a soundness-level redesign or a
stdlib-level change.

## Final Recommendation

The validators are **moderately optimisable**. The cheap structural
wins are 90% booked through M4.5/M4.6. This audit identifies the
remaining ~10%: three small diffs (H1, H3, M3) plus one reorder with
test-file fallout (H2). Worth landing as an M4.7 commit. The bigger
levers (M5 architectural, RLC OR check) are off the table without
audit-committee involvement and are not required by any current
Preprod budget overshoot.

---

## Appendix: Patch sketches

### Patch sketch H1 — `fee_contract.PayMixFee` single-pass fold

```aiken
validator fee_contract(
  reference_nft_policy: PolicyId,
  reference_nft_name: AssetName,
) {
  spend(
    datum: Option<Data>,
    redeemer: FeeRedeemer,
    utxo: OutputReference,
    self: Transaction,
  ) {
    if !is_unit_optional(datum) {
      True
    } else {
      let reference_datum =
        read_reference_datum(self, reference_nft_policy, reference_nft_name)
      when redeemer is {
        PayMixFee -> validate_pay_mix_fee(reference_datum, self, utxo)
        Replenish -> validate_replenish(reference_datum, self, utxo)
      }
    }
  }
  else(_) { fail }
}

fn validate_pay_mix_fee(
  reference_datum: ReferenceDatum,
  self: Transaction,
  utxo: OutputReference,
) -> Bool {
  // Gate first — Owner-redeemer attacker txs reject before any walk.
  expect Some(mix_logic_redeemer_data) =
    pairs.get_first(
      self.redeemers,
      Withdraw(Script(reference_datum.mix_logic_script_hash)),
    )
  expect mix_logic_redeemer: MixLogicRedeemer = mix_logic_redeemer_data
  expect Mix { .. } = mix_logic_redeemer

  let own_hash = reference_datum.fee_script_hash

  // Single-pass fold:
  //  - locate own_input (by output_reference) and capture its lovelace,
  //  - count mix-script inputs (need >= 2),
  //  - count fee-script inputs (need == 1).
  let (mix_count, fee_count, maybe_own_lovelace) =
    list.foldl(
      self.inputs,
      (0, 0, None),
      fn(input, acc) {
        let (m, f, own) = acc
        if input.output_reference == utxo {
          // own_input. Defense-in-depth: the input must be at the fee
          // script (Cardano routes spends here only if the credential
          // matches, but the cross-check against reference_datum's
          // recorded hash protects against a parameter mismatch).
          expect Script(h) = input.output.address.payment_credential
          expect h == own_hash
          let own_lovelace = expect_ada_only_lovelace(input.output.value)
          (m, f + 1, Some(own_lovelace))
        } else if input_at_script(input, reference_datum.mix_script_hash) {
          (m + 1, f, own)
        } else if input_at_fee(input, own_hash) {
          (m, f + 1, own)
        } else {
          acc
        }
      },
    )
  expect Some(fee_in_lovelace) = maybe_own_lovelace
  expect mix_count >= 2
  expect fee_count == 1

  let fee_outputs =
    self.outputs |> list.filter(fn(output) { output_at_fee(output, own_hash) })
  expect [fee_output] = fee_outputs
  let fee_out_lovelace = expect_ada_only_lovelace(fee_output.value)

  and {
    is_unit_inline_datum(fee_output.datum),
    fee_in_lovelace - fee_out_lovelace == self.fee,
    self.fee <= reference_datum.max_fee_per_mix_lovelace,
  }
}

fn validate_replenish(
  reference_datum: ReferenceDatum,
  self: Transaction,
  utxo: OutputReference,
) -> Bool {
  let own_hash = reference_datum.fee_script_hash
  let (fee_count, maybe_own_lovelace) =
    list.foldl(
      self.inputs,
      (0, None),
      fn(input, acc) {
        let (f, own) = acc
        if input.output_reference == utxo {
          expect Script(h) = input.output.address.payment_credential
          expect h == own_hash
          (f + 1, Some(expect_ada_only_lovelace(input.output.value)))
        } else if input_at_fee(input, own_hash) {
          (f + 1, own)
        } else {
          acc
        }
      },
    )
  expect Some(fee_in_lovelace) = maybe_own_lovelace
  expect fee_count == 1

  let fee_outputs =
    self.outputs |> list.filter(fn(output) { output_at_fee(output, own_hash) })
  expect [fee_output] = fee_outputs
  let fee_out_lovelace = expect_ada_only_lovelace(fee_output.value)

  and {
    is_unit_inline_datum(fee_output.datum),
    fee_out_lovelace > fee_in_lovelace,
  }
}
```

### Patch sketch H2 — `mix_box.spend` short-circuit on `_datum`

```aiken
validator mix_box(mix_logic_script_hash: ScriptHash) {
  spend(
    datum: Option<Data>,
    _redeemer: Data,
    utxo: OutputReference,
    self: Transaction,
  ) {
    when datum is {
      None -> True
      Some(d) ->
        when try_decode_well_formed_data(d) is {
          None -> True
          Some(_md) -> {
            // F-2 disambiguation: only InlineDatum mix-script inputs are
            // members of the privacy pool. DatumHash with valid resolved
            // data must take the recovery path.
            expect Some(own_input) =
              list.find(self.inputs, fn(input) { input.output_reference == utxo })
            when own_input.output.datum is {
              InlineDatum(_) -> {
                let mix_logic_credential: Credential = Script(mix_logic_script_hash)
                pairs.has_key(self.withdrawals, mix_logic_credential)
              }
              _ -> True
            }
          }
        }
    }
  }
  else(_) { fail }
}
```

### Patch sketch H3 — `xor32` simplification

```aiken
fn xor32(left: ByteArray, right: ByteArray) -> ByteArray {
  // The `False` padding flag asserts equal length on the builtin
  // itself; `acc` is always 32 bytes by induction (seed is `zero32`,
  // and xor preserves length when lengths match).
  builtin.xor_bytearray(False, left, right)
}
```

### Patch sketch M1 — `collect_well_formed_mix_inputs_with_count`

```aiken
fn collect_well_formed_mix_inputs_with_count(
  self: Transaction,
  mix_script_hash: ByteArray,
) -> (List<MixDatum>, Int) {
  do_collect(self.inputs, mix_script_hash, [], 0)
}

fn do_collect(
  inputs: List<Input>,
  mix_script_hash: ByteArray,
  acc: List<MixDatum>,
  n: Int,
) -> (List<MixDatum>, Int) {
  when inputs is {
    [] -> (list.reverse(acc), n)
    [input, ..rest] ->
      if input_at_script(input, mix_script_hash) {
        when try_decode_well_formed_inline(input.output.datum) is {
          Some(md) -> do_collect(rest, mix_script_hash, [md, ..acc], n + 1)
          None -> do_collect(rest, mix_script_hash, acc, n)
        }
      } else {
        do_collect(rest, mix_script_hash, acc, n)
      }
  }
}
```

Caller in `mix_logic.withdraw`:

```aiken
let (mix_inputs, n) =
  collect_well_formed_mix_inputs_with_count(self, reference_datum.mix_script_hash)
when redeemer is {
  Owner { proofs } -> validate_owner(self, reference_datum, mix_inputs, proofs, n)
  Mix   { proofs } -> validate_mix  (self, reference_datum, mix_inputs, proofs, n)
}
```

with `validate_owner(_, _, _, _, n)` and `validate_mix(_, _, _, _, n)`
accepting `n` directly instead of recomputing it.

### Patch sketch M3 — pre-concatted static prefix

```aiken
// In hash.ak — domain || statement_id_sigma_or_n, computed at compile time.
pub const sigma_or_static_prefix: ByteArray =
  domain_tag_v1 |> bytearray.concat(statement_id_sigma_or_n)

pub fn fs_hash_sigma_or_header_const_prefix(n: Int) -> ByteArray {
  sigma_or_static_prefix
    |> bytearray.concat(bytearray.from_int_big_endian(n, 1))
}
```

(If Aiken does not const-eval `bytearray.concat` in `pub const`, inline
the literal: `pub const sigma_or_static_prefix = #"6c6f76656a6f696e2f7369676d616a6f696e2f76312f03"` and add a
compile-time test asserting equality with the derived form.)

## Final benchmark report (template — measure locally)

| Validator/Policy | Branch | Before CPU | After CPU | CPU Saved | Before Mem | After Mem | Mem Saved | Notes |
|---|---|---:|---:|---:|---:|---:|---:|---|
| `mix_logic` | Mix prologue, N=2 (`mix_full_prologue_then_proof_fails_n2`) | measure | measure | measure | measure | measure | measure | H3 + M1 + M3 cumulative. |
| `mix_logic` | Mix prologue, N=4 | measure | measure | measure | measure | measure | measure | |
| `mix_logic` | Mix prologue, N=8 | measure | measure | measure | measure | measure | measure | |
| `mix_logic` | Owner prologue, N=4 (NEW benchmark) | n/a | measure | n/a | n/a | measure | n/a | M1 + new test. |
| `mix_box` | well-formed inline (NEW benchmark) | measure | measure | ≈ 0 | measure | measure | ≈ 0 | H2 keeps hot path equal. |
| `mix_box` | NoDatum recovery (NEW benchmark) | measure | measure | measure | measure | measure | measure | H2 skips `list.find`. |
| `mix_box` | malformed-inline recovery (NEW benchmark) | measure | measure | measure | measure | measure | measure | H2 skips `list.find`. |
| `mix_box` | DatumHash recovery (NEW benchmark) | measure | measure | measure | measure | measure | measure | Hot-path-equivalent (still walks). |
| `fee_contract` | PayMixFee, N=4 (NEW benchmark) | n/a | measure | n/a | n/a | measure | n/a | H1. |
| `fee_contract` | PayMixFee, N=6 | measure | measure | measure | measure | measure | measure | H1. |
| `fee_contract` | PayMixFee Owner-attacker (`pay_mix_fee_rejects_owner_redeemer_n6`) | measure | measure | measure | measure | measure | measure | H1's redeemer-first reorder; expected sharp drop. |
| `fee_contract` | Replenish positive | measure | measure | measure | measure | measure | measure | M4. |
| (Whole suite) | `aiken check` cumulative | measure | measure | measure | measure | measure | measure | The safety net. |

Headline numbers expected (per perf cost model in
[`docs/perf-m4-5-audit.md`](perf-m4-5-audit.md)):

- N=2: ≈ 6 M CPU saved per Mix tx.
- N=4: ≈ 13 M CPU saved per Mix tx.
- N=8: ≈ 32 M CPU saved per Mix tx.

If actual numbers are smaller, H3 (the easiest item) is still
worth landing on its own. If they are notably larger, run the
benchmarks once more with `--trace-level verbose` to confirm no
unintended branch inlining is responsible.
