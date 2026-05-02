# Test coverage

This file records the current per-module coverage numbers for the three
TypeScript workspaces and the spec-rule audit for the Aiken validators.
It is the audit trail for issue #37 (v1.0.0 hardening) and is updated by
hand when numbers move materially. Per CLAUDE.md "no third-party
telemetry," we do not push to Codecov; the lcov reports live as a
GitHub Actions artifact (`coverage-lcov`, 30-day retention) on every CI
run, and HTML reports are generated locally under each workspace's
`coverage/` directory.

## How to run locally

```sh
# Per workspace
pnpm --filter @lovejoin/sdk run test -- --coverage
pnpm --filter @lovejoin/backend run test -- --coverage
pnpm --filter @lovejoin/ui run test -- --coverage

# Browse HTML report
open offchain/coverage/index.html   # macOS
xdg-open offchain/coverage/index.html  # Linux
```

`make test` does **not** run coverage by default — coverage is opt-in via
the `--coverage` flag because the V8 instrumentation slows the SDK suite
materially (the kat tests dominate). CI runs the coverage suite in a
separate job from the unit-test job for the same reason.

## TypeScript — per-module numbers

Numbers below are line coverage from the v8 provider, snapshotted on
2026-05-01 against `dev`. They reflect the alpha state of the codebase,
not a target. The 70% line on `offchain/src/crypto/` is a soft target
(no CI enforcement) — see "Soft target" below.

### offchain (`@lovejoin/sdk`) — overall **49.39%**

| Module                      | Lines  | Notes                                                               |
| --------------------------- | ------ | ------------------------------------------------------------------- |
| `src/crypto/`               | 96.92% | meets 70% soft target with comfortable margin                       |
| `src/crypto/hash.ts`        | 100%   |                                                                     |
| `src/crypto/nonce.ts`       | 100%   | RFC 6979 deterministic-nonce derivation                             |
| `src/crypto/dhtuple.ts`     | 97.29% |                                                                     |
| `src/crypto/sigma_or.ts`    | 96.17% |                                                                     |
| `src/crypto/bls.ts`         | 94.20% | uncovered: G1 subgroup-check error paths                            |
| `src/crypto/schnorr.ts`     | 92.72% | uncovered: c-mod-r reject path                                      |
| `src/pool/`                 | 92.91% |                                                                     |
| `src/wallet/seed.ts`        | 96.05% |                                                                     |
| `src/tx/address.ts`         | 94.44% |                                                                     |
| `src/tx/collateral.ts`      | 79.91% | external-host fallback paths covered by mock-fetcher unit tests     |
| `src/tx/fee.ts`             | 74.00% | exhaustion-recovery branches not covered by unit tests              |
| `src/tx/params.ts`          | 85.84% |                                                                     |
| `src/tx/retry.ts`           | 85.41% |                                                                     |
| `src/tx/deposit.ts`         | 42.59% | mesh tx-builder paths exercised in integration-tests, not vitest    |
| `src/tx/mix.ts`             | 43.34% | as above; structural plan-mix paths covered                         |
| `src/tx/withdraw.ts`        | 20.60% | as above                                                            |
| `src/tx/donate.ts`          | 15.51% | as above                                                            |
| `src/tx/witness-merge.ts`   | 2.08%  | only used by collateral-provider integration path                   |
| `src/chain/blockfrost.ts`   | 54.19% | network-bound paths under nock/mock; provider abstract is exercised |
| `src/chain/backend.ts`      | 0.73%  | needs the backend running; covered by integration-tests             |
| `src/chain/backend-mesh.ts` | 3.89%  | thin shim; covered through mesh integration                         |

The `tx/` and `chain/` numbers reflect the architectural split: unit
tests cover pure logic (planning, validation, encoding); integration
tests in `integration-tests/` exercise the tx-builder + Blockfrost paths
end-to-end on Preprod and intentionally do not run under vitest.

### backend (`@lovejoin/backend`) — overall **59.73%**

