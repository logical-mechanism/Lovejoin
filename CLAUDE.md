# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status: M0 done; pre-alpha

M0 (foundations and tooling) has landed. The monorepo skeleton (`contracts/`, `offchain/`, `backend/`, `ui/`, `infra/bootstrap/`, plus `crypto/`, `bench/`, `integration-tests/`, `stress-tests/`), the `Makefile`, the pnpm workspace, the GitHub Actions workflow, the Aiken project pinned to **1.1.21**, and the React 19 + Vite + Tailwind v4 + react-i18next UI scaffold all exist on disk. From here, spec sections about `contracts/lib/lovejoin/*.ak`, `offchain/src/crypto/*.ts`, validators, and bootstrap scripts describe **what is yet to be implemented** within those existing directories — verify with the filesystem before assuming a module is present.

When in doubt, treat [docs/spec/](docs/spec/) as authoritative. The README is a summary; the spec is canonical.

## What this project is

Lovejoin is a Cardano-native privacy mixer implementing **Sigmajoin** ([papers/sigmajoin.pdf](papers/sigmajoin.pdf)), an outsourceable variant of Zerojoin. It is designed as a **hyperstructure**: the on-chain protocol is permissionless and immutable, and anyone can run a UI or backend.

Three operations: **Deposit** (locks fixed-denom ADA into a mix-box, replenishes a fee shard), **Mix** (re-randomizes N pool boxes for `2 ≤ N ≤ max_n` via N-way sigma-OR proof, fully wallet-anonymous), **Withdraw** (Schnorr-proof spend by the original depositor). Privacy: `(1/N)^k` linkage probability after k mixes at width N.

## Architectural pillars (all needed to be productive)

These four ideas thread through every component. Read the corresponding spec section before changing any of them.

1. **Hyperstructure via reference UTxO.** A single permanent UTxO at the always-False `reference_holder` validator holds the protocol NFT and a `ProtocolParams` inline datum (denomination, `max_fee_per_mix_lovelace`, `max_n`, script hashes, `fee_shard_target`). All validators read parameters from `tx.reference_inputs` at spend time. Bootstrap is a one-shot, irreversible ceremony per network. See [docs/spec/03-contracts.md](docs/spec/03-contracts.md) §1.

2. **Variable-N sigma-OR proof.** The Mix branch verifies an N-way sigma-OR for each input — `2 ≤ N ≤ max_n`, where `max_n` is calibrated empirically (initial bet: 6, hard-capped by Cardano per-tx script CPU). The validator runs once per mix-input; each instance verifies its own N-way OR proof and they all see the same outputs (same `ctx`). Per-tx cost is `~2N²` scalar muls. See [docs/spec/02-cryptography.md](docs/spec/02-cryptography.md) §"N-way Sigma-OR" and [docs/spec/03-contracts.md](docs/spec/03-contracts.md) §2.

