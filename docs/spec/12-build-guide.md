# 12 — Build guide

A practical, opinionated execution plan. Pairs with [09-milestones.md](09-milestones.md), which is the high-level structure. This document is about *order of attack*, risk management, and avoiding the dead-ends.

## TL;DR

1. Set up the monorepo skeleton, pin Aiken 1.1.21, get CI green. (M0)
2. **Before any sigma protocol code: get encoding parity green between TS and Aiken.** This is the single biggest build-blocker.
3. Build the crypto bottom-up: Schnorr → DH-tuple → 2-way OR → N-way OR. (M1)
4. Build validators bottom-up: one_shot_mint → reference_holder → mix_box Owner → mix_box Mix at N=2 → fee_contract → generalize mix_box to variable N. (M2)
5. Get a thin happy-path slice running on Preprod as early as possible: deposit + withdraw at N=2, no UI. (M3 + a vertical slice of M4)
6. Then widen: variable N, fee shards, UI, indexer.
7. Polish, calibrate `max_n`, ship.

## Front-loaded risks

These are the things that, if they fail, invalidate downstream work. Tackle them early and verify them under stress.

### Risk 1: TS-Aiken encoding parity

The Fiat-Shamir hash is computed in *both* TS (when proving) and Aiken (when verifying). If the byte-level CBOR encoding of the same logical datum differs by even one byte, every proof will fail verification on chain — and the failure mode is silent and confusing because the math is right but the inputs differ.

**Mitigation:** before writing any sigma-protocol code, write a parity test that:
- Generates a `MixDatum { a, b }` with random bytes in TS.
- Serializes it via cbor-x.
- In an Aiken test, generates the same logical `MixDatum`.
- Aiken serializes it and dumps the bytes.
- The test asserts byte-equal.

Same for value serialization. Same for `tx.outputs` if you're going to FS-hash it.

If this test passes for 1000 random cases, you can build crypto on top of it. If not, fix the encoding mismatch first; everything else is a waste of time until then.

### Risk 2: mesh + the unconventional Mix tx shape

The Mix tx has no submitter wallet input, an externally-supplied collateral, and an exact-fee constraint that links the fee-contract input value to the fee-contract output value via `tx.fee`. Standard tx builders may not handle this cleanly.

**Mitigation:** at M3 start, before going deep on Mix tx logic, write a minimal Mix-tx builder that just produces the right shape on Preprod (no real proofs yet, just dummy bytes — let the validator reject it). If mesh handles the shape, you're fine. If not, switch to lucid-evolution before you've written a thousand lines against mesh's API.

### Risk 3: Per-tx script-cost budget at high N

The whole "variable N" feature is contingent on Cardano's mainnet limits accommodating large N. The estimates in [03-contracts.md](03-contracts.md) §2 are educated guesses. The real numbers come from running on Preprod.

**Mitigation:** at M2's end, run `stress-tests/max-n-calibration.ts` against Preprod with the real validators. Don't ship without empirical numbers. If `max_n = 6` doesn't fit, fall back to `max_n = 4` and update the spec. If `max_n = 4` doesn't fit, optimize the Aiken (see §Optimizations below).

### Risk 4: Reference-UTxO bootstrap

The bootstrap is a one-shot, irreversible ceremony per network. Mistakes mean re-running and orphaning the previous deployment. Test it thoroughly on Preprod.

**Mitigation:** practice the bootstrap on a private Preprod account multiple times before doing the canonical Preprod bootstrap. Make sure the scripts are idempotent and verify their output before committing addresses.json.

## Within M0: the first sit-down

A concrete checklist for the project skeleton.

```
lovejoin/
├── .github/workflows/ci.yml         # PR linting + testing
├── .gitignore
├── package.json                      # pnpm workspace root
├── pnpm-workspace.yaml
├── Makefile                          # make build, make test, etc.
├── README.md
├── papers/
├── docs/
├── config/
│   ├── network.test.json
│   └── network.preprod.json
├── contracts/
│   ├── aiken.toml                    # version = "1.1.21"
│   ├── lib/lovejoin/
│   ├── validators/
│   ├── test/
│   └── build.sh
├── offchain/
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   └── test/
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   └── test/
├── ui/
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   ├── src/
│   │   ├── i18n/
│   │   │   └── locales/en.json
│   └── test/
├── integration-tests/
├── stress-tests/
├── crypto/
│   ├── ref/                          # Rust reference impl using blst
│   └── test-vectors/
├── infra/
│   └── bootstrap/
│       ├── 00-build-reference.sh
│       ├── 01-mint-and-lock.sh
│       ├── 02-fund-fee-contract.sh
│       └── 03-publish-reference-scripts.sh
├── artifacts/
│   ├── test/
│   └── preprod/
└── bench/
```