| Module                            | Lines  | Notes                                                    |
| --------------------------------- | ------ | -------------------------------------------------------- |
| `src/api/server.ts`               | 71.42% | Fastify route handlers + JSON-schema validation paths    |
| `src/indexer/state.ts`            | 91.92% | in-memory index of mix-boxes / fee-shards / reference    |
| `src/indexer/mempool.ts`          | 89.28% |                                                          |
| `src/indexer/ogmios.ts`           | 89.10% |                                                          |
| `src/indexer/runtime.ts`          | 83.00% |                                                          |
| `src/indexer/datum.ts`            | 69.90% | malformed-datum branches reached via fixture replay      |
| `src/indexer/types.ts`            | 50.00% | mostly type re-exports                                   |
| `src/indexer/ogmios-tx.ts`        | 2.20%  | tx-submission path; covered by integration-tests         |
| `src/db/dbsync.ts`                | 12.67% | optional Postgres backfill; covered by integration-tests |
| `src/db/request-history.ts`       | 71.79% |                                                          |
| `src/address.ts`, `src/config.ts` | ~6%    | module-load-only at process start; not a meaningful gap  |

### ui (`@lovejoin/ui`) — overall **23.31%**

| Module                              | Lines  | Notes                                                |
| ----------------------------------- | ------ | ---------------------------------------------------- |
| `src/lib/format.ts`                 | 100%   |                                                      |
| `src/lib/collateral-status.ts`      | 100%   |                                                      |
| `src/lib/bech32.ts`                 | 96.38% |                                                      |
| `src/lib/errors.ts`                 | 95.55% |                                                      |
| `src/lib/sdk.ts`                    | 88.67% |                                                      |
| `src/lib/seedelf.ts`                | 83.33% |                                                      |
| `src/lib/backend.ts`                | 77.77% |                                                      |
| `src/i18n/languages.ts`             | 100%   |                                                      |
| `src/components/ConfigPanel.tsx`    | 100%   |                                                      |
| `src/components/ErrorBoundary.tsx`  | 84.90% |                                                      |
| `src/components/Header.tsx`         | 80.76% |                                                      |
| `src/components/MixWidthSlider.tsx` | 77.58% |                                                      |
| `src/routes/`                       | 1.65%  | route components covered by Playwright E2E (Preprod) |
| `src/components/Toaster.tsx`, …     | 0%     | as above                                             |

The UI's strategy is unit-coverage on pure libraries (`src/lib/*`) and
end-to-end coverage on routes via Playwright. Bringing `src/routes/`
under vitest would require a heavyweight `meshSdk` mock that does not
exist; the cost of that mock outweighs the marginal coverage gain in
v1, so we leave routes for E2E.

## Soft target — `offchain/src/crypto/` ≥ 70% lines

The SDK's cryptography is the security-critical surface. We commit to
keeping `src/crypto/**/*.ts` above 70% line coverage. Today it sits at
**96.92%** — comfortably above. This target is **not** enforced as a
vitest threshold (which would fail CI on regressions in unrelated PRs);
it is tracked in this document and verified by reading the lcov
artifact attached to the CI run. If the number drops below 70% on
`main`, that is treated as a release-blocker for the next semver tag.

The thresholds are deliberately not encoded in `vitest.config.ts`. Per
the issue scope: "Soft threshold (no CI failure) at 70% lines for SDK
crypto modules." A failing threshold on coverage would punish
unrelated PRs (e.g. someone deleting a non-crypto file shifts the
overall percentage); a soft target tracked here gives reviewers the
right context to act on a regression without blocking the queue.

## Aiken validators — spec-rule audit

CLAUDE.md mandates that every rule in `docs/spec/03-contracts.md` §1–§3
has both a positive and a negative test. The matrix below records the
current state. Tests live under `contracts/validators/*.test.ak` and
`contracts/lib/lovejoin/*.test.ak`.

### §1 — `reference_holder` + `one_shot_mint`

| Rule                            | Positive                                     | Negative                                                                             |
| ------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `reference_holder` always-False | n/a (no positive case exists)                | `reference_holder_always_rejects_*` (3 tests, unit/int redeemer + with inline datum) |
| `one_shot_mint` seed consumed   | `one_shot_mint_positive[_seed_among_others]` | `one_shot_mint_rejects_seed_missing`, `one_shot_mint_rejects_no_inputs`              |
| `one_shot_mint` quantity == 1   | `one_shot_mint_positive*`                    | `one_shot_mint_rejects_quantity_zero`, `_quantity_two`, `_burn`, `_two_asset_names`  |

