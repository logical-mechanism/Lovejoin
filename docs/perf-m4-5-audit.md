# M4.5 — Mix-tx validator audit

Senior-engineering review of the Aiken validators with a focus on Mix-tx
CPU/mem/script-size for the M4.5 redeploy. Goal: identify the smallest set
of changes that lifts `max_n` past 3 on Preprod.

## Outcomes (2026-04-28)

Implemented and merged on the M4.5 branch:

| Item | Status | Notes |
|------|--------|-------|
| 1 + 5 — single-pass `validate_mix` | **Deferred** | Tried both tail-recursive and `list.foldr` rewrites; both regressed the all-negative `mix_logic.test.ak` suite by 160–330M CPU. Positive-path improvement is plausible but unverifiable without Preprod measurement. Revisit after the M4.5 redeploy + recalibration. |
| 2 — drop wrapper-list allocs in `verify_pre` | **Shipped** | -2.37B CPU, -7.36M mem cumulatively across the sigma_or KAT suite (combined with item 3). Per-tx ~390M CPU saved at N=8. |
| 3 — drop `list.length` redundancy in `verify_pre` | **Shipped** | Combined into the item-2 commit's measurement. |
| 4 — `list.count` over `list.filter` in fee_contract | **Shipped** | Net negative CPU; tiny mem +1.6k on N=6 fee_contract path is rounding error. |
| 6 — drop `fee_shard_target` from `ReferenceDatum` | **Shipped** | Coordinated SDK + backend + bootstrap script + stress-tests change. Schema break vs. M4 deployment. |
| 7 — move `dhtuple` / `fs_hash_dh_tuple` to test-only | **Skipped** | Pure code-org cleanup; Aiken tree-shakes unused pub functions, so no on-chain bytes change. Out of scope for an "if we can prove CPU/mem savings" pass. |
| 8 — hoist `ada_only` to shared `lovejoin/value` | **Shipped** | Pure refactor; no on-chain cost change. |
| 9 — unify `parallel_all` / `pairs_match_and_all` via generics | **Skipped** | Speculative; no measurable CPU win. |
| 10 — soft-decode without redundant `choose_data` round-trip | **Skipped** | Aiken's `choose_data` is strict in all branches in compiled UPLC; the laziness this would have required is not safe. |
| 11 — combine OR-branch equality checks into one | **Skipped** | Speculative; large soundness re-derivation; out of scope. |
| 12 — drop scalar canonical-length check | **Rejected** | Would weaken validation. |
| 13 — skip per-input datum re-decode | **Rejected** | Different UPLC scopes; structurally required for Rule 2. |

See [`docs/perf.md`](perf.md) §"M4.5 — validator optimisation pass" for
the per-N delta tables.

### What's left to close M4.5

The code work is done; the milestone closes on the operator step:
re-bootstrap on Preprod with the optimised validators, run
`stress-tests/max-n-calibration.ts`, bump `max_n` in
`config/network.preprod.json` (target ≥ 4), re-run the integration
suite. Whether item 1's positive-path single-pass restructure pulls
its weight on chain is the next question for after that — the
Preprod numbers will quantify the gap.

Cost model (rough, from `docs/perf.md` + observation):

| Op | CPU |
|---|---|
| `bls12_381_g1_uncompress` | 25–30M |
| `bls12_381_g1_scalar_mul` | ~10M |
| `blake2b_256` (typical preimage) | ~4M |
| `bls12_381_g1_add` / `_equal` | ~1M |
| ledger list traversal / pattern match | ~1M per step |

Per Mix tx the dominant cost is **2N²** uncompresses + **4N²** scalar muls
inside [`sigma_or.verify_pre`](../contracts/lib/lovejoin/sigma_or.ak), plus
a per-tx constant of ~7 traversals over the prefix-N output list inside
[`mix_logic.validate_mix`](../contracts/validators/mix_logic.ak). The
already-shipped pre-uncompress of statement points dropped statement
uncompresses from N² to N; that alone made N=3 fit. The remaining
constants are what we can attack.

Items are ordered by **cost-impact / risk** ratio. Each item lists every
field requested in the audit brief.

