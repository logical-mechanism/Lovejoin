# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. It is the design context for the codebase. The README is the 5-minute summary; ARCHITECTURE.md is the one-page contributor overview; this file captures the conventions, constraints, and decisions you need to be productive without re-deriving them.

## Status: live on Preprod; mainnet deployment in preparation

The codebase is post-build-phase. Validators are deployed and immutable on Preprod; the off-chain SDK, backend, and UI all ship against the live deployment; the hardening pass (lint baseline, test coverage, Playwright E2E in CI, governance docs, component READMEs, SDK TSDoc, backend OpenAPI, user-facing docs, internal security review, disclosure-UX pass, monitoring + runbook, release automation, Dependabot) is closed. Empirical caps are **N=3 via fee shard** and **N=4 via wallet collateral**, and lifting either is blocked on a Cardano `max_tx_ex_units` bump out of our control.

**Now: preparing the mainnet deployment of the same on-chain code.** No third-party audit will precede mainnet, and no bug bounty program is planned. The internal review pass is the only review the protocol will have before mainnet; that posture is reflected in [README.md](README.md) and [SECURITY.md](SECURITY.md) and must not be silently contradicted in user-facing copy.

Day-to-day work flows through ordinary GitHub issues against `dev`; PRs target `dev` and roll up to `main` periodically (see the branch model in [CONTRIBUTING.md](CONTRIBUTING.md)). The historical commit log carries the build narrative; [CHANGELOG.md](CHANGELOG.md) is the user-facing record of what shipped and when.

## What this project is

Lovejoin is a Cardano-native privacy mixer implementing **Sigmajoin** ([papers/sigmajoin.pdf](papers/sigmajoin.pdf)), an outsourceable variant of Zerojoin. It is designed as a **hyperstructure**: the on-chain protocol is permissionless and immutable, and anyone can run a UI or backend.

Three operations: **Deposit** (locks fixed-denom ADA into a mix-box, replenishes a fee shard), **Mix** (re-randomizes N pool boxes for `2 ≤ N ≤ max_n` via N-way sigma-OR proof, fully wallet-anonymous), **Withdraw** (Schnorr-proof spend by the original depositor). Privacy: `(1/N)^k` linkage probability after k mixes at width N.

## Architectural pillars

These four ideas thread through every component. The math is in [`papers/sigmajoin.pdf`](papers/sigmajoin.pdf); the rules are in the validators in [contracts/validators/](contracts/validators/) and the test files alongside them.

1. **Hyperstructure via reference UTxO.** A single permanent UTxO at the always-False [`reference_holder`](contracts/validators/reference_holder.ak) validator holds the protocol NFT and a `ProtocolParams` inline datum (`denom_lovelace`, `max_fee_per_mix_lovelace`, three script hashes). All validators read parameters from `tx.reference_inputs` at spend time. Bootstrap is a one-shot, irreversible ceremony per network. `max_n` is not on-chain; the validator only enforces `N ≥ 2`, and the upper cap is a tx-construction concern surfaced through `network.<net>.json`. `fee_shard_target` (=10) is similarly off-chain coordination, kept on-chain today.

2. **Variable-N sigma-OR proof.** The Mix branch verifies an N-way sigma-OR for each input. `2 ≤ N`, with the practical cap calibrated empirically. Per-tx cost is dominated by `~2N²` `bls12_381_g1_uncompress` calls plus `~4N²` scalar muls. Live Preprod testing shows the deployed validator runs to N=3 inside the per-tx CPU budget for the fee-shard path, N=4 for wallet collateral. See [docs/perf.md](docs/perf.md) for the empirical numbers.

   **Validator split:** the on-chain logic is split into two validators following the withdraw-zero pattern. [contracts/validators/mix_box.ak](contracts/validators/mix_box.ak) is a cheap spend-side delegator that defers to a single per-tx execution of [contracts/validators/mix_logic.ak](contracts/validators/mix_logic.ak) (the withdraw-zero validator that handles Owner + Mix logic once for the whole tx).

