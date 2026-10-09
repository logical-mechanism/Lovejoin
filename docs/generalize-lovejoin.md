# Generalizing Lovejoin to native tokens

**Status: design, not implemented.** The live mainnet and Preprod deployments are ADA-only and immutable. This document describes how future launches would support a native token, so the work can be picked up later without re-deriving it. Each token is its own launch, with its own addresses, its own anonymity set, and its own fee pool. There is no single multi-asset contract.

## Summary

Most of the protocol is already asset-agnostic. The sigma-protocol crypto, the withdraw-zero split, the Owner branch, `mix_box`, `reference_holder`, and the fee logic all work for any asset unchanged. On-chain, the only real change is the **value shape of a mix-box**. Off-chain, the SDK, backend, UI, and bootstrap all assume a single ADA-only pool, and that is where most of the work is.

## The box value rule

| Pool       | Every mix-box holds exactly                         |
| ---------- | --------------------------------------------------- |
| ADA        | `box_lovelace` = 10 ADA (unchanged)                 |
| Token pool | `box_lovelace` = 2 ADA plus `Q` of `(policy, name)` |

One check covers both cases. `mix_logic` builds `expected_value = box_lovelace (+ the token, if the pool has one)` once per tx, and every Mix output must equal it exactly.

The ADA pool is **not** "8 ADA of principal plus 2 ADA of min-ADA". Lovelace is fungible and the ledger only checks that a UTxO's total ADA is at least the minimum, so a 10 ADA box already satisfies min-ADA with nothing set aside. The 2 ADA only exists in token pools, because there the principal is the token and the ADA is just what the ledger requires for the UTxO to exist.

### Why min-ADA is a constant, not a per-tx calculation

Privacy depends on every box in a pool having a byte-identical value. If each Mix output carried "whatever min-ADA the ledger needs right now", the lovelace amount would vary between boxes (with asset-name length, quantity encoding, and protocol-parameter changes) and would fingerprint boxes across mixes. So the amount is pinned once at launch and never derived per tx from protocol parameters.

### Why 2 ADA is enough

Estimates at mainnet `coinsPerUTxOByte` = 4310 (min-UTxO = (160 + serialized output size) × 4310):

- **Mix-box output.** Enterprise script address, 104-byte inline `MixDatum`, one policy and asset. That works out to about 1.54 ADA (8-byte asset name) to 1.66 ADA (32-byte name, large quantity), which leaves 20 to 30% headroom against a future per-byte rate increase. For comparison, an ADA-only box needs about 1.35 ADA, so today's 10 ADA has very large headroom.
- **Box-mode withdraw.** The canonical withdraw pays its fee out of the box (`feePayer: "box"` in [withdraw.ts](../offchain/src/tx/withdraw.ts)), and the token cannot pay fees. So `2 ADA − withdraw_fee` must cover the destination output's minimum, which is about 1.18 to 1.31 ADA for a key address holding the token. That means the Owner-branch withdraw fee must stay under roughly 0.7 ADA. One Schnorr verification should be well under that, but it has not been measured; confirm on Preprod.

**Failure mode.** If `coinsPerUTxOByte` is ever raised past what 2 ADA covers, Mix outputs become ledger-invalid and that pool can no longer mix. Withdraws still work, because wallet fee mode lets the destination output take extra ADA. Users keep their funds in every case.

**Where the 2 ADA lives.** `box_lovelace` is a field in the reference datum, written by the bootstrap, not a constant in validator code. The ADA pool needs a different value, and a future launch can choose a larger one if the ledger rate rises, without new bytecode. The bootstrap writes 2 ADA for every token launch.

## On-chain changes

### `ReferenceDatum`

In [types.ak](../contracts/lib/lovejoin/types.ak), generalize the datum rather than forking the validators, so ADA and token pools come from one validator set:

```aiken
pub type ReferenceDatum {
  box_lovelace: Int,          // renamed from denom_lovelace
  token_policy: PolicyId,     // #"" means an ADA-only pool
  token_name: AssetName,      // #"" for an ADA-only pool
  token_quantity: Int,        // Q; 0 for an ADA-only pool
  max_fee_per_mix_lovelace: Int,
  mix_script_hash: ScriptHash,
  mix_logic_script_hash: ScriptHash,
  fee_script_hash: ScriptHash,
}
```

Use explicit fields rather than storing an `Assets` value in the datum, for two reasons:

1. A datum-supplied value that is not in canonical form (sorted policies and names, no zero entries) could never equal a ledger-provided value, so no Mix output could ever satisfy the check and the pool would be bricked at launch.
2. Aiken rejects `expect`-casting `Data` into the opaque `Assets` type ("reckless opaque cast"). Building the value with `assets.from_lovelace` and `assets.add` yields canonical form by construction.

### `mix_logic` output check

In [mix_logic.ak](../contracts/validators/mix_logic.ak) (`validate_mix` and `walk_outputs`, around lines 186 to 273):

- Build `expected_value` once per tx: `assets.from_lovelace(box_lovelace)`, then `assets.add(token_policy, token_name, token_quantity)` when the pool has a token.
- Set `denom_value_bytes = serialise_data(expected_value)`. This keeps the existing trick of computing the value bytes once and reusing them for all N outputs in the Fiat-Shamir preimage.
- In `walk_outputs`, replace `expect_ada_only_lovelace(output.value) == reference_datum.denom_lovelace` with an exact match against `expected_value`.

Extra policies or asset names are still rejected, so the token-poisoning defense documented in [value.ak](../contracts/lib/lovejoin/value.ak) still holds: "exactly these two assets" replaces "exactly ADA". If the generalized check costs more than today's `expect_ada_only_lovelace` for the ADA case, branch on `token_policy == #""` to keep the current fast path.

