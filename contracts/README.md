# contracts

Aiken validators and minting policies for Lovejoin. Plutus V3, BLS12-381 G1 builtins.

Spec: [docs/spec/03-contracts.md](../docs/spec/03-contracts.md). The README is a quickstart; the spec is canonical.

## What's here

```
validators/
  reference_holder.ak    Always-False; locks the protocol NFT + ProtocolParams datum.
  one_shot_mint.ak       Minting policy parameterized by a seed UTxO; mints exactly one NFT exactly once.
  mix_box.ak             Cheap spend delegator: every mix-box input defers to one mix_logic run.
  mix_logic.ak           Withdraw-zero validator: handles Owner (Schnorr) + Mix (N-way sigma-OR) once per tx.
  fee_contract.ak        Sharded fee pool. Redeemers: PayMixFee, Replenish.
  *.test.ak              Per-validator positive + negative property tests.
lib/lovejoin/            Shared helpers (BLS, hash, Fiat-Shamir context, datum types).
aiken.toml               Pinned to compiler v1.1.21, plutus v3, stdlib v3.1.0.
plutus.json              Compiled blueprint emitted by `aiken build` (committed).
build.sh                 Stage-1 build: aiken build + emit per-validator artifacts.
```

The `mix_box` / `mix_logic` split is the M2 withdraw-zero refactor and is intentionally different from the original spec's "mix-box runs once per input" model. Read [docs/spec/03-contracts.md](../docs/spec/03-contracts.md) §0 before changing either file.

## Validator-to-spec map

| Validator          | Spec section                                        |
| ------------------ | --------------------------------------------------- |
| `reference_holder` | §1 Reference UTxO + ProtocolParams                  |
| `one_shot_mint`    | §1 One-shot bootstrap minting                       |
| `mix_box`          | §2 Mix branch delegator + §5 Owner branch delegator |
| `mix_logic`        | §2 Mix branch (N-way sigma-OR) + §5 Owner (Schnorr) |
| `fee_contract`     | §3 Fee shard (PayMixFee, Replenish)                 |

## Build and check

```sh
# from contracts/
aiken check                     # type-check + run all *.test.ak property tests
aiken build                     # produce plutus.json (the compiled blueprint)
./build.sh                      # aiken build + copy slices into artifacts/<network>/
```

From the repo root:

```sh
make contracts                  # aiken check inside contracts/
```

A two-stage flow turns the unparameterized blueprint into deployable scripts: stage 1 here, stage 2 in [infra/bootstrap/00-build-reference.sh](../infra/bootstrap/00-build-reference.sh) which runs `aiken blueprint apply` against a real seed UTxO. See `build.sh` header for the parameterization chain.

## Adding a new test

Tests live next to the validator they cover, as `<validator>.test.ak`. Aiken auto-discovers any function starting with `test_`.

```aiken
// validators/fee_contract.test.ak
test fee_contract_replenish_strict_increase() {
  let datum = ...
  let redeemer = Replenish
  let ctx = ...
  fee_contract.spend(datum, redeemer, ctx) == True
}
```

CI fails if any rule from spec §1-§3 lacks both a positive and a negative test. Watch out for the simulator parity trap (CLAUDE.md, "Testing posture"): build inputs from record literals rather than trusting `aiken simulate`'s `serialise_data` round-trip.

## Where compiled artifacts go

- `contracts/build/`, `contracts/plutus.json`: raw `aiken build` output.
- `artifacts/{test,preprod}/`: per-network parameterized scripts plus `addresses.json` (the bootstrap state). `preprod/` is the live alpha.

## Pinned versions

Aiken `1.1.21` and stdlib `v3.1.0` are pinned in [aiken.toml](aiken.toml). Bumps are deliberate; coordinate via [docs/spec/07-testing.md](../docs/spec/07-testing.md) OQ-F.