The Makefile targets to have working from day 1:

```
make build          # builds contracts + offchain + backend + ui
make test           # runs unit tests in all packages
make ui-dev         # starts vite dev server
make backend-dev    # starts backend against Preprod
make contracts      # rebuilds just contracts from current config
```

Even if these targets don't do anything meaningful yet, having them wired up means M0 is done.

## Within M1: build the crypto bottom-up

The order matters. Each layer depends on the one below working.

### Layer 0: BLS12-381 wrappers
- `offchain/src/crypto/bls.ts` over `@noble/curves`. Compressed encoding, scalar ops, point ops. ~50 lines.
- `contracts/lib/lovejoin/bls.ak` thin wrappers around `bls12_381_g1_*` builtins.
- Verify both: encode the generator, scalar-mul by 2, decode, compare. Should match.

### Layer 1: blake2b + FS challenge construction
- `offchain/src/crypto/hash.ts` and `contracts/lib/lovejoin/hash.ak`.
- The exact same byte-construction logic in both. **Run the encoding parity test now** — before any sigma protocol code.

### Layer 2: RFC 6979 nonce derivation
- `offchain/src/crypto/nonce.ts`. TS-only; Aiken doesn't need this (it only verifies, doesn't generate).
- HMAC-SHA256-DRBG.

### Layer 3: Schnorr / proveDlog
- `offchain/src/crypto/schnorr.ts`: prove + verify.
- `contracts/lib/lovejoin/schnorr.ak`: verify only.
- TS test: generate a proof, verify with the TS verifier — passes.
- Cross-test: generate proof in TS, dump bytes, verify in Aiken — passes.
- Negative test: tamper one byte, both verifiers reject.

### Layer 4: proveDHTuple
- Same shape as Schnorr but two parallel runs.
- Same testing: TS prove + verify, cross-verify with Aiken, negative cases.

### Layer 5: 2-way sigma-OR
- The simplest OR composition. Get this right before going generic.
- TS prove + verify.
- Aiken verifier.
- KAT vectors at N=2.

### Layer 6: N-way sigma-OR
- Generalize the 2-way case. Loop over branches.
- Important detail: the XOR-completion of challenges. Test at N ∈ {2, 3, 4, 6, 8}.
- KAT vectors at each N.

### Layer 7: Rust reference
- Last. Built using `blst`. Generates the canonical KAT vectors from a separate codebase.
- TS prover + Aiken verifier should both agree with the Rust reference.

By the end of M1, you have three independent implementations agreeing on bytes. That's your foundation.

## Within M2: build the validators bottom-up

### Layer 0: types + helpers
- `contracts/lib/lovejoin/types.ak`, `reference.ak`, `mixbox.ak`, `fee.ak`.
- `find_reference_utxo` helper: takes the NFT identifier, returns the protocol params from `tx.reference_inputs`.

### Layer 1: one_shot_mint
- Simplest possible validator. ~10 lines. Get it deployed and minting on Preprod first.

### Layer 2: reference_holder
- 1 line of logic (`False`). The interesting part is the bootstrap tx that locks the NFT and datum.
- Run `infra/bootstrap/01-mint-and-lock.sh` on Preprod and verify the reference UTxO is queryable via ogmios.

### Layer 3: mix_box Owner branch
- Just calls Schnorr verify on the redeemer's proof against the datum.
- Test in Aiken simulator with KAT-derived test cases.
- Smoke test: deploy on Preprod via cardano-cli, deposit a box manually, spend it via Owner — confirm.

### Layer 4: mix_box Mix branch at N=2
- Hard-code N=2 first. Get the OR proof verification working.
- Test the rule list (value preservation, datum well-formedness, etc.) one by one.

### Layer 5: fee_contract
- Both PayMixFee and Replenish paths.
- Test in isolation with synthetic Mix-tx contexts.

### Layer 6: Generalize mix_box to variable N
- Replace the hard-coded N=2 with `N = length(mix_inputs)` and generalize the OR-proof verification.
- Test at N ∈ {2, 3, 4, 6}.

### Layer 7: Bootstrap scripts
- `02-fund-fee-contract.sh`: creates 10 fee shards.
- `03-publish-reference-scripts.sh`: publishes both validators as reference scripts.
- `addresses.preprod.json` committed.

### Layer 8: Stress test
- `max-n-calibration.ts`. Determine real `max_n`.
- `fee-calibration.ts`. Determine real `MAX_FEE_PER_MIX`.
- Update `network.preprod.json`.

## The thin happy-path slice (target: end of M3)

Before going wide on M4-M6, get a vertical slice working end-to-end on Preprod. This is just to prove the integration is sound.

