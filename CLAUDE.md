# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status: alpha on Preprod; v1.0.0 hardening in flight

M0 through M7 have landed end-to-end on Preprod. The deployed protocol is the v1 protocol — empirical caps are **N=3 via fee shard** and **N=4 via wallet collateral**, and lifting either is blocked on a Cardano `max_tx_ex_units` bump (out of our control). M4.5's "redeploy with optimized validators" path is therefore closed; the optimization landed where it could and the rest is parked under `post-v1`.

**Remaining for v1.0.0**: engineering hardening — ESLint/Prettier baseline, test coverage instrumentation, Playwright E2E in CI, repo-governance docs, component READMEs, SDK TSDoc + backend OpenAPI, user-facing docs, security review + bounty, "unaudited / Preprod only" disclosure UX, custom domain (`lovejo.in` prod + `preprod.lovejo.in` staging), monitoring + runbook, semver-tag-driven releases + Dependabot, stale-doc cleanup, pre-launch verification.

This work is tracked as 15 GitHub issues on the `v1.0.0` milestone (`gh issue list --milestone v1.0.0`), not as sub-milestones in [milestones.json](milestones.json). The plan that broke them out is at `/home/logic/.claude/plans/we-are-going-to-abundant-backus.md`. Run `/work <issue-number>` (e.g. `/work 36`) to start a session on any of them. Deferred items live under the `post-v1` label.

When in doubt, treat [docs/spec/](docs/spec/) as authoritative. The README is a summary; the spec is canonical. [milestones.json](milestones.json) is the source of truth for milestone-scoped work (M0–M7); the `/milestones` slash command lists them. For v1.0.0 hardening work, GitHub issues are the source of truth and `/work <issue-number>` is the entry point.

## What this project is

Lovejoin is a Cardano-native privacy mixer implementing **Sigmajoin** ([papers/sigmajoin.pdf](papers/sigmajoin.pdf)), an outsourceable variant of Zerojoin. It is designed as a **hyperstructure**: the on-chain protocol is permissionless and immutable, and anyone can run a UI or backend.

Three operations: **Deposit** (locks fixed-denom ADA into a mix-box, replenishes a fee shard), **Mix** (re-randomizes N pool boxes for `2 ≤ N ≤ max_n` via N-way sigma-OR proof, fully wallet-anonymous), **Withdraw** (Schnorr-proof spend by the original depositor). Privacy: `(1/N)^k` linkage probability after k mixes at width N.

## Architectural pillars (all needed to be productive)

These four ideas thread through every component. Read the corresponding spec section before changing any of them.

1. **Hyperstructure via reference UTxO.** A single permanent UTxO at the always-False `reference_holder` validator holds the protocol NFT and a `ProtocolParams` inline datum (denomination, `max_fee_per_mix_lovelace`, script hashes). All validators read parameters from `tx.reference_inputs` at spend time. Bootstrap is a one-shot, irreversible ceremony per network. Note: `max_n` was dropped from the on-chain datum during M2 (the validator only enforces `N ≥ 2`; the upper cap is a tx-construction concern surfaced through `network.<net>.json`). `fee_shard_target` (=10) is similarly off-chain coordination — kept on-chain today but slated for removal post-redeploy. See [docs/spec/03-contracts.md](docs/spec/03-contracts.md) §1.

2. **Variable-N sigma-OR proof.** The Mix branch verifies an N-way sigma-OR for each input — `2 ≤ N`, with the practical cap calibrated empirically. Per-tx cost is dominated by `~2N²` `bls12_381_g1_uncompress` calls plus `~4N²` scalar muls. Live Preprod testing (post-M4) shows the deployed validator runs to N=3 inside the per-tx CPU budget; N=4 overshoots. M4.5 is an optimisation + redeploy pass aimed at lifting that ceiling. See [docs/spec/02-cryptography.md](docs/spec/02-cryptography.md) §"N-way Sigma-OR", [docs/spec/03-contracts.md](docs/spec/03-contracts.md) §2, and [docs/perf.md](docs/perf.md) for the empirical numbers.

   **Validator split (M2 refactor):** the on-chain logic is split into two validators following the withdraw-zero pattern. [contracts/validators/mix_box.ak](contracts/validators/mix_box.ak) is a cheap spend-side delegator that defers to a single per-tx execution of [contracts/validators/mix_logic.ak](contracts/validators/mix_logic.ak) (the withdraw-zero validator that handles Owner + Mix logic once for the whole tx). This is meaningfully different from the original spec's "mix-box runs once per input" model — read [docs/spec/03-contracts.md](docs/spec/03-contracts.md) §0 before changing either file.

