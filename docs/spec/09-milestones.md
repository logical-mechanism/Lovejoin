# 09 — Milestones

Each milestone has: **scope**, **deliverables**, **exit criteria**, **rough size**.

v1 ships through M7. M8+ is post-v1.

---

## M0 — Foundations and tooling

**Scope:** repo skeleton, dev environment, CI scaffolding, i18n bootstrap. No protocol code.

**Deliverables:**
- `contracts/` Aiken project scaffolded; **Aiken 1.1.21** pinned in `aiken.toml`.
- `offchain/` TS package with vitest configured.
- `backend/` Node project with Fastify + ogmios stub.
- `ui/` Vite + React + Tailwind project with **react-i18next** wired up; English locale.
- `infra/bootstrap/` placeholder shell scripts.
- `config/network.test.json` and `config/network.preprod.json`.
- `Makefile` (or `justfile`) at repo root: `make build`, `make test`, `make ui-dev`, `make backend-dev`.
- GitHub Actions: lint + test on every PR.
- README updated with reachable Preprod ogmios + db-sync env-var instructions.

**Exit criteria:** `make build && make test` succeeds from a clean checkout. CI green. Empty UI loads English copy via i18n harness.

**Size:** small (~3 days).

---

## M1 — Cryptography (variable N)

**Scope:** the three sigma primitives — including **N-way sigma-OR for variable N** — RFC 6979 nonce derivation, fully implemented in TS and Aiken with KAT vectors.

**Deliverables:**
- TS: `offchain/src/crypto/{bls,hash,nonce,schnorr,dhtuple,sigma_or,verify}.ts`. The sigma-OR module supports **arbitrary N**.
- Aiken: `contracts/lib/lovejoin/{bls,hash,schnorr,dhtuple,sigma_or}.ak` verifiers; sigma-OR is **N-generic**, taking the proof's branches as a list.
- Rust reference: `crypto/ref/` using `blst` for KAT generation at varied N.
- Test vectors at `crypto/test-vectors/` covering N ∈ {2, 3, 4, 6, 8}, 200 vectors per N. Negative vectors at every N.
- Encoding-parity test: same inputs hashed in TS and Aiken yield identical bytes.

**Exit criteria:**
- All KAT vectors verify in TS, Aiken, and Rust ref at every supported N.
- All negative vectors are rejected.
- Encoding parity passes for 1000 random inputs across N values.
- TS prover with same `(secretKey, message)` produces byte-identical proofs across runs (RFC 6979 sanity).

**Size:** medium-large (~2 weeks).

**Depends on:** M0.

---

## M2 — Validators + Preprod bootstrap + N calibration

**Scope:** all validators, bootstrapped to Preprod, **with `max_n` empirically calibrated**.

**Deliverables:**
- `contracts/validators/{reference_holder,one_shot_mint,mix_box,fee_contract}.ak`. Mix branch handles **variable N** at runtime.
- `contracts/test/{reference_test,mix_box_test,fee_contract_test}.ak`. Mix tests cover N ∈ {2, 3, 4, 6, 8} positive + negative.
- `contracts/build.sh`.
- `infra/bootstrap/` complete:
  - `00-build-reference.sh`
  - `01-mint-and-lock.sh` (one-shot mint + lock to reference_holder)
  - `02-fund-fee-contract.sh` (10 fee shards)
  - `03-publish-reference-scripts.sh` (CIP-33 reference scripts)
- `artifacts/test/` and `artifacts/preprod/` with compiled `.plutus` files and `addresses.json`.
- **Stress tests for OQ-A and `max_n`:** `stress-tests/fee-calibration.ts` and `stress-tests/max-n-calibration.ts`. Submit Mix txs at varied N on Preprod, measure script CPU/mem and Cardano-charged fees, recommend:
  - `max_n` = highest N where total tx CPU stays < 70% of mainnet limit.
  - `max_fee_per_mix_lovelace` = `ceil(max_observed_at_max_n × 1.25)`.
- Results committed to `docs/perf.md` and `network.preprod.json`.

**Exit criteria:**
- Every rule from [03-contracts.md](03-contracts.md) §1–§3 has positive + negative tests, all passing.
- Mix tx total script cost at recommended `max_n` < 70% mainnet limits.
- Reference NFT minted on Preprod; 10 fee shards funded; reference scripts published.
- `max_n` and `MAX_FEE_PER_MIX_LOVELACE` empirically calibrated and committed.
- 30-minute fuzz with no panics or unexpected accepts.

**Size:** large (~3-4 weeks).

**Depends on:** M1.

---

## M3 — SDK: deposit + withdraw + collateral provider client

**Scope:** TS SDK for Deposit and Withdraw, plus the **collateral provider client** used by Mix in M4.

**Deliverables:**
- `offchain/src/tx/{deposit,withdraw,fee,params,collateral}.ts`.
- `offchain/src/wallet/cip30.ts` mesh integration.
- CLI: `lovejoin deposit` and `lovejoin withdraw`.
- **Collateral provider integration**: `GivemeMyProvider` client in `tx/collateral.ts` against the production endpoint. `WalletProvider` fallback for Deposit/Withdraw (where the wallet is in the tx anyway).
- Mesh viability check: confirm mesh handles spending a script UTxO without a submitter wallet input AND accepts an externally-supplied collateral input + signature.
- Integration test on Preprod: deposit (with Replenish), confirm, withdraw to a different address, assert arrival.