```
1. Deposit 10 ADA via SDK (CLI; no UI yet).
2. Box appears in pool (verify via cardano-cli or backend).
3. Withdraw via SDK to a different address.
4. Funds arrive (verify on cardanoscan).
```

No mixing in the slice. Just the deposit + withdraw cycle. If this works, you've validated:
- Aiken validators compile and run on real Preprod.
- mesh handles the tx shape.
- Schnorr proof verification works for real, not just in tests.
- Reference UTxO lookup works at runtime.
- Fee-contract Replenish path works.
- The CIP-30 wallet integration works.

Once this slice is green, layer in mixing (M4), then UI (M6).

## Within M5: backend ordering

1. ogmios chainsync subscription, console.log every relevant tx. Verify you see deposits and withdraws happen.
2. In-memory pool model with add/remove. Verify counts match expectations.
3. Fee shard tracking.
4. Reference UTxO cache.
5. Rollback handling (test by running backend, killing cardano-node, restarting it; verify backend recovers).
6. REST API.
7. db-sync queries for history.

## Within M6: UI ordering

Drive from the user's first action backward.

1. WalletButton + CIP-30 connection. User can connect/disconnect.
2. Empty Vault screen. User sees "no boxes yet."
3. Deposit screen. User can deposit; secret saved (encrypted IndexedDB).
4. Vault screen now shows the box (after sync).
5. Pool screen with pool size + "Mix N random boxes" button. User can mix.
6. Box detail screen.
7. Withdraw screen.
8. i18n: extract all strings, finalize en.json.
9. Polish: error states, loading states, animations.

## Common pitfalls

### "My proof verifies in TS but fails in Aiken"
99% of the time this is encoding parity. Diff the byte sequences.

### "My validator passes the test but fails on Preprod"
Test simulator vs real chain differences:
- Reference inputs handling.
- CBOR datum decoding edge cases.
- Plutus version mismatch.
- Cost model differences.

### "My Mix tx has the right outputs but mesh refuses to build it"
Could be:
- mesh expecting a wallet input (use the collateral provider correctly).
- The exact-fee constraint not converging (iterate fee computation).
- Reference inputs not being passed.

### "All my proofs fail but the math looks right"
Check the FS challenge `ctx`. If you're hashing `tx.outputs` and the outputs include the fee-contract output, and the fee-contract output's value depends on `tx.fee`, you have a circular dependency. Solution: only hash the *mix outputs* (positions 0 through N-1), not the fee-contract output.

### "I can't get cardano-cli to recognize my reference script"
CIP-33 reference scripts have specific tx-formatting requirements. Use cardano-cli 8.x and pass `--reference-tx-in <txid#idx>` correctly. Test with a simple validator first.

## Optimizations (if Aiken is too expensive)

In likelihood-of-needing order:

1. **Avoid redundant uncompressions.** Each `bls12_381_G1_uncompress` is expensive. If you uncompress `a` twice in your validator, that's 2x cost. Cache uncompressed values.
2. **Avoid redundant hashes.** `blake2b_256` over a long bytestring isn't cheap. If you hash the same bytes for two purposes, hash once and reuse.
3. **Precompute lookups.** If the validator iterates over `tx.outputs` multiple times, do it once and cache the relevant subsets.
4. **Optimize the OR-proof verifier.** The verifier does N branches each with 2 scalar muls + 2 adds. There's room for cleverness — e.g., delaying the equality check until you can batch verify. Probably not needed.
5. **Reduce reference-input size.** If `ProtocolParams` has fields you don't need at runtime, remove them.
6. **Reduce datum size.** If you don't actually need a field, drop it.
7. **As a last resort, lower `max_n`.** A working N=4 is much better than a non-working N=6.

## Tools to install up front

- **Aiken 1.1.21**
- **cardano-cli** (matching the Preprod node version)
- **cardano-node** (or access to a Preprod node)
- **ogmios** (or access to a Preprod ogmios)
- **db-sync** (or access to a Preprod db-sync — you can use a public one for read-only)
- **pnpm** (or your preferred package manager; spec assumes pnpm)
- **node** (LTS)
- **rust toolchain** (only for the M1 Rust reference)
- **blst** Rust crate for the reference impl

## When in doubt: ship the smallest thing

The temptation will be to over-engineer M1 (perfect crypto module before moving on) or M2 (perfect validator before testing). Resist it. The goal is to get to "happy path on Preprod" as fast as possible, then harden. Each round of integration catches design assumptions you didn't know you were making.

The hardening phase (M2 stress test, M5 load test, M6 E2E test, M7 reproducible builds) is where you go from "working" to "production-ready." Don't skip it, but don't front-load it either.