### §2 — `mix_box` (spend, withdraw-zero pass-through)

| Rule                                                     | Positive                                                                                                                                                      | Negative                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Well-formed inline datum requires `mix_logic` withdrawal | `mix_box_accepts_when_mix_logic_withdraws_zero`, `_nonzero`, `_with_other_withdrawals_present`                                                                | `mix_box_rejects_missing_withdrawal`, `_wrong_withdrawal_credential` |
| Bad-shape inline datum → True (Rule 2)                   | `mix_box_accepts_a_eq_b_datum_no_withdraw`, `_short_bytes_*`, `_int_*`, `_wrong_constr_idx_*`                                                                 | n/a (the rule is "accept any malformed inline")                      |
| `NoDatum` / `DatumHash` → True (audit F-2)               | `mix_box_no_datum_takes_recovery_path`, `mix_box_datum_hash_with_well_formed_preimage_*`, `_datum_hash_recovery_succeeds_even_when_other_withdrawals_present` | n/a                                                                  |

### §2 — `mix_logic` Owner branch

| Rule                                                        | Positive                                                                                                     | Negative                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `N >= 1` well-formed mix inputs                             | exercised structurally via `owner_with_*_inputs_rejects_bogus_proof` (rule passes; proof verification fails) | `owner_rejects_zero_well_formed_inputs`                                                              |
| `length(proofs) == N`                                       | as above                                                                                                     | `owner_rejects_proof_count_mismatch`                                                                 |
| Reference UTxO present                                      | implicit in every passing prologue                                                                           | `owner_rejects_no_reference_input`                                                                   |
| Schnorr proof verifies against ctx                          | **deferred** — see "Deferred work" below                                                                     | `owner_with_two_inputs_rejects_bogus_proofs`, `owner_with_one_well_formed_input_rejects_bogus_proof` |
| Bad-datum mix inputs are silently dropped (Rule 2)          | implicit in every prologue test                                                                              | `owner_ignores_bad_datum_inputs`                                                                     |
| Stake-cred lifecycle: register-once, reject everything else | `publish_allows_register_credential`                                                                         | `publish_rejects_unregister_credential`                                                              |

### §2 — `mix_logic` Mix branch

| Rule                                                                | Positive                                          | Negative                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `2 <= N` (no on-chain upper bound — calibrated off-chain)           | `mix_full_prologue_then_proof_fails_n{2,3,4,6,8}` | `mix_rejects_n_eq_1`                                                                      |
| `length(mix_outputs) == N`                                          | prologue tests (every valid output counted)       | `mix_rejects_fewer_outputs_than_inputs` (added by this PR)                                |
| Mix outputs occupy positions 0..N-1                                 | prologue tests                                    | `mix_rejects_mix_output_in_tail`, `mix_rejects_non_mix_output_in_prefix`                  |
| `length(proofs) == N`                                               | prologue tests                                    | `mix_rejects_proofs_count_mismatch`                                                       |
| Output `value.lovelace == denom_lovelace`                           | prologue tests                                    | `mix_rejects_wrong_denom_output`                                                          |
| Output ada-only (no native assets)                                  | prologue tests                                    | `mix_rejects_native_asset_in_output`                                                      |
| Output `MixDatum` well-formed: `length(a) == 48 && length(b) == 48` | prologue tests (all outputs use 48-byte fields)   | `mix_rejects_short_bytes_output_datum` (added by this PR)                                 |
| Output `MixDatum` well-formed: `a != b`                             | prologue tests                                    | `mix_rejects_a_eq_b_output_datum`                                                         |
| Reference UTxO present                                              | prologue tests                                    | `mix_rejects_no_reference_input`                                                          |
| `ctx` binding (rule 5)                                              | **deferred** — see "Deferred work"                | exercised implicitly: any tampered output flips ctx and the bogus proofs reject as before |
| Sigma-OR for each input verifies (rule 6)                           | **deferred** — see "Deferred work"                | every prologue test ends with a bogus-proof rejection at the verifier                     |

