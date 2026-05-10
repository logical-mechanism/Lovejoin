# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning

Lovejoin follows [SemVer](https://semver.org/) starting at 0.3.0. Day-to-day work accumulates under `Unreleased` while it lives on `dev`; when a `dev → main` rollup goes out as a release, `Unreleased` is renamed to that release's `[X.Y.Z] - YYYY-MM-DD` heading and a fresh `Unreleased` section opens. Pre-0.3.0 entries are dated rather than versioned because the project did not yet make a versioned-release commitment.

## [Unreleased]

## [0.4.0] - YYYY-MM-DD

Preprod re-bootstrap that ships three on-chain audit follow-ups. Validator bytecode changes for `mix_logic`, `fee_contract`, and `one_shot_mint`; `mix_box` is unchanged. The off-chain SDK + backend + UI continue to ship against the live deployment, now pointing at the post-redeploy addresses. Mainnet deployment of the same on-chain code remains in preparation; the disclosure posture (no third-party audit, no bug bounty) is unchanged.

> Pre-0.4.0 Preprod state at the previous protocol addresses is abandoned by this redeploy. Existing fee shards and any depositor mix-boxes at the old addresses are orphaned; the new reference UTxO publishes a fresh `ProtocolParams` pinning the new `mix_logic` and `fee_contract` script hashes. Depositors who still hold owner secrets against the pre-0.4.0 mix-box address can owner-withdraw on the old contracts, but new deposits, mixes, and fee-shard top-ups all flow through the 0.4.0 perimeter.

### Changed (validator bytecode)

- **Address-perimeter hardening (audit H-01 / M-01).** `mix_logic` and `fee_contract` now require every continuing protocol output to set `stake_credential = None` and `reference_script = None`. The same constraint extends to `one_shot_mint`'s reference-UTxO target. Off-chain dApp-stake-key plumbing was removed in lockstep so addresses are CIP-19 enterprise-only; the protocol pool can no longer accrue staking rewards from its own principal or be force-delegated to a dead pool (#129 / PR #131).
- **Reference UTxO destination + datum sanity (audit L-01 / L-02).** `one_shot_mint` now asserts at mint time that the protocol NFT lands at the `reference_holder` script with an inline `ReferenceDatum` whose `denom_lovelace` and `max_fee_per_mix_lovelace` are positive. Bootstrap rebuilds parameterize `one_shot_mint` with the `reference_holder` script hash so this binding is exact, not documentary (#130 / PR #133).
- **Anonymity-set floor on fee-paying mixes.** `fee_contract.PayMixFee` now requires `N ≥ 3`. The previous `N ≥ 2` floor enforced by `mix_logic` is unchanged for wallet-collateral mixes; the new constraint applies only when a mix consumes a fee shard. The N=2 anonymity set was too small for the fee-shard path's threat model. Documentation, perf notes, and integration tests are aligned (audit-fixes / PR #134).

### Added

- Internal pre-bootstrap audit report at `docs/audit_report.md` capturing the H-01 / M-01 / L-01 / L-02 / anonymity-set-floor analysis and the bytecode-fix decisions for this redeploy.
- 15 baseline `aiken bench` cases covering the hot-path redeemers (`mix_logic` Mix at N=2/3/4 with both bench fixtures, `fee_contract` PayMixFee + Replenish, `mix_box` spend, `one_shot_mint`). Replenish fixture rewritten to exercise the realistic 3-input shape.

### Fixed

- SDK collateral wire field renamed from `tx_body` to `tx` to match giveme.my's current request shape (PR #126).
- Backend `/pool` load test deflaked; intermittent p99 spike no longer trips the threshold (PR #125).

### Changed

- pnpm pinned to the 10.x line in `engines.pnpm` and `packageManager`. Documents the snap-shim node trap and the pnpm self-update trap that occasionally bricks the workspace lockfile.
- `dhtuple.ak` annotated as a parity anchor for the cross-language KAT vectors, not a validator dependency. No call sites changed.

### Deployed

- Preprod re-bootstrap of the new bytecode. Fresh script hashes for `reference_holder`, `one_shot_mint`, `mix_logic`, `fee_contract`; `mix_box` is bytecode-unchanged but its `mix_logic_script_hash` parameter is rebound, so its address moves with the others. New reference UTxO with refreshed `ProtocolParams`. New 10-shard fee pool. `config/network.preprod.json`, `artifacts/preprod/addresses.json`, and `ui/public/addresses.preprod.json` updated to the new addresses.

## [0.3.0] - 2026-05-06

Public-readiness release. The codebase is post-build-phase: validators deployed and immutable on Preprod, off-chain SDK + backend + UI shipped against the live deployment, hardening pass closed, internal review pass complete, disclosure narrative reconciled across README, SECURITY, CLAUDE, and the UI to match the actual posture (no third-party audit, no bug bounty, mainnet deployment of the same contracts in preparation).

### Removed

- **`docs/spec/` retired.** The 13-file spec was build-time scaffolding. The build is done, the contracts are immutable on Preprod, and the code is the ground truth. New canonical references: [README.md](README.md) (5-min summary), [ARCHITECTURE.md](ARCHITECTURE.md) (one-page overview with mermaid diagrams), [CLAUDE.md](CLAUDE.md) (conventions and constraints), [papers/sigmajoin.pdf](papers/sigmajoin.pdf) (the math), and the validators in [contracts/validators/](contracts/validators/) plus their `*.test.ak` siblings (the on-chain rules, with positive and negative coverage). All `docs/spec/` links in source comments, READMEs, workflows, scripts, and configs have been stripped or rewritten. Reading order for new contributors is now README to ARCHITECTURE to CLAUDE to code, captured at the bottom of CLAUDE.md.
- **`milestones.json` retired** along with the `/milestones` slash command. The status fields were stale (M4.5 marked `in-progress` after the redeploy landed, v1 marked `in-progress` after all 23 issues were closed), exit criteria pointed at URLs that don't resolve yet, and there are no remaining milestones for the listing slash command to surface. CLAUDE.md and the git log carry the build narrative; CHANGELOG is the user-facing record going forward. The `/work` slash command keeps its issue workflow and drops the now-empty milestone branch.
- **Internal one-off docs**: `audit-2026-05-03.md`, `security-review-v1.md`, `m3.5-verification.md`, `next-redeploy.md`, `optimization-audit-2026-04-28.md`, `perf-m4-5-audit.md`, `test-coverage.md`. The closed work they recorded lives in the commit history.

### Added

- Repo governance and open-source artifacts: `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1 by reference), `CODEOWNERS`, `.editorconfig`, GitHub issue templates (bug, feature, security pointer), GitHub PR template (#39).
- ESLint + Prettier baseline; husky `pre-commit` running `lint-staged`; CI `lint` job; Conventional Commits (#36).
- Test coverage instrumentation across the offchain SDK, backend, and UI workspaces (#37).
- Playwright E2E in CI driving the live Preprod deployment (#38).
- Component READMEs for `contracts/`, `offchain/`, `backend/`, `ui/`, `crypto/`, and `infra/bootstrap/` (#40).
- SDK TSDoc generation and backend OpenAPI spec (#41).
- User-facing docs: in-app `/help` route covering FAQ, glossary, and operations, in 20 locales (#42).
- README overhaul and a one-page `ARCHITECTURE.md` with mermaid diagrams (#43).
- Internal pre-launch security review across crypto, validators, backend, UI, CI/CD; 0 critical / 3 high (all fixed) / 9 medium (6 fixed) (#44).
- Mainnet-prep disclosure UX in the UI (#45).
- DigitalOcean App Platform deploy spec and Cloudflare Tunnel sidecar for ogmios + db-sync (#46, #21).
- Monitoring and runbook for the production indexer (#47).
- Release automation: tag-driven release workflow + Dependabot (#48).
- WCAG 2.2 AA accessibility pass on the UI (#22).
- 19 non-English locales: es, zh, hi, fr, ar, bn, ru, pt, ur, ja, ko, tr, vi, id, de, pl, it, fa, th. RTL support via the locale registry's `dir` flag.
- `BackendChainProvider` plus a mesh `BackendMeshProvider` so the self-hosted indexer is a drop-in for Blockfrost in both query and tx-builder paths.
- Fee-pool donation route, fee-shard donation tx builder, and per-shard balance display (#21).
- Mempool-aware shard picking + retry-with-backoff + busy-shard error surfacing.
- Bulk deposit (N fresh mix-boxes per tx) and bulk withdraw (N inputs + single combined destination) tx builders and UI flows.
- Wallet-anonymous withdraw via the external collateral provider on the Owner branch.
- Adversarial in-house security audit of the on-chain validators with status tracking (#80, #85).
- Backend `/utxos` lockdown to protocol addresses; served from indexer state (#89).
- Cold-sync optimization for the indexer (#87).
- Bounded ogmios reconnect with exponential backoff and circuit breaker (#77).
- UI CSP tightening and transitive-dependency hygiene pass (#76).
- Backend API route modules split out of `server.ts` for clearer ownership (#98).
- Vault sub-components extracted; route-level tests added (#97).

### Changed

- Switched the changelog versioning model from SemVer-style `[0.7.0]` to date-based `[YYYY-MM-DD]` entries, one per `dev → main` rollup.
- Validator `mix_logic` Owner Schnorr context now binds `inputs[].output_reference` so duplicate `(a, b)` pairs cannot be replayed (F-4).
- `one_shot_mint` validator bakes the `lovejoin` asset name into the policy (F-17).
- `mix_box` withdraw-zero gating triggers off `InlineDatum` source rather than resolved `Option<Data>` (F-2).
- `fee_contract` `PayMixFee` requires the `mix_logic` withdraw redeemer to be `Mix { .. }`, not `Owner` (F-1).
- Bootstrap `03-fund-fee-contract.sh` now seeds all 10 fee shards in one pass and accepts `SHARD_COUNT` as a positional arg.
- README and SECURITY rewritten to drop "alpha on Preprod" framing in favour of "live on Preprod, mainnet of the same contracts in preparation, no third-party audit, no bug bounty".

### Fixed

- SDK Conway reference-script-fee correction; pass real protocol params to `MeshTxBuilder`; submit-time exUnits aliasing in mesh; collateral-provider scope tightened to fee-shard mode only.
- Backend `assetsForUtxos` query plan fix and prime fast-path returning spent UTxOs (#107, #111).
- UI collateral endpoint resolution and diagnostic logging.
- Withdraw lex-sort on tx-id hex (F-4 defensive).
- CI pnpm pin single-sourced from `packageManager` to avoid drift across workflows.

### Deployed

- Preprod redeploy of the optimized validators after the M4.5/M4.6 CPU squeeze and audit fixes; new `artifacts/preprod/addresses.json`.
- Mainnet deployment of the same on-chain code is in preparation as of this rollup.

## [0.2.0] - 2026-05-01

Snapshot of `main` at the `dev → main` rollup in PR #62. Consolidates the M0 through M7 build phase, which brought the repo from green-field to a working alpha on Preprod. Individual commits are the authoritative history; this entry gives the shape of what landed.

### Added

- **M0 Foundations and tooling.** pnpm workspace, Aiken 1.1.21 pin, TypeScript / Vite / Vitest baselines, i18n scaffolding (20 locales), Makefile entry points, lint and prettier baseline.
- **M1 Cryptography (variable N).** BLS12-381 G1 wrappers in TypeScript, blake2b Fiat-Shamir hashing with TS / Aiken byte parity, RFC 6979 deterministic nonces, Schnorr proof-of-discrete-log, DH-tuple proof, 2-way and N-way sigma-OR proofs, and a Rust reference implementation using `blst`. KAT vectors at N in {2, 3, 4, 6, 8} agree byte-for-byte across TS, Aiken, and Rust.
- **M2 Validators and Preprod bootstrap.** Aiken validators: `reference_holder` (always-False NFT anchor), `one_shot_mint`, `mix_box` (cheap spend-side delegator), `mix_logic` (withdraw-zero pattern, runs once per tx), `fee_contract` (10-shard fee pool with `PayMixFee` and `Replenish` redeemers). Bootstrap shell scripts under `infra/bootstrap/` for the irreversible reference-UTxO ceremony.
- **M3 SDK: deposit, withdraw, collateral provider.** Off-chain SDK in `offchain/`: deposit and withdraw tx builders, mesh wiring (with the workarounds documented in `docs/perf.md` M3 section), pluggable `CollateralProvider` interface, default giveme.my client.
- **M3.5 UI vertical slice.** React 19 + Vite + Tailwind v4 UI for wallet connect, deposit, and withdraw. CIP-30 wallet integration; wallet-derived vault seed via `signData` (Ed25519 deterministic).
- **M4 Mix tx builder and UI.** N-way mix tx construction with externally-supplied collateral, exact-fee enforcement against fee shards, mix-output positioning rules, and the corresponding UI flow. Calibrated empirical N caps on Preprod.
- **M4.5 Mix optimization (in progress).** Pre-uncompressing sigma-OR statements in `mix_logic` (drops N-squared uncompresses to N). Remaining work parked under `post-v1` until the platform `max_tx_ex_units` ceiling moves.
- **M5 Backend indexer and API.** Node + Fastify backend backed by ogmios chainsync and db-sync, exposing the same `ChainProvider` shape as `BlockfrostProvider`. Runtime-swappable via `network.<net>.json`.
- **M6 UI v1 polish.** Pool / Vault / Box / Protocol screens; per-row mix; mix-round counter; toast and error-handling pass; mobile LCP optimizations.
- **M6.5 UI v1.5 design pass.** Visual rework, fee-shard floor handling, mix-selection hardening.
- **M7 CI/CD and release engineering.** GitHub Actions for lint, test, build, and release. ESLint and Prettier baseline with husky pre-commit hook (#36). Test coverage instrumentation across workspaces (#37).

### Deployed

- Preprod alpha. Bootstrap artifacts in `artifacts/preprod/addresses.json`.

### Known limitations

- **N capped empirically.** Mix txs run to N=3 inside the per-tx CPU budget when paying fees from a fee shard, and to N=4 when paying via wallet collateral. The optimization branch parks the rest of the gain under `post-v1`.
- **No audit.** A formal review must precede any mainnet deployment.
- **Disclosure UX.** "Unaudited / Preprod only" surfaces are tracked under v1.0.0 hardening issues.