3. **Mandatory collateral provider for Mix txs.** Mix txs have **no submitter wallet input or signature**. Cardano still requires a collateral input (key-witnessed); it comes from an external service ([giveme.my](https://giveme.my/) by default, pluggable via the `CollateralProvider` interface in [offchain/src/tx/collateral.ts](offchain/src/tx/collateral.ts)). If the provider is unreachable, Mix submission is **blocked** — there is _no_ fallback to wallet-collateral, because that would defeat wallet anonymity. Deposit and Withdraw use `WalletProvider` today; making `GivemeMyProvider` the default for those too is deferred to M5 so fresh wallets don't need a 5-ADA collateral UTxO. See [docs/spec/01-protocol.md](docs/spec/01-protocol.md) §"Collateral provider".

4. **Sharded fee contract.** A logical pool of exactly 10 fee UTxOs at the `fee_contract` script. Two redeemers: `PayMixFee` (consumed by a Mix tx, requires `fee_in.lovelace − fee_out.lovelace == tx.fee` and `tx.fee ≤ max_fee_per_mix_lovelace`) and `Replenish` (top up by a Deposit, strict value increase). Both paths preserve shard count. SDK + backend pick shards uniformly at random for concurrency. See [docs/spec/03-contracts.md](docs/spec/03-contracts.md) §3.

## The build-blocker risk (read this before writing crypto)

**TS↔Aiken encoding parity.** The Fiat-Shamir challenge is computed in _both_ TS (when proving) and Aiken (when verifying). A one-byte difference in CBOR encoding silently fails every proof on chain. Per [docs/spec/12-build-guide.md](docs/spec/12-build-guide.md) §"Risk 1": **before writing any sigma-protocol code**, write a parity test that serializes random `MixDatum { a, b }` in both TS (cbor-x) and Aiken, dumps bytes, and asserts byte-equal across 1000 random cases. Same for value serialization, same for `tx.outputs` if FS-hashed. If parity fails, fix the encoding before doing anything else.

Two related encoding rules baked into the spec:

- The Mix `ctx` hashes only the **N mix outputs** (positions 0..N−1), _not_ the fee-contract output. The fee-contract output's value depends on `tx.fee`, which depends on the proof size — so hashing it would create a circular dependency. See [docs/spec/02-cryptography.md](docs/spec/02-cryptography.md) §"Context binding" and the "All my proofs fail but the math looks right" pitfall in [docs/spec/12-build-guide.md](docs/spec/12-build-guide.md).
- Mix outputs MUST be at the first N positions of `tx.outputs` (positions 0..N−1). The validator enforces this. See [docs/spec/03-contracts.md](docs/spec/03-contracts.md) §2 rule 2.

## Component layout

```
contracts/   Aiken 1.1.21, Plutus V3, BLS12-381 G1. Validators: reference_holder, one_shot_mint, mix_box, mix_logic (withdraw-zero), fee_contract.
offchain/    TypeScript SDK (@lovejoin/sdk): crypto/ + tx/ (deposit, withdraw, mix, fee, params, collateral, mesh-bridge) + chain/ (ChainProvider abstraction with BlockfrostProvider) + pool/ (identify, select) + wallet/ (cip30, seed) + cli/.
backend/     Node + Fastify. backend/src/{indexer/{ogmios,runtime,state,datum,types},db/dbsync,api/{server,routes},config,address}. Acts as the second ChainProvider implementation.
ui/          React 19 + Vite + Tailwind v4 + react-i18next + mesh. ui/src/{routes/{Home,Pool,Vault,Box,Deposit,Withdraw,Mix,Protocol,Layout}, components/, lib/{sdk,vault,pool,backend,seedelf,bech32,store,collateral-status,polyfill}, storage/secrets, i18n/}.
crypto/      Rust reference impl using `blst` for KAT generation, plus `crypto/test-vectors/{provedlog,provedhtuple,sigma-or,negative,encoding-parity}.json`.
infra/bootstrap/  cardano-cli shell scripts: 00-build-reference, 01a-publish, 01b-register, 02-mint-and-lock, 03-fund-fee-contract, plus init-wallet/balance/prep-utxos helpers.
integration-tests/, stress-tests/, bench/   Preprod harnesses driven via Blockfrost.
config/network.{test,preprod,mainnet}.json   Read into the on-chain reference UTxO at bootstrap.
artifacts/{test,preprod}/   Compiled .plutus and addresses.json (preprod is the live alpha deployment).
```

Workspace tool: **pnpm 10**. Top-level `Makefile` targets: `make install`, `make build`, `make test`, `make lint` (aiken fmt --check + tsc --noEmit), `make contracts`, `make ui-dev`, `make backend-dev`, `make cli`/`make deposit`/`make withdraw`/`make integration-test` (.env-driven), `make clean` (`make help` lists them all). See [README.md](README.md) §Develop for the local-dev gotcha (snap-shim `node` under VSCode breaks pnpm; use nvm node on PATH).

## Build history (what shipped vs. what's next)

The crypto and validator stacks were built bottom-up; each layer depends on the one below. The order is preserved here for orientation.

- **Crypto (M1, done):** BLS wrappers → blake2b/FS hash + parity test → RFC 6979 nonce → Schnorr → DH-tuple → 2-way sigma-OR → N-way sigma-OR → Rust reference. Three independent implementations (TS, Aiken, Rust) agree on bytes for KAT vectors at N ∈ {2, 3, 4, 6, 8}.
- **Validators (M2, done):** types/helpers → `one_shot_mint` → `reference_holder` → `mix_logic` (withdraw-zero, runs once per tx) → `mix_box` (cheap delegator) → `fee_contract` → variable N → bootstrap scripts. The `max_n` calibration sweep moved to M4 because it needs a real Mix tx builder.
- **Mesh viability (M3, resolved):** mesh handles the unconventional Mix tx shape (no submitter wallet input, externally-supplied collateral, exact-fee constraint linking shard input to shard output via `tx.fee`). No switch to lucid-evolution. The decision + the workarounds we needed (forcing Blockfrost ogmios v6 for evaluation, `*TxInReference` taking scriptSize + scriptHash, REWARD vs WITHDRAW tagging) are recorded in [docs/perf.md](docs/perf.md) §"M3 — mesh viability assessment".
- **Open optimisation work (M4.5, pending):** N=4 overshoots the per-tx CPU budget on the validator we shipped at M4. Cost is dominated by `bls12_381_g1_uncompress` (≈25–30M CPU each), then `scalar_mul` (≈10M), then `blake2b_256` (≈4M). One optimisation already landed on M4: pre-uncompressing sigma-OR statements in `mix_logic` (drops N² uncompresses to N). M4.5's remaining job is the rest of the audit + a fresh Preprod redeploy + re-calibration. The redeploy is irreversible — old fee shards and boxes get orphaned.

## Conventions baked into the spec

- **Aiken pinned to 1.1.21** ([docs/spec/07-testing.md](docs/spec/07-testing.md), OQ-F). Bumps are deliberate.
- **Curve: BLS12-381 G1 only.** Compressed group elements are 48 bytes; scalars are 32 bytes big-endian, strictly less than `r`. No pairings, no G2, no custom curves.
- **Hash: blake2b-256** (Plutus builtin). Domain tag `"lovejoin/sigmajoin/v1/"`. Statement IDs: `0x01`=proveDlog, `0x02`=proveDHTuple, `0x03`=sigma-or-N (with N as a 1-byte prefix).
- **Nonces: RFC 6979 deterministic via HMAC-SHA256-DRBG** in TS; Aiken doesn't generate nonces (verifier only). Secret keys still come from a CSPRNG (`crypto.getRandomValues` / `crypto.randomBytes`). See [docs/spec/02-cryptography.md](docs/spec/02-cryptography.md) §"Nonce generation".
- **Owner branch has no signer requirement.** Schnorr proof binds to `blake2b_256(serialize(tx.outputs) || mixScriptHash)`; output substitution invalidates the proof. Mirrors Seedelf. See [docs/spec/03-contracts.md](docs/spec/03-contracts.md) §5.
- **Inline datums only** for mix-boxes. `MixDatum { a: ByteArray(48), b: ByteArray(48) }`; validator rejects `a == b` or wrong length.
- **Spend validators tolerate bad/missing datums** (return True) per the hyperstructure principle; `mix_logic` silently ignores malformed mix inputs. This was an M2 decision against the original spec.
- **Mix outputs are tagged with a per-network dApp stake key** (`dapp_stake_key_hash` in `network.<net>.json`) so all live boxes share a stake credential and the indexer can find them with one address filter.
- **i18n from M0.** Lint rule rejects raw English in JSX components; English canonical in `ui/src/i18n/locales/en.json`. The lint subprocess is pinned to `process.execPath` to avoid the snap-shim node trap. Supported locales are registered in [ui/src/i18n/languages.ts](ui/src/i18n/languages.ts) (BCP-47 code + native name + `dir`); non-English locales fall back to English for missing keys, and RTL languages (`ar`, `ur`, `fa`, …) flip the document direction via the registry's `dir` flag rather than per-string overrides.
- **Wallet-derived vault is the default identity.** On first unlock the connected CIP-30 wallet does one `signData(stakeAddr, "lovejoin/owner/v1")` round-trip; Ed25519 (RFC 8032) is deterministic, so the signature is stable across calls and browsers. `seed = blake2b_256(signature_bytes)`; per-deposit owner secret `x_i = scalar_from_hkdf(seed, "lovejoin/owner/v1", i) mod r`. Seed lives in memory for the session only — IndexedDB stores nothing about the seed. See [offchain/src/wallet/seed.ts](offchain/src/wallet/seed.ts). BIP-39 mnemonic + Argon2id-encrypted IndexedDB is a fallback for hardware wallets that don't expose `signData`.
- **No analytics, no telemetry, no cookies.** Backend logs IPs only for rate limiting, retention < 24h. See [docs/spec/06-ui.md](docs/spec/06-ui.md) §"Privacy UX rules".
- **No user-facing config panel in production.** Backend URL, Blockfrost fallback project ID, and collateral-provider endpoint are baked at build time via `VITE_BACKEND_URL`, `VITE_BLOCKFROST_PROJECT_ID`, `VITE_COLLATERAL_ENDPOINT`. `?advanced=1` unlocks an overrides panel for local debugging.

## ChainProvider abstraction

Everything that talks to chain (SDK, UI, integration tests, stress tests, backend itself) goes through the [`ChainProvider`](offchain/src/chain/provider.ts) interface: `submitTx`, `getUtxos`, `awaitConfirmation`, `getReferenceUtxo`, `getProtocolParams`. Two implementations exist: [`BlockfrostProvider`](offchain/src/chain/blockfrost.ts) (the default, drives the alpha) and the self-hosted backend (`backend/src/indexer` + `backend/src/api`). They are runtime-swappable via `network.<net>.json`'s `provider` block. Mesh is wired through a `meshProvider()` sibling for tx-builder code paths; collapsing it into the same `IFetcher`/`ISubmitter` shape that mesh expects is deferred to M5/post-cleanup.

Implication for new code: never call Blockfrost directly. Add capabilities to `ChainProvider` and let the backend grow a matching implementation.

## Testing posture

KAT vectors are the cross-language ground truth. They are generated by the **Rust reference impl** (`crypto/ref/` using `blst`) and stored as JSON in `crypto/test-vectors/`. Each vector must verify in (1) the TS prover (re-derive bytes via RFC 6979 — exact match required), (2) the TS verifier, (3) the Aiken validator, and (4) the Rust ref. Negative vectors must be rejected by all three verifiers. 200 positive vectors per N ∈ {2, 3, 4, 6, 8}, plus negatives.

Validator tests target 100% rule coverage — every rule in [docs/spec/03-contracts.md](docs/spec/03-contracts.md) §1–§3 must have both a positive and a negative test (CI fails otherwise). Stress tests live in [stress-tests/](stress-tests/) (max-n calibration, fee calibration, fuzz) and run against Preprod via Blockfrost; they update [docs/perf.md](docs/perf.md) and `config/network.preprod.json`. Integration tests in [integration-tests/](integration-tests/) cover deposit-withdraw round-trips, full-lifecycle, mix-n2, mix-at-max-n, and fee-exhaustion. UI E2E uses Playwright on Preprod ([ui/](ui/) `pnpm test:e2e`).

Watch out for the simulator/chain parity trap: `aiken simulate` caches original parse bytes through `serialise_data`, but the chain re-canonicalises. Build parity tests from record literals rather than trusting simulated round-trips.

## Out of scope for v1 (don't add these unless asked)

Confidential amounts, cross-chain, account-model compatibility, native asset pools, multi-denomination, dedicated mixer-bot service, stealth withdraw (use Seedelf at the wallet layer), decentralized collateral provider, mainnet deployment. See [docs/spec/00-overview.md](docs/spec/00-overview.md) §"Non-goals" and OQ-Y in [docs/spec/11-open-questions.md](docs/spec/11-open-questions.md).

## Reading order for new contributors

1. [README.md](README.md) — 5-min summary.
2. [docs/spec/00-overview.md](docs/spec/00-overview.md) — system + architecture diagram.
3. [docs/spec/12-build-guide.md](docs/spec/12-build-guide.md) — order of attack, risks, pitfalls. **The most useful single doc when starting work.**
4. [docs/spec/01-protocol.md](docs/spec/01-protocol.md), [02-cryptography.md](docs/spec/02-cryptography.md), [03-contracts.md](docs/spec/03-contracts.md) — for implementers, in order.
5. [docs/spec/08-threat-model.md](docs/spec/08-threat-model.md) — for auditors, first.
