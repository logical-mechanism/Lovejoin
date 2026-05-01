# crypto

Lovejoin reference cryptography in Rust (`blst`), plus the cross-language Known-Answer-Test vectors that bind the three implementations together.

This crate is the **third independent verifier**. The TS SDK (`offchain/src/crypto`) generates KAT vectors; the Aiken validator (`contracts/validators/mix_logic.ak`) verifies them on chain; this crate verifies them off chain in Rust against `blst`. Any disagreement between the three is a bug we want to catch before it reaches the chain.

Spec: [docs/spec/02-cryptography.md](../docs/spec/02-cryptography.md). The README is a quickstart; the spec is canonical.

## What's here

```
ref/                      Rust crate (lovejoin-ref).
  Cargo.toml              Pinned to blst 0.3, blake2 0.10, num-bigint 0.4.
  src/
    lib.rs                Re-exports.
    bls.rs                BLS12-381 G1 wrappers (compress/uncompress, scalar_mul, add).
    hash.rs               Blake2b-256 + Fiat-Shamir context binding.
    schnorr.rs            Schnorr proveDlog verifier.
    dhtuple.rs            DH-tuple proveDHTuple verifier.
    sigma_or.rs           Variable-N sigma-OR verifier.
  tests/
    kat.rs                Reads every JSON in test-vectors/ and asserts (positives verify, negatives reject).
test-vectors/             Cross-language KAT JSON.
  provedlog.json          Schnorr (proveDlog) vectors.
  provedhtuple.json       DH-tuple (proveDHTuple) vectors.
  sigma-or.json           N-way sigma-OR vectors at N ∈ {2, 3, 4, 6, 8}.
  negative.json           Vectors that MUST be rejected by all verifiers.
  encoding-parity.json    TS↔Aiken CBOR-encoding parity vectors for MixDatum and tx.outputs.
```

## How to (re)generate KAT vectors

The vectors are emitted by the **TypeScript SDK**, then verified independently by Aiken (in `aiken check`) and Rust (in `cargo test`).

```sh
# from repo root
pnpm --filter @lovejoin/sdk gen:kat        # all four positive sets
pnpm --filter @lovejoin/sdk gen:parity     # CBOR-encoding parity vectors
```

Generators are deterministic (RFC 6979 nonces, fixed seed inputs). Re-running on the same inputs produces byte-identical JSON, so spurious diffs in `crypto/test-vectors/*.json` mean an upstream change broke determinism.

Watch out for the build-blocker risk in [docs/spec/12-build-guide.md](../docs/spec/12-build-guide.md) §"Risk 1": one byte of disagreement between TS and Aiken CBOR silently breaks every Mix on chain. Re-run `gen:parity` and the parity test before changing any serialization.

## How to verify them in Rust

```sh
cd crypto/ref
cargo test                    # runs tests/kat.rs against ../test-vectors/*.json
cargo test --release          # release-mode is the canonical run; profile keeps overflow + debug-asserts on
```

Every entry in `test-vectors/*.json` is asserted to verify (or, for `negative.json`, to be rejected). If you change a generator and the Rust verifier rejects the new vectors, fix the verifier or the generator until all three agree.

## Relation to the TS and Aiken impls

| Implementation                      | Role                                                 |
| ----------------------------------- | ---------------------------------------------------- |
| `offchain/src/crypto/*`             | Prover + verifier in TS (`@noble/curves`).           |
| `contracts/validators/mix_logic.ak` | Verifier in Aiken (Plutus V3 BLS12-381 G1 builtins). |
| `crypto/ref/*`                      | Independent verifier in Rust (`blst`). This crate.   |

The three implementations agree on bytes for every positive KAT and reject every negative KAT. The Rust ref is also the catch for "TS and Aiken happen to share the same encoding bug": three independent implementations rule that out.

## Curve and hash choices

- **Curve:** BLS12-381 G1 only. Compressed group elements are 48 bytes; scalars are 32 bytes big-endian, strictly less than `r`.
- **Hash:** blake2b-256, Plutus builtin. Domain tag `"lovejoin/sigmajoin/v1/"`. Statement IDs `0x01`=proveDlog, `0x02`=proveDHTuple, `0x03`=sigma-or-N (N as 1-byte prefix).

See [docs/spec/02-cryptography.md](../docs/spec/02-cryptography.md) for the canonical definitions.
