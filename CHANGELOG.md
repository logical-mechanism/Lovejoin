# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning

Lovejoin is alpha on Preprod and does not yet expose a public API surface, so we don't follow [SemVer](https://semver.org/) yet. Instead, each section is dated to the day a `dev` branch rollup merged into `main`. Day-to-day work accumulates under `Unreleased` while it lives on `dev`; on rollup day we rename `Unreleased` to that day's date and open a fresh `Unreleased` section.

We will switch to SemVer at v1.0.0, when the audit / mainnet boundary makes versioning a real contract with users.

## [Unreleased]

### Added

- Repo governance and open-source artifacts: `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1 by reference), `CODEOWNERS`, `.editorconfig`, GitHub issue templates (bug, feature, security pointer), GitHub PR template, and this changelog.

### Changed

- Switched the changelog versioning model from SemVer-style `[0.7.0]` to date-based `[YYYY-MM-DD]` entries, one per `dev → main` rollup, until v1.0.0.

## [2026-05-01]

Snapshot of `main` at the most recent `dev → main` rollup (PR #62). Consolidates M0 through M7 — the work that brought the repo from green-field to a working alpha on Preprod. Individual commits are the authoritative history; this entry gives the shape of what landed.

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