### `one_shot_mint` launch-time sanity

In [one_shot_mint.ak](../contracts/validators/one_shot_mint.ak) (the `datum_sane` block):

- Keep `box_lovelace > 0` and `0 < max_fee_per_mix_lovelace < box_lovelace`.
- With a token: `token_policy` is 28 bytes, `token_name` is at most 32 bytes, `token_quantity > 0`.
- Without a token: `token_name == #""` and `token_quantity == 0`.

These checks run at mint time, so a mistyped launch fails and can be rebuilt instead of bricking the pool permanently (the same rationale as audit L-02).

### Unchanged

- **`fee_contract`.** Fees are always lovelace (`tx.fee`), shards stay ADA-only, and Deposit replenishes them in ADA. Each launch gets its own fee pool automatically, because `fee_contract` is parameterized by that launch's reference NFT.
- **`mix_box`**, **`hash.ak`**, and all sigma-OR, Schnorr, and DH-tuple code.
- **`reference_holder`.** It is parameter-free, so every launch's reference UTxO sits at the same address and is found by its NFT, never by scanning the address.
- **Rule-2 recovery paths.**
- **The Owner branch.** Its ctx already hashes the full `tx.outputs`, tokens included.

### What a launch produces

A new seed UTxO gives a new `one_shot_mint` policy. That gives new `mix_logic` and `fee_contract` hashes (both are parameterized by the NFT policy), which gives a new `mix_box` hash (parameterized by `mix_logic`), and therefore new addresses. Launches are fully isolated from each other.

The existing mainnet ADA pool stays on its current bytecode. Do not relaunch ADA on the generalized code: it would split ADA liquidity across two pools.

## Off-chain changes

1. **Encoding parity first.** This is the highest-risk item (see "The build-blocker risk" in [CLAUDE.md](../CLAUDE.md)). `planMixTx` uses `encodeAdaOnlyValueCbor(denomLovelace)` ([mix.ts](../offchain/src/tx/mix.ts)). Replace it with an encoder that produces byte-identical `serialise_data` output for the two-policy map (ADA's empty policy first, then the token policy). Add vectors to [encoding-parity.json](../crypto/test-vectors/encoding-parity.json) and extend [encoding-parity.test.ts](../offchain/test/crypto/encoding-parity.test.ts) and [value_serialise_parity.test.ak](../contracts/lib/lovejoin/value_serialise_parity.test.ak) before touching anything else.
2. **Params.** [params.ts](../offchain/src/tx/params.ts) decodes both datum schemas (the 5-field v1 ADA datum and the generalized v2 datum) into one `ProtocolParams` carrying `boxValue: { lovelace, token?: { policy, name, quantity } }`.
3. **Replace `denomLovelace` with `boxValue`** in [deposit.ts](../offchain/src/tx/deposit.ts) (the box output, and the wallet must supply the token), [withdraw.ts](../offchain/src/tx/withdraw.ts) (the destination receives the token plus `box_lovelace − fee`), [mix.ts](../offchain/src/tx/mix.ts), [identify.ts](../offchain/src/pool/identify.ts) (exact-value pool filter), and [orchestrator.ts](../offchain/src/strategy/orchestrator.ts).
4. **Pool registry.** `config/network.<net>.json` and `artifacts/<net>/addresses.json` become a list of pools keyed by a pool id (for example `ada` and `<policy>.<name>`). The backend indexer watches every pool's mix and fee addresses. The UI gets a pool selector; every new string goes through i18n in all 20 locales.
5. **Bootstrap.** [infra/bootstrap/](../infra/bootstrap/) and [koios-launch.py](../infra/bootstrap/koios-launch.py) take `token_policy`, `token_name`, and `token_quantity`, write `box_lovelace = 2_000_000` for token launches, and abort if live protocol parameters put the box minimum above 2 ADA.

## Token eligibility

- **Plain fungible native tokens only:** one policy and one asset name. Programmable tokens that must stay at an issuer-controlled script address cannot sit at the mix script.
- **No issuer control over pooled funds.** Cardano native-token policies govern only minting and burning, so an issuer cannot freeze or claw back tokens held in mix-boxes.
- **Pool depth matters.** Each launch is its own anonymity set. The `(1/N)^k` linkage bound only means something if the pool has enough live boxes, so a thin token pool gives weak privacy. The UI should show pool depth.

## Risks to check before committing to an implementation

1. **CPU at the N=3 fee-shard path.** That path is already at the per-tx CPU cap ([perf.md](perf.md)). A token adds about 60 bytes per output to the Fiat-Shamir preimage and a two-policy comparison per output. Both are probably small next to the ~2N² G1 uncompresses, but measure with `aiken bench` rather than assume.
2. **Tx size.** Each output grows by about 60 bytes, which raises mix fees slightly. Re-check `max_fee_per_mix_lovelace` headroom for token pools.
3. **ADA-path regression.** See the fast-path note under the `mix_logic` changes.

## Verification plan

- `aiken check`: a positive and a negative test for every new rule (exact token shape, extra token rejected, wrong `Q`, wrong `box_lovelace`, mint-time token sanity), plus `aiken bench` for `mix_logic` Mix at N=2/3/4 with a token, compared against the ADA baseline.
- Two-policy parity vectors pass in the Rust reference implementation, the TS SDK, and Aiken.
- Preprod: bootstrap a pool for a test token, then run the integration suite (deposit/withdraw round-trip, mix-n2, mix-at-max-n, chained Mix on an in-flight Deposit) and [max-n-calibration.ts](../stress-tests/max-n-calibration.ts) against it, and measure the box-mode withdraw fee.