### §3 — `fee_contract`

| Rule                                                  | Positive                                                        | Negative                                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Rule 2: non-unit datum → True (recovery)              | `fee_contract_accepts_no_datum_recovery`, `_int_datum_recovery` | n/a                                                                                               |
| **PayMixFee** mix_logic redeemer is `Mix { .. }`      | `pay_mix_fee_positive_n{2,6}`                                   | `pay_mix_fee_rejects_owner_redeemer_n{2,6}`, `_missing_mix_logic_redeemer` (audit F-1 regression) |
| **PayMixFee** ≥ 2 mix-script inputs                   | `pay_mix_fee_positive_n{2,6}`                                   | `pay_mix_fee_rejects_one_mix_input`, `_zero_mix_inputs`                                           |
| **PayMixFee** exactly one fee output, datum unchanged | `pay_mix_fee_positive_*`                                        | `pay_mix_fee_rejects_no_fee_output`, `_two_fee_outputs`, `_no_datum_on_output`                    |
| **PayMixFee** `fee_in - fee_out == self.fee`          | `pay_mix_fee_positive_*`                                        | `pay_mix_fee_rejects_fee_diff_too_small`, `_fee_diff_too_large`                                   |
| **PayMixFee** `self.fee <= max_fee_per_mix`           | `pay_mix_fee_positive_at_max_fee` (boundary)                    | `pay_mix_fee_rejects_fee_above_max`                                                               |
| **PayMixFee** no native assets in fee in/out          | `pay_mix_fee_positive_*`                                        | `pay_mix_fee_rejects_native_asset_in_output`, `_native_asset_in_input` (added by this PR)         |
| **Replenish** exactly one fee in/out                  | `replenish_positive`                                            | `replenish_rejects_no_fee_output`, `replenish_rejects_two_fee_outputs` (added by this PR)         |
| **Replenish** datum unchanged on output               | `replenish_positive`                                            | `replenish_rejects_non_unit_datum_on_output` (added by this PR)                                   |
| **Replenish** `fee_out > fee_in` (strict)             | `replenish_positive`                                            | `replenish_rejects_decrease`, `replenish_rejects_unchanged`                                       |
| **Replenish** no native assets in fee in/out          | `replenish_positive`                                            | `replenish_rejects_native_asset_in_output`, `_native_asset_in_input` (added by this PR)           |

### Deferred work

Two end-to-end positive tests for `mix_logic` are intentionally still
deferred. They each require a real proof — Schnorr for the Owner case,
N-way sigma-OR for the Mix case — that verifies against
`ctx = blake2b_256(serialise_data(self.outputs) || mix_script_hash)`.
Aiken's `serialise_data` is canonical CBOR; computing the same byte
string in TypeScript needs a `serialise_data(List<Output>)` shim that
agrees with Aiken byte-for-byte. The shim is non-trivial and is its own
piece of work; until it lands, we rely on:

1. **Crypto KAT tests** (`crypto/test-vectors/{provedlog,sigma-or,…}.json`)
   — the verifiers themselves are exhaustively exercised in isolation
   in `contracts/lib/lovejoin/{schnorr_kat,sigma_or_kat,dhtuple_kat}.test.ak`,
   `offchain/test/crypto/`, and `crypto/ref/` (Rust). All three impls
   agree on bytes.
2. **Prologue positive tests** (`mix_full_prologue_then_proof_fails_n{2,3,4,6,8}`)
   — every structural rule in `validate_mix` is exercised on a fully
   well-formed input/output set; the final proof check is the only
   thing that fails.
3. **Live Preprod transactions from M4** — every Mix tx submitted on
   Preprod between M4 and today proves the wired-up validator accepts
   real proofs. This is the strongest signal we have.

This combination gives us strong confidence that the validator's
proof-verification wiring is correct. The TS shim work is tracked
independently (see this section as the canonical reference); when it
lands, the deferred rows above will be filled in.