**Exit criteria:**
- Deposit + withdraw integration test passes ten consecutive runs on Preprod.
- Mesh viability decision documented; if mesh blocks the externally-supplied collateral path, switch to lucid-evolution before M4.
- `GivemeMyProvider` confirmed working against the production giveme.my endpoint on Preprod.

**Size:** medium (~2 weeks).

**Depends on:** M2.

---

## M4 — Mix tx builder (variable N + collateral provider)

**Scope:** the variable-N mixing logic; users submit Mix txs with N ∈ {2..max_n} from the SDK or UI, fully wallet-anonymous via the collateral provider.

**Deliverables:**
- `offchain/src/tx/mix.ts` — variable-N Mix tx builder using fee shard + collateral provider.
- `offchain/src/pool/{identify,select}.ts` — local pool scanner; uniform random N-tuple selector.
- CLI: `lovejoin mix` (uses max_n) and `lovejoin mix --n N --rounds K`.
- Integration tests on Preprod:
  - Deposit 8 boxes, run 30 mixes at random N values, verify boxes survive and ownership tracking still works.
  - Mix tx with `n = max_n` succeeds.
  - Mix tx with `n = 2` succeeds.
  - Mix when fee shard has just enough; rejects when below `MAX_FEE_PER_MIX`.
  - Mix when collateral provider is reachable; falls back gracefully (with UX warning) when not.

**Exit criteria:** all integration tests pass ten consecutive runs.

**Size:** medium (~2-3 weeks).

**Depends on:** M3.

---

## M5 — Backend indexer + API

**Scope:** chainsync indexer for pool, fee shards, reference UTxO; REST API.

**Deliverables:**
- `backend/src/indexer/{ogmios,pool,fee,reference,reorg}.ts`.
- `backend/src/api/` complete with all routes.
- `backend/Dockerfile`.
- Load test: `/pool` for a 50k-box pool with p99 < 100ms.
- Recovery test: simulated 500-block rollback, recovers without data loss.
- Reference-UTxO sanity alarm: simulate "reference UTxO consumed" event; indexer raises and degrades.

**Exit criteria:**
- Backend syncs from a Preprod-aligned db-sync snapshot in < 5 minutes.
- API tests pass.
- Recovery test passes.

**Size:** medium (~2 weeks).

**Depends on:** M2. Can run partially in parallel with M3/M4.

---

## M6 — UI v1

**Scope:** React UI with i18n, encrypted IndexedDB key storage, user-as-mixer flow, **N-width slider**, **collateral provider status indicator**.

**Deliverables:**
- All screens from [06-ui.md](06-ui.md).
- Wallet integration via mesh + CIP-30.
- IndexedDB encrypted-storage (Argon2id passphrase).
- i18n: English at minimum; lint rule against raw English in JSX.
- N-width slider on the Pool screen, 2..max_n.
- Collateral provider status indicator + fall-back UX when provider is down.
- Seedelf destination detection in Withdraw screen.
- E2E Playwright test on Preprod: connect wallet, deposit, run 3 mixes via "Mix N random boxes" at varied N, withdraw to fresh address, verify on chain.

**Exit criteria:** E2E test passes on Preprod.

**Size:** large (~3-4 weeks).

**Depends on:** M3, M4, M5.

---

## M7 — CI/CD and release engineering

**Scope:** automated build & test pipeline from `main`. Reproducible builds. No automated deploy yet (Preprod only until audit).

**Deliverables:**
- GitHub Actions workflow on PR + merge:
  1. Builds all packages.
  2. Unit + validator + property tests on every PR.
  3. Integration suite on Preprod nightly.
  4. Fuzz suite nightly for 30 minutes.
  5. On merge to main: publishes SDK to npm under `dev` tag; builds + pushes backend Docker image; uploads UI bundle.
- Reproducible-build verification: re-build from a tag and assert byte-identical contract artifacts.

**Exit criteria:** `git push origin main` triggers a full pipeline ending with all artifacts published, in < 30 minutes.

**Size:** medium (~1-2 weeks).

**Depends on:** all prior milestones.

---

## M8+ — Beyond v1

Sketch only:

- **Outsourced mixer-bot service.** Long-running automation; charges service fees via stealth payments.
- **Stealth payments to mixers** (paper §5.2).
- **User incentives** (paper §5.5). Reward boxes that stay in the pool > K rounds — drives pool retention, the highest-leverage privacy improvement.
- **Multi-asset pools.**
- **Multi-denomination support** (parallel pools at 10 / 100 / 1000 ADA).
- **Time-locked withdrawal commitment** in datum (cheap protocol-level addition).
- **Per-box mix cooldown** if targeted mixing emerges as a real threat.
- **Decentralized collateral provider** for trustless v2.
- **Mainnet deployment** subject to passing the audit gate.
- **External audit** (independent of project contributors).

---

## Sequencing

```
M0 ──► M1 ──► M2 ──► M3 ──► M4 ──┐
                          │       ├──► M6 ──► M7
                          └► M5 ──┘
```

M5 starts as soon as M2 is done. M6 needs M3, M4, M5.

Total v1 estimate: **3 months of focused work** for a small team. Slightly larger than previous draft because (a) M1 covers variable-N sigma-OR, (b) M2 includes empirical N calibration, (c) M3 includes collateral provider integration. External audit time additional.