## Legend

- **Behaviour change**: does the validator accept/reject a different
  set of txs after the change? "No" means we re-prove equivalence with
  positive + negative tests; "Yes" means the spec or off-chain emit-side
  must move with the validator.

---

## 1. Single-pass over `prefix_outputs` in `validate_mix`

- **Location**: [`contracts/validators/mix_logic.ak:102-165`](../contracts/validators/mix_logic.ak#L102-L165)
- **Current issue**: the N mix-outputs list is walked **seven times** —
  `list.take` (1), `list.drop` (1, also walks the head), `list.all`
  prefix at-script (2), `list.all` tail !at-script (3), `list.map`
  `check_and_decode_mix_output` (4), `compute_mix_ctx` datums foldl (5),
  `compute_mix_ctx` values foldl (6), `precompute_statements`'s
  intermediate `list.map` (7). Five of those allocate intermediate lists
  of size N.
- **Why it costs**: each traversal is O(N) ledger ops + an N-element
  list allocation. At N=4 that's ~28 list ops + 5 allocs we don't need;
  at N=8 it's ~56 + 5. Each allocation is ~16 bytes constructor
  overhead per cell. Mem-pressure compounds when this runs inside the
  per-tx `mix_logic` step.
- **Recommended change**: replace the `list.take` / `list.drop` /
  `list.all` / `list.map` / `compute_mix_ctx` cascade with **one
  recursive walk** over `self.outputs` that:
  1. Counts indices 0..N-1: validate `output_at_script`, `ada_only`,
     `lovelace_of == denom_lovelace`, decode `MixDatum`, then build the
     `DHTupleStatementPt` (uncompressing `a'_i` / `b'_i` once) and
     accumulate `serialise_data(datum)` and `serialise_data(value)`
     into two `ByteArray` accumulators in canonical order.
  2. For indices ≥ N: validate **not** `output_at_script`.
  Return `(statements, datums_acc, values_acc)`. Then concat
  `datums_acc || values_acc || mix_script_hash` and `blake2b_256` once.
  Drops 6 traversals → 1; drops 5 N-element list allocations to 1
  (the statements list, which is needed by the verifier loop).
- **Behaviour change**: No. The byte layout of the FS preimage stays
  identical (datums in order 0..N-1 then values in order 0..N-1 then
  mix_script_hash). All structural rules stay enforced.
- **Risk level**: Medium. The function gets denser; the order of
  failures changes (a denom mismatch on output 2 now aborts before
  the tail's at-script check).
- **Test cases needed**:
  - Existing positive tests at N ∈ {2, 3, 4} still pass byte-identical
    `ctx` (compare against a captured pre-change baseline preimage —
    add a `compute_mix_ctx_canonical_bytes` test fixture).
  - Negative tests: bad denom on each of positions 0..N-1; non-mix
    output at each of positions 0..N-1; mix output at each of
    positions N..end; bad datum at each prefix position. All currently
    in `mix_logic.test.ak` — re-run.
  - Integration: `mix-n2`, `mix-at-max-n`, `full-lifecycle`.
- **Priority**: High.
- **Effort**: Medium. ~80–100 lines of validator code touched, no
  off-chain change.

---

## 2. Drop redundant intermediate lists in `sigma_or.verify_pre`

- **Location**: [`contracts/lib/lovejoin/sigma_or.ak:121-133`](../contracts/lib/lovejoin/sigma_or.ak#L121-L133)
- **Current issue**: `verify_pre` builds two N-element wrapper lists
  (`stmt_for_hash`, `commitments_for_hash`) just to feed
  `hash.fs_hash_sigma_or`, which expects `SigmaOrStatementBranch` /
  `SigmaOrCommitment`. The constructors are isomorphic to projections
  of `DHTupleStatementPt` and `SigmaOrBranch`.
- **Why it costs**: 2 × N-list `list.map` allocations per `verify_pre`
  call. With N proofs per Mix tx that's **2N²** wrapper allocs we
  don't need. At N=4 = 32 unnecessary allocs; at N=8 = 128.
- **Recommended change**: extend
  [`hash.fs_hash_sigma_or`](../contracts/lib/lovejoin/hash.ak#L80) to
  accept the original lists and projection functions, OR add a
  parallel `fs_hash_sigma_or_pre(a, b, statements: List<DHTupleStatementPt>,
  branches: List<SigmaOrBranch>, ctx)` that walks the same lists
  directly using the `.ap` / `.bp` / `.t0` / `.t1` fields. The hash
  preimage is byte-identical because we read the same bytes.
- **Behaviour change**: No. Same preimage bytes, same hash.
- **Risk level**: Low. Pure refactor — two wrapper types around
  identical bytes are merged into accessor calls.
- **Test cases needed**:
  - `encoding_parity_kat.test.ak`'s sigma-OR cases must still match
    the Rust + TS preimage byte-for-byte across N ∈ {2, 3, 4, 6, 8}.
  - `sigma_or_kat.test.ak` end-to-end verify still passes.
- **Priority**: High.
- **Effort**: Small. ~20 lines added, ~6 removed.

---

## 3. Drop `list.length` redundancy inside `verify_pre`

- **Location**: [`contracts/lib/lovejoin/sigma_or.ak:117-119`](../contracts/lib/lovejoin/sigma_or.ak#L117-L119)
- **Current issue**: `verify_pre` does `list.length(statements)` and
  `list.length(proof.branches)` per call. These are O(N) traversals
  each. The `parallel_all` call below already enforces equal length
  by returning False on the size-mismatch base case, so the explicit
  comparison is redundant once we have `parallel_all`.
- **Why it costs**: per-tx, that's `2 × N × N` = `2N²` list-walk steps
  before any verification work starts. At N=8 that's ~128 wasted
  steps.
- **Recommended change**: replace the three lines with a single O(1)
  pattern guard ensuring `n ≥ 2`:
  ```aiken
  expect [_, _, ..] = statements
  ```
  Then call `parallel_all(statements, proof.branches, …)`. If lengths
  differ, `parallel_all` falls into its `_ -> False` arm and the
  validator rejects — same outcome as the pre-change `expect`.
- **Behaviour change**: No. Both pre-change and post-change reject
  on length mismatch; the difference is `expect`-fail vs. `False`
  return, both of which fail the script.
- **Risk level**: Low. Subtle: the failure surfaces as "validator
  returned False" instead of "validator aborted with X" — same chain
  outcome.
- **Test cases needed**:
  - Length-mismatch negative test: feed a `proof.branches` of length
    N-1 and assert rejection (already in `sigma_or_kat.test.ak`?
    if not, add).
  - `n == 1` negative test (singleton statement list); confirms the
    new `[_, _, ..]` pattern guard.
  - `n == 0` negative test.
- **Priority**: Medium.
- **Effort**: Small. ~5 lines.

---

## 4. Replace `list.filter` with `list.count` in `fee_contract` input check

- **Location**: [`contracts/validators/fee_contract.ak:91-93`](../contracts/validators/fee_contract.ak#L91-L93) and [`:120-122`](../contracts/validators/fee_contract.ak#L120-L122)
- **Current issue**: `fee_inputs = … |> list.filter(…)` followed by
  `expect [_only_fee_input] = fee_inputs`. We never use the filtered
  list; we only need to assert "exactly one fee-script input."
- **Why it costs**: the `list.filter` allocates an intermediate list
  (typically size 1) per validator run. `fee_contract` runs once per
  Mix tx, so this is one alloc — small absolute, but trivially
  removable.
- **Recommended change**:
  ```aiken
  let fee_input_count =
    self.inputs
      |> list.count(fn(input) { input_at_fee(input, own_hash) })
  expect fee_input_count == 1
  ```
  Same for the symmetric `fee_inputs` filter in `validate_replenish`.
  Note: `fee_outputs` MUST stay as a filter because we use `fee_output`
  downstream — leave it.
- **Behaviour change**: No.
- **Risk level**: Low.
- **Test cases needed**: existing fee_contract positive + negative
  tests (zero / two / three fee inputs each rejected).
- **Priority**: Low.
- **Effort**: Small. ~6 lines.

---

## 5. Single-fold ctx accumulator in `compute_mix_ctx` (subsumed by item 1)

- **Location**: [`contracts/validators/mix_logic.ak:177-206`](../contracts/validators/mix_logic.ak#L177-L206)
- **Current issue**: two `list.foldl` passes over `outputs` — one for
  datums, one for values. The second concat (`datums_bytes |>
  bytearray.concat(values_bytes) |> bytearray.concat(...)`) does one
  extra full copy of `datums_bytes`.
- **Why it costs**: one extra O(N) list traversal + an extra full-buffer
  concat. At N=4 with 48-byte datum bytes, that's ~200 bytes copied
  twice instead of once.
- **Recommended change**: subsumed by item 1. If item 1 ships, this is
  done. If item 1 is rejected as too invasive, the cheaper fallback is
  a single `list.foldr` returning `(datums_acc, values_acc)` as a tuple
  — but that requires tuple allocation per element which may net out.
  The cleanest fallback is a hand-recursive function.
- **Behaviour change**: No (preimage byte-identical).
- **Risk level**: Low (as a standalone change).
- **Test cases needed**: ctx-byte parity test against captured
  baseline.
- **Priority**: Medium (only if item 1 is split).
- **Effort**: Small.

---

## 6. Drop `fee_shard_target` from `ReferenceDatum`

- **Location**: [`contracts/lib/lovejoin/types.ak:34`](../contracts/lib/lovejoin/types.ak#L34)
- **Current issue**: `fee_shard_target` is in the on-chain
  `ReferenceDatum` but is read by **no validator** (verified by grep
  across `validators/` and `lib/`). It's pure off-chain coordination
  state. The decision to drop it was already taken
  (`memory/project_fee_shard_target_removal.md`) and explicitly
  blocked on a redeploy — which M4.5 is.
- **Why it costs**: every `read_reference_datum` decode walks all
  `ReferenceDatum` fields via `expect parsed: ReferenceDatum =
  datum_data`. Removing one Int field shaves one decode step from
  every Mix and Fee tx. Also shaves a few CBOR bytes from the
  reference UTxO datum (the only reason we'd care: bigger reference
  inputs cost more script-rent over time — irrelevant on Cardano,
  but tidiness).
- **Recommended change**: remove the field from
  [`types.ak:28-35`](../contracts/lib/lovejoin/types.ak#L28-L35); update
  the bootstrap script that emits the reference datum
  ([`infra/bootstrap/02-mint-and-lock.sh`](../infra/bootstrap)); update
  off-chain references in `offchain/src/tx/params.ts`.
- **Behaviour change**: Yes — a stricter on-chain datum schema. Old
  reference UTxOs (the M4 deployment) won't parse. M4.5 is a fresh
  bootstrap, so this is the right time. The CLAUDE.md already calls
  this out: `fee_shard_target … is similarly off-chain coordination —
  kept on-chain today but slated for removal post-redeploy`.
- **Risk level**: Medium. The change must land in the bootstrap path
  + SDK + reference-datum encoder simultaneously, otherwise the
  bootstrap will panic.
- **Test cases needed**:
  - `aiken check` (validator tests use fixtures from
    `test_fixtures.ak` — update the fixture).
  - `read_reference_datum` happy path with the shorter datum.
  - Bootstrap dry-run on Preprod with the new datum, then a real Mix
    tx submission.
- **Priority**: Medium. The CPU win is small (~1 step per
  validator run); the value is "redeploy hygiene" — we're paying the
  redeploy cost regardless, so capture this cleanup now.
- **Effort**: Small. Validator + bootstrap + 1 SDK helper.

---

## 7. Move `dhtuple.ak` + `fs_hash_dh_tuple` to test-only

- **Location**: [`contracts/lib/lovejoin/dhtuple.ak`](../contracts/lib/lovejoin/dhtuple.ak), [`contracts/lib/lovejoin/hash.ak:42-62`](../contracts/lib/lovejoin/hash.ak#L42-L62)
- **Current issue**: `dhtuple.verify` and `hash.fs_hash_dh_tuple` are
  imported only by `*.test.ak` files and by `dhtuple.ak` itself. No
  validator references them. The N-way OR proof inlines its DH-tuple
  equations; standalone DH-tuple verification is dead on chain.
- **Why it costs**: nothing on the chain — Aiken tree-shakes unused
  pub functions out of compiled `*.plutus`. Pure code-organization /
  audit-readability concern: the canonical scripts shouldn't pull in
  validators that aren't reachable from any `validator { … }` block.
- **Recommended change**: relocate to a `lib/lovejoin/test_only/`
  subdir or fold into `test_fixtures.ak` so the prod modules and the
  test modules are visibly partitioned. Optionally: keep `dhtuple.ak`
  as a documented spare-tire (paper §5 could call for it later) but
  add a `// test-only / not deployed` banner.
- **Behaviour change**: No. UPLC bytes don't change.
- **Risk level**: Low.
- **Test cases needed**: `aiken check` still green after the move.
- **Priority**: Low.
- **Effort**: Small.

---

## 8. Hoist `ada_only` to a shared module

- **Location**: duplicated in [`mix_logic.ak:231-237`](../contracts/validators/mix_logic.ak#L231-L237) and [`fee_contract.ak:141-147`](../contracts/validators/fee_contract.ak#L141-L147)
- **Current issue**: identical 7-line definitions in two files.
- **Why it costs**: nothing on chain (Aiken inlines small private
  functions identically); pure duplication-debt.
- **Recommended change**: move to `lib/lovejoin/value.ak` (new) or
  extend `mixbox.ak`/`fee.ak` with a `pub fn ada_only`.
- **Behaviour change**: No.
- **Risk level**: Low.
- **Test cases needed**: existing native-asset rejection tests in
  both validator suites.
- **Priority**: Low.
- **Effort**: Small.

---

## 9. (Speculative) Unify `parallel_all` and `pairs_match_and_all` via parametric polymorphism

- **Location**: [`sigma_or.ak:172-187`](../contracts/lib/lovejoin/sigma_or.ak#L172-L187) and [`mix_logic.ak:243-258`](../contracts/validators/mix_logic.ak#L243-L258)
- **Current issue**: two private hand-written zip-and-all helpers,
  same logic, different element types.
- **Why it costs**: ~20 lines of duplicated source. Compiled UPLC: no
  obvious cost difference (Aiken monomorphises).
- **Recommended change** (speculative — Aiken's generics are limited;
  must verify): write one `pub fn pairs_all<a, b>(xs: List<a>, ys:
  List<b>, pred: fn(a, b) -> Bool) -> Bool` in a shared module. If
  Aiken's monomorphisation introduces extra wrapping, skip this
  cleanup. Otherwise cleanup ~20 lines.
- **Behaviour change**: No.
- **Risk level**: Low.
- **Test cases needed**: full validator test suite re-run.
- **Priority**: Low.
- **Effort**: Small. Mark **speculative** until Aiken's generic
  expansion is confirmed cost-neutral.

---

## 10. (Speculative) Soft-decode helpers without redundant `choose_data` round-trip

- **Location**: [`mixbox.ak:64-80, 103-109`](../contracts/lib/lovejoin/mixbox.ak#L64-L109), [`fee.ak:48-58`](../contracts/lib/lovejoin/fee.ak#L48-L58)
- **Current issue**: `try_decode_well_formed_data` does
  `is_constr(value)` (a `choose_data` call) and then
  `un_constr_data(value)` — which itself rejects non-Constr data.
  Same pattern in `is_unit_data`. Effectively two type checks where
  one would suffice if the right `choose_data` form is used.
- **Why it costs**: 1 redundant `choose_data` per soft-decode call.
  Per Mix tx: N input decodes (in `mix_logic`'s
  `collect_well_formed_mix_inputs`) + N output decodes
  (`check_and_decode_mix_output`) + N spend-side decodes inside
  `mix_box`. ~3N redundant `choose_data` calls at maybe ~1M each.
- **Recommended change**: rewrite the soft-decode using
  `builtin.choose_data` as the dispatcher with explicit branches
  rather than a Bool guard. Concretely:
  ```aiken
  pub fn try_decode_well_formed_data(d: Data) -> Option<MixDatum> {
    builtin.choose_data(
      d,
      decode_constr_branch(d),       // Constr
      None, None, None, None,        // Map, List, Int, Bytes
    )
  }
  ```
  **Caveat — this is the speculative bit**: `choose_data`'s argument
  evaluation strategy in Aiken-compiled UPLC matters. If all five
  branches are evaluated eagerly, `decode_constr_branch(d)` would call
  `un_constr_data(d)` on non-Constr data and abort the script —
  defeating the soft-fail. Need to verify on the compiled UPLC (e.g.
  via `aiken build --trace-level verbose` and `uplc decompile`) that
  the branch is lazy in practice. If it isn't, keep the current `if
  is_constr(d)` guard.
- **Behaviour change**: Must be No. If the lazy-branch verification
  fails, abandon this item.
- **Risk level**: Medium (only because of the laziness verification
  step).
- **Test cases needed**: feed every shape (Constr, Map, List, Int,
  Bytes) through the soft-decode and assert `None` for non-Constr,
  no script abort. Add to `mixbox`/`fee` test suites.
- **Priority**: Low.
- **Effort**: Small once the laziness question is settled.

---

## 11. (Speculative) Combine the two equality checks in OR branch into a single one

- **Location**: [`sigma_or.ak:159-163`](../contracts/lib/lovejoin/sigma_or.ak#L159-L163)
- **Current issue**: per branch we compute `[z]a`, `[z]b`,
  `[c]a'_i`, `[c]b'_i` and assert `[z]a == t0 + [c]a'_i` AND `[z]b ==
  t1 + [c]b'_i`. Five group ops + two equality tests per branch.
- **Why it costs**: per-tx: 4N² scalar muls dominate, but the 2N²
  point_equal calls are also non-trivial.
- **Recommended change** (speculative): replace the two equalities
  with a single equality on a random linear combination — pick
  `α = blake2b_256(domain || a_pt || b_pt || stmt.ap_pt || stmt.bp_pt
  || br.t0 || br.t1)` (or similar transcript-derived scalar) and check
  `[z]([1]a + [α]b) == ([1]t0 + [α]t1) + [c]([1]a'_i + [α]b'_i)`.
  Saves 2 scalar muls + 2 adds per branch (we're gaining 1 add inside
  the combined check), maybe 1 equality per branch.
- **Why marked speculative**: the soundness analysis is a real chunk
  of work — the standard sigma-OR security argument relies on the two
  equations holding *separately* (you're proving the same `x` opens
  both). A random-combo check is sound under the Schwartz–Zippel
  argument **provided** `α` is unpredictable to the prover (transcript-
  bound, not redeemer-supplied). Even then, the change is large
  enough to be its own audit item, and it diverges the Aiken verifier
  from the TS prover (the TS prover doesn't change, but the
  verifier's algorithm does). On the costing side, we'd need to
  measure: the extra `blake2b_256` + 2 adds may exceed the savings
  from 2 muls / 2 equals. **Skip unless items 1–4 don't get us to
  N=4.**
- **Behaviour change**: Yes (algorithm change; soundness must be
  re-argued).
- **Risk level**: High.
- **Test cases needed**: full soundness re-derivation; KAT-equivalent
  vectors recomputed; negative vectors that exercise "branch i passes
  eq0 but fails eq1" must still be rejected.
- **Priority**: Low (escape-hatch only).
- **Effort**: Large.

---

## 12. (Reject) Drop scalar canonical-length check

- **Location**: [`bls.ak:40-45`](../contracts/lib/lovejoin/bls.ak#L40-L45)
- **Current issue**: `scalar_from_bytes` enforces `length == 32` and
  `value < r`. Tempting to skip the length check.
- **Why it costs**: 1 length builtin + 1 equal builtin per scalar
  decode. Per Mix tx: N² × 1 z-scalar = N² length checks. ~16 at N=4.
- **Recommended change**: **don't make this change**. Spec
  ([02-cryptography.md §"Parameters"](spec/02-cryptography.md))
  requires canonical 32-byte big-endian scalar encoding; dropping the
  length check would silently accept short scalar encodings that the
  prover would never emit but a fuzzer could — weakening malleability
  resistance. The savings are tiny relative to the per-branch
  scalar-mul cost.
- **Behaviour change**: Yes (rejected — would weaken validation).
- **Risk level**: High.
- **Priority**: Reject.
- **Effort**: N/A.

---

## 13. (Reject) Skip per-input datum re-decode in `mix_logic`

- **Location**: [`mix_logic.ak:215-229`](../contracts/validators/mix_logic.ak#L215-L229) +
  [`mix_box.ak:33`](../contracts/validators/mix_box.ak#L33)
- **Current issue**: `mix_box`'s spend handler decodes each input's
  datum (well-formed check). Then `mix_logic`'s
  `collect_well_formed_mix_inputs` decodes the same datum AGAIN. N
  redundant decodes per Mix tx.
- **Why it costs**: N × (Constr decode + 2 length checks + 1 byte
  inequality). ~N×~5M CPU. At N=4 that's ~20M ≈ 0.2% of mainnet
  budget — small but cumulative.
- **Recommended change**: **don't merge them**. The two decodes are
  on different UPLC scopes (each `mix_box` instance is a fresh script
  evaluation); there's no way to cache across them on Plutus. The
  separation is required for Rule 2 — `mix_box` must answer "should
  I accept the spend?" per-input, while `mix_logic` must answer
  "which inputs do I count toward the OR-proof set?" once. Different
  questions, same datum. The redundancy is structural.
- **Behaviour change**: rejected.
- **Risk level**: High (would require a protocol redesign).
- **Priority**: Reject.
- **Effort**: N/A.

---

## Suggested implementation order

1. Item 2 (drop wrapper-list allocations in `verify_pre`) — Small,
   Low-risk, High-impact. Land first; it's a self-contained win.
2. Item 3 (drop `list.length` redundancy) — Small, Low-risk, ride
   along.
3. Item 1 (single-pass `validate_mix`) — Medium-effort, the biggest
   per-tx CPU savings. Land after items 2/3 so the `verify_pre`
   surface is clean before we restructure `mix_logic`.
4. Items 4, 6, 7, 8 — cleanup pass. Land in one PR-internal commit
   block. Item 6 is gated on the redeploy.
5. Items 5, 9, 10 — only if benchmarks after items 1–4 still don't
   clear the N=4 bar.
6. Items 11, 12, 13 — reject / escape-hatch. Don't touch unless
   forced.

## Verification plan after the implementation

- `aiken check` green, all positive + negative validator tests pass.
- `pnpm --filter @lovejoin/sdk test` green (encoding-parity KAT
  vectors must still byte-match — items 1, 5, 6 touch the FS preimage
  shape).
- New `ctx_canonical_bytes` golden test in
  `mix_logic.test.ak`/`encoding_parity_kat.test.ak` snapshotting the
  pre-image bytes for N ∈ {2, 3, 4, 6, 8} so any future restructure
  catches a byte drift fast.
- Redeploy to Preprod + run `stress-tests/max-n-calibration.ts`;
  compare CPU/mem against the M4 baseline and the
  table in [`docs/perf.md`](perf.md). Expected outcome: N=4 fits
  inside the ≤70% mainnet headroom; ideally N=6 fits.
- Re-run `mix-at-max-n`, `mix-n2`, `fee-exhaustion`,
  `full-lifecycle` integration suites against the new deployment
  ten consecutive times.

## Out of scope for this audit

- Off-chain optimisations of the SDK Mix tx builder (M5/M6 polish).
- Backend indexer cost (separate budget — runs off-chain).
- Validator-level changes that require a protocol-level redesign
  (e.g. removing the `mix_box` ↔ `mix_logic` split). Those are M8+
  redesign topics.
- Mainnet cost-model deltas — Conway is the assumed target; if the
  cost model changes we re-run calibration.
