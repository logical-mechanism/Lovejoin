# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning

Lovejoin does not yet expose a stable public API surface, so we don't follow [SemVer](https://semver.org/) yet. Instead, each section is dated to the day a `dev` branch rollup merged into `main`. Day-to-day work accumulates under `Unreleased` while it lives on `dev`; on rollup day we rename `Unreleased` to that day's date and open a fresh `Unreleased` section. We will switch to SemVer when the API surface stabilises.

## [Unreleased]

## [2026-05-06]

Public-readiness pass: reconciled the disclosure narrative across README, SECURITY, CLAUDE, and the UI to match the actual posture (no third-party audit, no bug bounty, mainnet deployment of the same contracts in preparation).

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