3. **Mandatory collateral provider for Mix txs.** Mix txs have **no submitter wallet input or signature**. Cardano still requires a collateral input (key-witnessed); it comes from an external service ([giveme.my](https://giveme.my/) by default, pluggable via the `CollateralProvider` interface in [offchain/src/tx/collateral.ts](offchain/src/tx/collateral.ts)). If the provider is unreachable, Mix submission is **blocked**. There is no fallback to wallet-collateral, because that would defeat wallet anonymity. Deposit and Withdraw use `WalletProvider` today; making `GivemeMyProvider` the default for those too is deferred so fresh wallets do not need a 5-ADA collateral UTxO.

4. **Sharded fee contract.** A logical pool of exactly 10 fee UTxOs at the [`fee_contract`](contracts/validators/fee_contract.ak) script. Two redeemers: `PayMixFee` (consumed by a Mix tx, requires `fee_in.lovelace − fee_out.lovelace == tx.fee` and `tx.fee ≤ max_fee_per_mix_lovelace`) and `Replenish` (top up by a Deposit, strict value increase). Both paths preserve shard count. SDK + backend pick shards uniformly at random for concurrency. The mempool-aware path also avoids shards already pending in flight.

## The build-blocker risk (read this before writing crypto)

**TS to Aiken encoding parity.** The Fiat-Shamir challenge is computed in _both_ TS (when proving) and Aiken (when verifying). A one-byte difference in CBOR encoding silently fails every proof on chain. The parity tests are at [offchain/test/crypto/encoding-parity.test.ts](offchain/test/crypto/encoding-parity.test.ts) and [contracts/lib/lovejoin/encoding_parity_kat.test.ak](contracts/lib/lovejoin/encoding_parity_kat.test.ak); both run in CI. Before writing or changing any sigma-protocol code, run the parity tests; if parity fails, fix the encoding before doing anything else.

Two related encoding rules:

- The Mix `ctx` hashes only the **N mix outputs** (positions 0..N−1), _not_ the fee-contract output. The fee-contract output's value depends on `tx.fee`, which depends on the proof size, so hashing it would create a circular dependency.
- Mix outputs MUST be at the first N positions of `tx.outputs` (positions 0..N−1). The validator enforces this.

## Component layout

```
contracts/   Aiken 1.1.21, Plutus V3, BLS12-381 G1. Validators: reference_holder, one_shot_mint, mix_box, mix_logic (withdraw-zero), fee_contract.
offchain/    TypeScript SDK (@lovejoin/sdk): crypto/ + tx/ (deposit, withdraw, mix, fee, donate, params, collateral, mesh-bridge) + chain/ (ChainProvider abstraction with BlockfrostProvider) + pool/ (identify, select) + wallet/ (cip30, seed) + cli/.
backend/     Node + Fastify. backend/src/{indexer/{ogmios,runtime,state,datum,mempool,types},db/dbsync,api/{server,routes},config,address}. Acts as the second ChainProvider implementation.
ui/          React 19 + Vite + Tailwind v4 + react-i18next + mesh. ui/src/{routes/{Home,Pool,Vault,Box,Deposit,Withdraw,Mix,Protocol,Layout}, components/, lib/{sdk,vault,pool,backend,seedelf,bech32,store,collateral-status,polyfill}, storage/secrets, i18n/}.
crypto/      Rust reference impl using `blst` for KAT generation, plus `crypto/test-vectors/{provedlog,provedhtuple,sigma-or,negative,encoding-parity}.json`.
infra/bootstrap/  cardano-cli shell scripts: 00-build-reference, 01a-publish, 01b-register, 02-mint-and-lock, 03-fund-fee-contract, plus init-wallet/balance/prep-utxos helpers.
integration-tests/, stress-tests/, bench/   Preprod harnesses driven via Blockfrost.
config/network.{test,preprod,mainnet}.json   Read into the on-chain reference UTxO at bootstrap.
artifacts/{test,preprod}/   Compiled .plutus and addresses.json (preprod is the live deployment).
```

Workspace tool: **pnpm 10**. Top-level `Makefile` targets: `make install`, `make build`, `make test`, `make lint` (tsc --noEmit + eslint + prettier --check across TS workspaces + aiken fmt --check), `make format` (prettier --write + eslint --fix), `make contracts`, `make ui-dev`, `make backend-dev`, `make cli`/`make deposit`/`make withdraw`/`make integration-test` (.env-driven), `make clean`. `make help` lists them all. A husky `pre-commit` hook runs `lint-staged` (prettier + eslint --fix on staged files); fix locally rather than `--no-verify`. See [README.md](README.md) for the local-dev gotcha (snap-shim `node` under VSCode breaks pnpm; use nvm node on PATH).

## Mesh tx-builder workarounds

Mesh handles the unconventional Mix tx shape (no submitter wallet input, externally-supplied collateral, exact-fee constraint linking shard input to shard output via `tx.fee`). The non-obvious workarounds, recorded for anyone touching the tx-builders: force Blockfrost ogmios v6 for evaluation; `*TxInReference` takes `scriptSize` + `scriptHash`; REWARD vs WITHDRAW tagging matters for the withdraw-zero leg. Full notes in [docs/perf.md](docs/perf.md).

## Conventions baked into the codebase

- **Aiken pinned to 1.1.21** ([contracts/aiken.toml](contracts/aiken.toml)). Bumps are deliberate.
- **Curve: BLS12-381 G1 only.** Compressed group elements are 48 bytes; scalars are 32 bytes big-endian, strictly less than `r`. No pairings, no G2, no custom curves.
- **Hash: blake2b-256** (Plutus builtin). Domain tag `"lovejoin/sigmajoin/v1/"`. Statement IDs: `0x01`=proveDlog, `0x02`=proveDHTuple, `0x03`=sigma-or-N (with N as a 1-byte prefix).
- **Nonces: RFC 6979 deterministic via HMAC-SHA256-DRBG** in TS; Aiken does not generate nonces (verifier only). Secret keys still come from a CSPRNG (`crypto.getRandomValues` / `crypto.randomBytes`). See [offchain/src/crypto/nonce.ts](offchain/src/crypto/nonce.ts).
- **Owner branch has no signer requirement.** Schnorr proof binds to `blake2b_256(serialize(tx.outputs) || serialize(tx.inputs[].output_reference) || mixScriptHash)`; output substitution invalidates the proof. The input-reference binding (F-4) prevents replay against duplicate `(a, b)` pairs.
- **Inline datums only** for mix-boxes. `MixDatum { a: ByteArray(48), b: ByteArray(48) }`; validator rejects `a == b` or wrong length.
- **Spend validators tolerate bad/missing datums** (return True) per the hyperstructure principle; `mix_logic` silently ignores malformed mix inputs.
- **Mix outputs are tagged with a per-network dApp stake key** (`dapp_stake_key_hash` in `network.<net>.json`) so all live boxes share a stake credential and the indexer can find them with one address filter.
- **i18n parity is enforced.** Lint rule rejects raw English in JSX components; English canonical in `ui/src/i18n/locales/en.json`. The lint subprocess is pinned to `process.execPath` to avoid the snap-shim node trap. Supported locales are registered in [ui/src/i18n/languages.ts](ui/src/i18n/languages.ts) (BCP-47 code + native name + `dir`); non-English locales fall back to English for missing keys, and RTL languages (`ar`, `ur`, `fa`, ...) flip the document direction via the registry's `dir` flag rather than per-string overrides. The check-i18n test in [ui/test/check-i18n.test.ts](ui/test/check-i18n.test.ts) enforces 20-locale parity and runs in CI.
- **Wallet-derived vault is the default identity.** On first unlock the connected CIP-30 wallet does one `signData(stakeAddr, "lovejoin/owner/v1")` round-trip; Ed25519 (RFC 8032) is deterministic, so the signature is stable across calls and browsers. `seed = blake2b_256(signature_bytes)`; per-deposit owner secret `x_i = scalar_from_hkdf(seed, "lovejoin/owner/v1", i) mod r`. Seed lives in memory for the session only; IndexedDB stores nothing about the seed. See [offchain/src/wallet/seed.ts](offchain/src/wallet/seed.ts). PKH+password recovery vault is a fallback for wallets that do not expose `signData`.
- **No analytics, no telemetry, no cookies.** Backend logs IPs only for rate limiting, retention < 24h.
- **No user-facing config panel in production.** Backend URL, Blockfrost fallback project ID, and collateral-provider endpoint are baked at build time via `VITE_BACKEND_URL`, `VITE_BLOCKFROST_PROJECT_ID`, `VITE_COLLATERAL_ENDPOINT`. `?advanced=1` unlocks an overrides panel for local debugging.

## ChainProvider abstraction

Everything that talks to chain (SDK, UI, integration tests, stress tests, backend itself) goes through the [`ChainProvider`](offchain/src/chain/provider.ts) interface: `submitTx`, `getUtxos`, `awaitConfirmation`, `getReferenceUtxo`, `getProtocolParams`. Two implementations exist: [`BlockfrostProvider`](offchain/src/chain/blockfrost.ts) (the default for SDK consumers) and [`BackendChainProvider`](offchain/src/chain/backend.ts) (the self-hosted indexer + db-sync, with Blockfrost fallback). They are runtime-swappable via `network.<net>.json`'s `provider` block. Mesh tx-building is wired through a `meshProvider()` sibling on each implementation so the same fetcher/submitter shape is available in both query and tx-builder paths.

Implication for new code: never call Blockfrost directly. Add capabilities to `ChainProvider` and let the backend grow a matching implementation.

## Testing posture

KAT vectors are the cross-language ground truth. They are generated by the Rust reference impl ([crypto/ref/](crypto/ref/) using `blst`) and stored as JSON in [crypto/test-vectors/](crypto/test-vectors/). Each vector must verify in (1) the TS prover (re-derive bytes via RFC 6979, exact match required), (2) the TS verifier, (3) the Aiken validator, and (4) the Rust ref. Negative vectors must be rejected by all three verifiers. 200 positive vectors per N ∈ {2, 3, 4, 6, 8}, plus negatives.

Validator tests target 100% rule coverage. Every invariant enforced by a validator must have both a positive and a negative test in the validator's `*.test.ak` file; CI fails on coverage gaps. Stress tests live in [stress-tests/](stress-tests/) (max-n calibration, fee calibration, fuzz) and run against Preprod via Blockfrost; they update [docs/perf.md](docs/perf.md) and `config/network.preprod.json`. Integration tests in [integration-tests/](integration-tests/) cover deposit-withdraw round-trips, full-lifecycle, mix-n2, mix-at-max-n, and fee-exhaustion. UI E2E uses Playwright on Preprod ([ui/](ui/) `pnpm test:e2e`).

Watch out for the simulator/chain parity trap: `aiken simulate` caches original parse bytes through `serialise_data`, but the chain re-canonicalises. Build parity tests from record literals rather than trusting simulated round-trips.

## Out of scope (do not add unless asked)

Confidential amounts, cross-chain, account-model compatibility, native asset pools, multi-denomination, dedicated mixer-bot service, stealth withdraw (use Seedelf at the wallet layer), decentralized collateral provider.

## Reading order for new contributors

1. [README.md](README.md). 5-minute summary.
2. [ARCHITECTURE.md](ARCHITECTURE.md). One-page contributor overview with mermaid diagrams of the four pillars and the three operations.
3. This file. Conventions and constraints.
4. [papers/sigmajoin.pdf](papers/sigmajoin.pdf). The math.
5. The validators in [contracts/validators/](contracts/validators/) and their `*.test.ak` siblings. The on-chain rules and their positive/negative coverage.
6. The sub-package READMEs: [contracts/README.md](contracts/README.md), [offchain/README.md](offchain/README.md), [backend/README.md](backend/README.md), [ui/README.md](ui/README.md), [crypto/README.md](crypto/README.md), [infra/bootstrap/README.md](infra/bootstrap/README.md), [stress-tests/README.md](stress-tests/README.md). Each one explains its layer.