3. **Mandatory collateral provider for Mix txs.** Mix txs have **no submitter wallet input or signature**. Cardano still requires a collateral input (key-witnessed); it comes from an external service ([giveme.my](https://giveme.my/) by default, pluggable via the `CollateralProvider` interface). If the provider is unreachable, Mix submission is **blocked** — there is *no* fallback to wallet-collateral, because that would defeat wallet anonymity. Deposit and Withdraw use `WalletProvider` since the wallet is in the tx anyway. See [docs/spec/01-protocol.md](docs/spec/01-protocol.md) §"Collateral provider" and OQ-V/OQ-X in [docs/spec/11-open-questions.md](docs/spec/11-open-questions.md).

4. **Sharded fee contract.** A logical pool of exactly `fee_shard_target` (=10) fee UTxOs at the `fee_contract` script. Two redeemers: `PayMixFee` (consumed by a Mix tx, requires `fee_in.lovelace − fee_out.lovelace == tx.fee` and `tx.fee ≤ max_fee_per_mix_lovelace`) and `Replenish` (top up by a Deposit, strict value increase). Both paths preserve shard count. SDK + backend pick shards uniformly at random for concurrency. See [docs/spec/03-contracts.md](docs/spec/03-contracts.md) §3.

## The build-blocker risk (read this before writing crypto)

**TS↔Aiken encoding parity.** The Fiat-Shamir challenge is computed in *both* TS (when proving) and Aiken (when verifying). A one-byte difference in CBOR encoding silently fails every proof on chain. Per [docs/spec/12-build-guide.md](docs/spec/12-build-guide.md) §"Risk 1": **before writing any sigma-protocol code**, write a parity test that serializes random `MixDatum { a, b }` in both TS (cbor-x) and Aiken, dumps bytes, and asserts byte-equal across 1000 random cases. Same for value serialization, same for `tx.outputs` if FS-hashed. If parity fails, fix the encoding before doing anything else.

Two related encoding rules baked into the spec:

- The Mix `ctx` hashes only the **N mix outputs** (positions 0..N−1), *not* the fee-contract output. The fee-contract output's value depends on `tx.fee`, which depends on the proof size — so hashing it would create a circular dependency. See [docs/spec/02-cryptography.md](docs/spec/02-cryptography.md) §"Context binding" and the "All my proofs fail but the math looks right" pitfall in [docs/spec/12-build-guide.md](docs/spec/12-build-guide.md).
- Mix outputs MUST be at the first N positions of `tx.outputs` (positions 0..N−1). The validator enforces this. See [docs/spec/03-contracts.md](docs/spec/03-contracts.md) §2 rule 2.

## Component layout (planned)

```
contracts/   Aiken 1.1.21, Plutus V3, BLS12-381 G1. Validators: reference_holder, one_shot_mint, mix_box, fee_contract.
offchain/    TypeScript SDK (@lovejoin/sdk): crypto + tx builders + CIP-30 + collateral client. Published to npm.
backend/     Node + Fastify; ogmios chainsync + db-sync queries; REST API for pool/fee/params.
ui/          React 19 + Vite + Tailwind v4 + react-i18next + @meshsdk/react.
crypto/      Rust reference impl using `blst` for KAT generation, plus `crypto/test-vectors/`.
infra/bootstrap/  cardano-cli shell scripts for one-shot mint + reference UTxO + fee shards + reference scripts.
integration-tests/, stress-tests/, bench/   Preprod harnesses.
config/network.{test,preprod}.json   Read into the on-chain reference UTxO at bootstrap.
artifacts/{test,preprod}/   Compiled .plutus and addresses.json.
```

Workspace tool: **pnpm 10**. Top-level `Makefile` targets: `make install`, `make build`, `make test`, `make contracts`, `make ui-dev`, `make backend-dev`, `make clean` (`make help` lists them). See [README.md](README.md) §Develop for the local-dev gotcha (snap-shim `node` under VSCode breaks pnpm; use nvm node on PATH).

## Build order (do not skip layers)

The crypto and validator stacks both build bottom-up. Each layer depends on the one below. From [docs/spec/12-build-guide.md](docs/spec/12-build-guide.md):

- **Crypto (M1):** BLS wrappers → blake2b/FS hash + parity test → RFC 6979 nonce → Schnorr → DH-tuple → 2-way sigma-OR → N-way sigma-OR → Rust reference. Three independent implementations (TS, Aiken, Rust) must agree on bytes for KAT vectors at N ∈ {2, 3, 4, 6, 8}.
- **Validators (M2):** types/helpers → `one_shot_mint` → `reference_holder` → `mix_box` Owner → `mix_box` Mix at N=2 → `fee_contract` → generalize Mix to variable N → bootstrap scripts → `max_n` calibration on Preprod.
- **Vertical slice first (end of M3):** deposit + withdraw on Preprod with no UI, no mixing. Validates that mesh handles the unconventional Mix tx shape (no submitter wallet input, externally-supplied collateral, exact-fee constraint linking shard input to shard output via `tx.fee`). If mesh blocks the externally-supplied collateral path, switch to **lucid-evolution** before M4 (OQ-E).

## Conventions baked into the spec

- **Aiken pinned to 1.1.21** ([docs/spec/07-testing.md](docs/spec/07-testing.md), OQ-F). Bumps are deliberate.
- **Curve: BLS12-381 G1 only.** Compressed group elements are 48 bytes; scalars are 32 bytes big-endian, strictly less than `r`. No pairings, no G2, no custom curves.
- **Hash: blake2b-256** (Plutus builtin). Domain tag `"lovejoin/sigmajoin/v1/"`. Statement IDs: `0x01`=proveDlog, `0x02`=proveDHTuple, `0x03`=sigma-or-N (with N as a 1-byte prefix).
- **Nonces: RFC 6979 deterministic via HMAC-SHA256-DRBG** in TS; Aiken doesn't generate nonces (verifier only). Secret keys still come from a CSPRNG (`crypto.getRandomValues` / `crypto.randomBytes`). See [docs/spec/02-cryptography.md](docs/spec/02-cryptography.md) §"Nonce generation".
- **Owner branch has no signer requirement.** Schnorr proof binds to `blake2b_256(serialize(tx.outputs) || mixScriptHash)`; output substitution invalidates the proof. Mirrors Seedelf. See [docs/spec/03-contracts.md](docs/spec/03-contracts.md) §5.
- **Inline datums only** for mix-boxes. `MixDatum { a: ByteArray(48), b: ByteArray(48) }`; validator rejects `a == b` or wrong length.
- **i18n from M0.** Lint rule rejects raw English in JSX components; English canonical in `ui/src/i18n/locales/en.json`.
- **No analytics, no telemetry, no cookies.** Backend logs IPs only for rate limiting, retention < 24h. See [docs/spec/06-ui.md](docs/spec/06-ui.md) §"Privacy UX rules".

## Testing posture

KAT vectors are the cross-language ground truth. They are generated by the **Rust reference impl** (`crypto/ref/` using `blst`) and stored as JSON in `crypto/test-vectors/`. Each vector must verify in (1) the TS prover (re-derive bytes via RFC 6979 — exact match required), (2) the TS verifier, (3) the Aiken validator, and (4) the Rust ref. Negative vectors must be rejected by all three verifiers. 200 positive vectors per N ∈ {2, 3, 4, 6, 8}, plus negatives.

Validator tests target 100% rule coverage — every rule in [docs/spec/03-contracts.md](docs/spec/03-contracts.md) §1–§3 must have both a positive and a negative test (CI fails otherwise). Stress tests at M2 close calibrate `max_n` and `max_fee_per_mix_lovelace` empirically on Preprod and commit results to `docs/perf.md` and `network.preprod.json`.

## Out of scope for v1 (don't add these unless asked)

Confidential amounts, cross-chain, account-model compatibility, native asset pools, multi-denomination, dedicated mixer-bot service, stealth withdraw (use Seedelf at the wallet layer), decentralized collateral provider, mainnet deployment. See [docs/spec/00-overview.md](docs/spec/00-overview.md) §"Non-goals" and OQ-Y in [docs/spec/11-open-questions.md](docs/spec/11-open-questions.md).

## Reading order for new contributors

1. [README.md](README.md) — 5-min summary.
2. [docs/spec/00-overview.md](docs/spec/00-overview.md) — system + architecture diagram.
3. [docs/spec/12-build-guide.md](docs/spec/12-build-guide.md) — order of attack, risks, pitfalls. **The most useful single doc when starting work.**
4. [docs/spec/01-protocol.md](docs/spec/01-protocol.md), [02-cryptography.md](docs/spec/02-cryptography.md), [03-contracts.md](docs/spec/03-contracts.md) — for implementers, in order.
5. [docs/spec/08-threat-model.md](docs/spec/08-threat-model.md) — for auditors, first.
