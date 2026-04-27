# 01 — Protocol

This document maps the Sigmajoin paper to the Cardano UTxO model. Where the paper uses ErgoScript-specific constructs, we identify a Cardano equivalent.

## Notation

- `G` — BLS12-381 G1, a prime-order subgroup of order `r ≈ 2^255 - δ`. (See [02-cryptography.md](02-cryptography.md) for the choice rationale.)
- `g` — fixed generator of `G`.
- Group operation written **additively**: `[x]g` means scalar-mul.
- Compressed group elements are 48 bytes; scalars are 32 bytes.

## Configuration source: the reference UTxO (hyperstructure)

Protocol parameters live in an inline datum on a permanent UTxO at the `reference_holder` script address, identified by a one-of-one NFT:

```
ProtocolParams {
  denom_lovelace,
  max_fee_per_mix_lovelace,
  max_n,                        // upper bound on Mix tx width (e.g. 6)
  mix_script_hash,
  fee_script_hash,
  fee_shard_target,             // 10
}
```

Every Mix and Owner spend tx includes this UTxO as a `reference_input`; validators read params from it. The reference UTxO is unspendable (validator returns False). See [03-contracts.md](03-contracts.md) §1.

This makes lovejoin a **hyperstructure**: the on-chain state is permissionless and immutable.

## Box anatomy

A "mix-box" is a UTxO at `mixScriptAddr` with:

| Field | Cardano representation |
|---|---|
| `value` | exactly `denom_lovelace` ADA, no native assets |
| `datum` (inline) | `MixDatum { a: ByteArray, b: ByteArray }` |
| `address` | `mixScriptAddr` |

The **owner secret** is `x ∈ Z_r` such that `b = [x]a`. After mixing, `(a, b)` are re-randomized but the relation is preserved.

## Fee contract: 10 sharded UTxOs

Two redeemer paths (full rules in [03-contracts.md](03-contracts.md) §3):

- **PayMixFee** — spend in conjunction with a Mix tx; output value = input value − tx.fee; `tx.fee ≤ max_fee_per_mix`.
- **Replenish** — increase the shard's value (top up).

Sharding (the 10 UTxOs) is for concurrency. SDK picks shards uniformly at random.

## Collateral provider

Cardano's Plutus protocol REQUIRES every tx that runs scripts to provide a **collateral input** — a key-witnessed UTxO that gets seized if any script fails validation. This input requires a key signature, so naively the submitter's own wallet would have to provide it, linking the wallet to the Mix tx.

To preserve the wallet-anonymity property of Mix txs, lovejoin integrates with a **collateral provider service** like [Collateral-Provider / giveme.my](https://github.com/logical-mechanism/Collateral-Provider). The provider's wallet supplies collateral on behalf of the submitter:

- The provider's wallet IS visible in the tx (signs as collateral source).
- The provider services many users, so the same wallet appears as collateral for all of their mixes — it does NOT identify a specific submitter.
- Collateral is forfeited only if scripts fail. Sigma-OR proofs are deterministic; if the SDK constructs them correctly they always succeed, so the provider never actually loses funds. They charge a small service fee for the loan.
- Privacy from the provider depends on trust: the provider can log `(time, requested-by-IP)`. Mitigations: rotate providers, run your own, or use a more decentralized service when one exists.

For v1, the collateral provider is **mandatory** for Mix txs — without it the submitter's wallet ends up signing the collateral input and tracking becomes trivial. SDK defaults to giveme.my (free service); power users and self-hosters can configure a custom provider, which satisfies the mandatory-integration requirement equally. There is no default fallback to wallet-collateral for Mix txs; if no provider is reachable, Mix submission is blocked until one is.

## Operations

### Deposit

Alice picks `x ∈ Z_r` uniformly. The deposit tx replenishes one fee shard while creating a new mix-box:

```
inputs:
  [0] Alice's wallet UTxO(s)
  [1] one fee_contract shard          redeemer = Replenish
reference inputs:
  [_] reference UTxO
collateral input:
  [_] one of Alice's wallet UTxOs (fine — Alice is already in the tx)
outputs:
  [0] mixScriptAddr,  value = denom,                       datum = (a = g, b = [x]g)
  [1] feeScriptAddr,  value = shard_in.value + N·max_fee,  datum = ()
  [2] Alice's change
collateral return:
  [_] back to Alice's change address
signers: Alice's wallet payment key
```

`N` is the user's chosen mix-round target (default from config; UI presets 20 / 30 / 50). The user MUST contribute at least `min_N · max_fee` (UI enforces; e.g. `min_N = 5`).

The deposit tx is unprivileged from a privacy standpoint — anyone watching can see it's a deposit. Privacy starts at the first mix.

### Mix — variable N (the full Sigmajoin construction)

Anyone (the box owner, or any other user) picks **N mix-boxes** from the pool where `2 ≤ N ≤ max_n`, and a fresh secret `y_i ∈ Z_r` per input. They produce N re-randomized mix-boxes and a reduced fee shard:

For each input `i ∈ {0, ..., N-1}` with registers `(a_i, b_i)`:
- Pick a permutation `π` of `{0, ..., N-1}` (output position assignment).
- Pick fresh `y_i ∈ Z_r`.
- Output `π(i)` has registers `([y_i]a_i, [y_i]b_i)`.

The mixer must prove, for each input `i`, that one of the N outputs is a re-randomization of input `i`:

```
proveDHTuple(a_i, b_i, a'_0, b'_0)  OR  proveDHTuple(a_i, b_i, a'_1, b'_1)  OR  ...  OR  proveDHTuple(a_i, b_i, a'_{N-1}, b'_{N-1})
```

This is an N-way sigma-OR composition (paper Appendix C, generalized; full construction in [02-cryptography.md](02-cryptography.md) §3).

#### Privacy gain

Per round, an outsider's chance of correctly mapping a specific input to its output is `1/N`. After `k` rounds at width `N`, linkage probability is `(1/N)^k`. Practical comparison:

| N | rounds for 1/2^30 linkage |
|---|---|
| 2 | 30 |
| 4 | 15 |
| 6 | ~12 |
| 8 | 10 |

Larger N gets you to the same anonymity faster, with fewer total txs.

#### Cost

Per mix-box validator run: roughly `2N` scalar mul + `2N` add + ~3N uncompressed checks + 1 blake2b for the FS challenge. Per Mix tx: N validator runs + 1 fee_contract run = ~2N² scalar muls total.

`max_n` is determined empirically by the M2 stress test. Best-case estimate: `max_n = 6 to 8` is feasible on Cardano mainnet limits. We benchmark and commit the value to `network.preprod.json`.

The SDK defaults to the highest `N` the pool supports (uniform random selection across N boxes). If pool size < N, the SDK falls back to `N = pool.size`.

#### Tx structure

```
inputs (N of them):
  [0..N-1] N mix-boxes  redeemer = Mix(N-way SigmaOrProof)
  [N]      fee_contract shard  redeemer = PayMixFee
reference inputs:
  [_] reference UTxO
collateral input:
  [_] from collateral provider (e.g. giveme.my)
outputs (N + 1):
  [0..N-1] N mixScriptAddr  value = denom  datum = (a'_j, b'_j)
  [N]      feeScriptAddr  value = shard_in.value − tx.fee  datum = ()
collateral return:
  [_] back to provider
signers: collateral provider's key
```

**No wallet input from the submitter.** No submitter signature required. The tx is fully script-authorized except for the collateral, which comes from a service whose wallet is shared across many users.

#### Selection privacy

The submitter picks *which N boxes* to mix. SDK default: uniform random selection. The UI's "Mix N random boxes" button uses the default. Power-user override hidden behind an advanced toggle.

### Withdraw

The owner of secret `x` for a mix-box with registers `(a, b)` (where `b = [x]a`) spends the box to a destination by Schnorr proof. **No signer key for the box** — the proof is sufficient (Seedelf-style; see [03-contracts.md](03-contracts.md) §5).

```
inputs:
  [0] mix-box     datum = (a, b)    redeemer = Owner(SchnorrProof)
  [1] funding wallet UTxO         (covers tx fee)
reference inputs:
  [_] reference UTxO
collateral input:
  [_] from the funding wallet (already in the tx)
outputs:
  [0] destination address  value = denom
  [1] change to wallet
collateral return:
  [_] back to wallet
signers: wallet key
```

The Schnorr proof's challenge is bound to `txOutputsHash || mixScriptHash`. Replay or output substitution is impossible.

The user's wallet pays the tx fee and provides collateral (no need for a third-party collateral provider here; the user's wallet is already in the tx). Their wallet IS visible on chain. Mitigations:

- Use a fresh wallet for the withdraw — no prior history.
- Send the destination output to a [Seedelf](https://github.com/logical-mechanism/Seedelf-Wallet) stealth address; recipient identity is then hidden by Seedelf at the wallet layer.

## On-chain validation rules (summary)

Detailed in [03-contracts.md](03-contracts.md). Summary:

### `mix_box` Owner branch
1. Schnorr proof verifies against `(a, b)` with ctx = `blake2b_256(serialize(tx.outputs) || mixScriptHash)`.
2. Reference UTxO present and provides `ProtocolParams`.

### `mix_box` Mix branch (variable N)
1. Number of inputs at `mixScriptAddr` equals number of outputs at `mixScriptAddr`. Both equal `N`, with `2 ≤ N ≤ max_n`.
2. The N script outputs are at the first N positions of `tx.outputs` (positions 0 through N-1).
3. Each script output preserves `denom_lovelace`, no native assets.
4. Each output datum is well-formed `MixDatum` with `a' ≠ b'`.
5. Sigma-OR proof verifies for *this* input against all N output datums.
6. Proof's FS challenge is bound to all N output datums + values + mix_script_hash.

### `fee_contract` PayMixFee
1. ≥ 2 inputs at `mixScriptHash` (i.e., a Mix tx).
2. Exactly one fee input (this) and one fee output, datum unchanged.
3. `fee_in.lovelace - fee_out.lovelace == tx.fee`.
4. `tx.fee ≤ max_fee_per_mix_lovelace`.
5. No native assets.

### `fee_contract` Replenish
1. Exactly one fee input (this) and one fee output, datum unchanged.
2. `fee_out.lovelace > fee_in.lovelace`.
3. No native assets.

## Pool size and mix rounds

For a target linkage probability of `1/2^30` (high privacy), required rounds depend on `N`:

| N | Rounds | Total txs |
|---|---|---|
| 2 | 30 | 30 |
| 4 | 15 | 15 |
| 6 | 12 | 12 |

Higher `N` = fewer txs to reach the same privacy = lower total fees and faster mixing. The fee contract contribution per deposit (`N_rounds × max_fee_per_mix`) reflects the user's chosen rounds.

## Single pool in v1

ADA only, single denomination from config. Multi-denomination is M8+ — added based on demand.

## Out of scope (v1)

- Stealth withdraw (Seedelf at wallet layer).
- Outsourced mixer-bots, stealth payments, user incentives (paper §5).
- Confidential amounts.
- Native asset pools.
