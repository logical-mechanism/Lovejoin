# Cardano Smart Contract Audit Report

**Target:** `logical-mechanism/lovejoin` v0.3.0

**Audit date:** 2026-05-07

**Auditor:** audit-machine (audit.prompt.improved)

**Plutus version:** V3

**Aiken / stdlib:** Aiken `v1.1.21+42babe5` / stdlib `v3.1.0` (modern `cardano/transaction`, `cardano/assets`)

---

## 1. Executive Summary

- **Target folder audited:** `/home/logic/Documents/LogicalMechanism/audit_machine/contracts/lovejoin`
- **Contracts present:** five Aiken validators (1 mint, 4 spend / withdraw / publish) and 11 lib modules; no off-chain code in target.
- **Language / framework:** Aiken `v1.1.21` with stdlib `v3.1.0`; Plutus **V3** spend handlers (`Option<Datum>` correctly handled).
- **Imports:** `aiken-lang/stdlib v3.1.0`, `aiken-lang/fuzz v2.2.0`. **No** `aiken-design-patterns/*` packages — patterns are inlined.
- **Overall risk posture:** Mature codebase carrying multiple resolved prior-audit findings (F-1, F-2, F-4, F-5, F-17, F-19); residual security risk is concentrated in the address-handling perimeter (continuing outputs match payment credential only) and in the off-chain enforcement of bootstrap-time invariants. No principal-theft path identified; the High finding is a recurring value leak (staking-reward hijack) on the mix-pool.

### Findings count by tier

| Tier          | Count |
| ------------- | ----- |
| Critical      | 0     |
| High          | 1     |
| Medium        | 1     |
| Low           | 4     |
| Informational | 5     |
| Optimization  | 1     |

### Top three concerns

1. **[H-01]** Continuing-output address checks pin `payment_credential` only — `stake_credential` is attacker-controllable, hijacking staking rewards on the entire mix-pool every Mix tx.
2. **[M-01]** Same root cause as H-01: continuing outputs do not assert `reference_script == None`, so an attacker can attach a reference script at min-ADA cost and bloat the protocol pool.
3. **[L-01..L-03]** Three lifecycle invariants (one-shot NFT destination, ProtocolParams datum content, 10-shard fee-pool bootstrap) are enforced **only** in off-chain bootstrap scripts. The on-chain mint policy permits the NFT to land anywhere; downstream validators trust whatever UTxO carries `(policy_id, asset_name)` as the reference UTxO.

### Production / experimental / research-stage assessment

**Needs Work** — see §6 for the rubric. No Critical findings, but the High address-perimeter finding compounds across every Mix tx and the lifecycle gaps require off-chain audit (out of scope here) before mainnet.

### Readable-summary for a non-auditor

The contracts implement a privacy mixer correctly on the cryptography side (Schnorr + N-way sigma-OR, both bound to a per-tx Fiat-Shamir context). The depositor's funds are protected by the proof system. The biggest weakness is that when the protocol moves a mix-box from one UTxO to another, it only checks "is this the right script?" — not "is the staking part of the address still ours?" or "did someone attach extra junk to it?" Those gaps are common in early Cardano mixers and have known fixes. The other class of concern is that a few important setup steps live in shell scripts that aren't part of the audited code; whoever runs the bootstrap has to get them right, with no on-chain backstop to catch a mistake.

---

## 2. Versions & Build Metadata

- **`aiken.toml`:**

  ```toml
  name     = "logical-mechanism/lovejoin"
  version  = "0.3.0"
  compiler = "v1.1.21"
  plutus   = "v3"
  dependencies:
    aiken-lang/stdlib v3.1.0
    aiken-lang/fuzz   v2.2.0
  ```

- **`plutus.json` preamble:**

  ```json
  { "version": "0.2.0", "compiler": { "version": "v1.1.21+42babe5" } }
  ```

- **Build-artifact freshness:** `aiken.toml` `version = 0.3.0` ≠ `plutus.json` `preamble.version = 0.2.0` → **mismatch** (recorded as **[I-01]**). Compiler versions match (commit-suffix-only difference).

- **`aiken-design-patterns/*` library imports:** **none**. The codebase inlines the equivalents of `tx_level_minter` (one_shot_mint), `parameter_validation` (parameterized validators), and `stake_validator` (mix_logic withdraw-zero pattern).

- **Stdlib import style:** modern only (`cardano/transaction`, `cardano/assets`). No legacy `aiken/transaction` paths.

- **Git state:** **not a git repository** (`git rev-parse HEAD` failed under `contracts/lovejoin`). Audit performed against the on-disk source as of 2026-05-07.

---

## 3. Contract Overview

Lovejoin is a privacy mixer following the Sigmajoin design. Depositors place a fixed-denom mix-box at the `mix_box` script, carrying an inline `MixDatum { a, b }` where `(a, b)` is a Diffie-Hellman pair on BLS12-381 G1 (`b = [x]·a`). The depositor knows `x`. Spending a mix-box requires either:

- **Owner branch** — the depositor proves knowledge of `x` via Schnorr (per box), bound to the tx's full output set + every input's `OutputReference` + `mix_script_hash`. Withdraws funds anywhere.
- **Mix branch** — N depositors collectively prove (via N-way sigma-OR over re-randomised DH-tuples) that the N input boxes map to the N output boxes after re-randomisation, without revealing the bijection. Funds stay in the pool at fresh `(a', b')` pairs.

A separate sharded fee pool (`fee_contract`) holds 10 ADA-only shards; a Mix tx may consume one shard (`PayMixFee`) and re-create it short the actual `tx.fee`. `Replenish` allows anyone to top up a shard.

A single permanent reference UTxO at `reference_holder` carries the protocol's NFT (one-shot from `one_shot_mint`) and an inline `ReferenceDatum` that pins `denom_lovelace`, `max_fee_per_mix_lovelace`, and the three script hashes. Every other validator reads it via `tx.reference_inputs`.

### Validator inventory

| #   | Component          | Type                 | Purpose                                                                                                                                                             | Key Files                                                                                 | Plutus Ver | Auth Anchor                                 | Hyperstructure?                                                 |
| --- | ------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------- | ------------------------------------------- | --------------------------------------------------------------- |
| 1   | `reference_holder` | Spend (always-False) | Locks the protocol's reference NFT + `ReferenceDatum`; never spent in normal ops, read via `reference_inputs`.                                                      | [validators/reference_holder.ak](../../contracts/lovejoin/validators/reference_holder.ak) | V3         | one-shot NFT                                | yes (always-False is defense-in-depth)                          |
| 2   | `one_shot_mint`    | Mint                 | Single-use bootstrap policy: consumes a parameterized seed UTxO, mints exactly 1 token at canonical name `"lovejoin"`.                                              | [validators/one_shot_mint.ak](../../contracts/lovejoin/validators/one_shot_mint.ak)       | V3         | seed `OutputReference`                      | no                                                              |
| 3   | `mix_box`          | Spend                | Tiny delegator: requires `mix_logic` withdraw-zero to fire iff input has well-formed inline `MixDatum`; non-well-formed → Rule-2 recovery (True).                   | [validators/mix_box.ak](../../contracts/lovejoin/validators/mix_box.ak)                   | V3         | parameter (mix_logic ScriptHash) + Rule-2   | yes (recovery sweeps for malformed datums)                      |
| 4   | `mix_logic`        | Withdraw + Publish   | Real per-input verifier. Owner: N≥1 Schnorr proofs. Mix: N≥2 sigma-OR proofs. Both bind to FS context. publish accepts only `RegisterCredential`.                   | [validators/mix_logic.ak](../../contracts/lovejoin/validators/mix_logic.ak)               | V3         | reference NFT (read via `reference_inputs`) | partial (catch-all `_ -> False` on publish; not hyperstructure) |
| 5   | `fee_contract`     | Spend                | Sharded fee pool. PayMixFee gates "this is a real Mix tx" via redeemer cross-check + ≥2 mix inputs. Replenish strict-increase. Rule-2 recovery for non-unit datums. | [validators/fee_contract.ak](../../contracts/lovejoin/validators/fee_contract.ak)         | V3         | reference NFT (read via `reference_inputs`) | yes (Rule-2 recovery)                                           |

### Protocol flow narrative

1. **Bootstrap (off-chain).** A seed UTxO is consumed by `one_shot_mint`; the resulting NFT is sent to `reference_holder` together with an inline `ReferenceDatum`. Ten fee shards are paid to `fee_contract` with `()` datum each. (See §11 for the lifecycle gap.)
2. **Deposit (off-chain).** A user pays `denom_lovelace` to `mix_box` with inline `MixDatum { a, b }`.
3. **Mix (on-chain).** Two or more depositors construct a tx that consumes ≥2 well-formed mix-boxes and produces N continuing mix-boxes at the mix script with new `(a'_i, b'_i)` pairs. `mix_logic.withdraw` (with `Mix` redeemer) fires once per tx and verifies the N sigma-OR proofs. Optionally a fee shard is consumed via `fee_contract.PayMixFee`.
4. **Owner withdraw (on-chain).** A depositor consumes their box and proves knowledge of `x` via Schnorr (Owner branch).
5. **Replenish (on-chain).** Anyone may top up a fee shard with strict-increase semantics.
6. **Recovery (on-chain).** Any UTxO at `mix_box` with no datum, hash datum, or non-well-formed inline datum is sweepable by anyone (Rule-2 hyperstructure escape hatch). Same for fee shards with non-unit datums.

### Major assets / tokens

- One reference NFT: `(one_shot_mint_policy_id, "lovejoin")`. One-of-one for life.
- ADA only (mix-boxes and fee shards are ADA-only by validator enforcement).

### Expected transaction shapes

See §5.

### Off-chain assumptions

The bootstrap pipeline (`build.sh`, `infra/bootstrap/00-build-reference.sh` — outside target) is the only enforcer of: NFT destination, ProtocolParams datum shape, fee-shard count and datum. See L-01 / L-02 / L-03.

### User roles

- **Depositor** — anyone with ADA; deposits trigger no on-chain validator (mix-box is created via a normal tx output, not a script-spend).
- **Mixer** — any depositor who triggers a Mix tx; bears CPU/mem cost of N proofs.
- **Owner** — the depositor of a specific box; can withdraw at any time.
- **Replenisher** — anyone topping up a fee shard.

### Admin roles

**None.** The protocol is hyperstructure-style: there is no upgrade key, no multisig, no governance. The reference UTxO at `reference_holder` is permanently locked (always-False spend), so `ReferenceDatum` cannot be modified after bootstrap.

### Hyperstructure assumptions

- `reference_holder` always-False spend: defense-in-depth; the reference UTxO must never be spent. Cardano consumes `reference_inputs` read-only, so the validator never runs in normal ops. Documented in code (validators/reference_holder.ak:5-19). Acceptable.
- `mix_box` Rule-2 recovery (`None -> True`, `_ -> True` for non-well-formed datums): liveness escape hatch for accidentally-parked UTxOs at the mix-script address. Documented in code (validators/mix_box.ak:1-29) and tested in `validators/mix_box.test.ak` (F-2 regression). Acceptable.
- `fee_contract` Rule-2 recovery (`!is_unit_optional(datum) -> True`): liveness escape hatch for accidentally-parked UTxOs at the fee-script address. Documented in code (validators/fee_contract.ak:15-17) and tested. Acceptable.

### 3.7 Out of Scope

| Boundary                                                                                                                    | Why Out of Scope                                                                                                                                                                                              | Where It Surfaced | Risk If Wrong                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Off-chain transaction builder (TS/JS/Lucid/Mesh)                                                                            | Not present in TARGET_CONTRACT_FOLDER. README references an SDK at `pnpm --filter @lovejoin/sdk` but that lives outside `contracts/`.                                                                         | §18               | A bad builder cannot violate any on-chain check; it can only craft txs that fail validation. The off-chain risk (bootstrap mistakes, prover bugs, KAT drift) is real but not in this audit's remit. |
| Bootstrap / deployment pipeline (`build.sh`, `infra/bootstrap/`)                                                            | `build.sh` is in the target as a 1-line wrapper around `aiken build` + artifact copy; the real bootstrap (`infra/bootstrap/00-build-reference.sh`, parameterization, NFT placement) lives outside the target. | §11 (L-01..L-03)  | Critical — see L-01..L-03 lifecycle findings. A wrong bootstrap can place the NFT at the wrong address, write a wrong `ReferenceDatum`, or spawn fewer/more fee shards.                             |
| Cryptographic primitive correctness (BLS12-381 G1 group arithmetic, Schnorr soundness, sigma-OR Cramer-Damgård composition) | Per audit-prompt scope: this audit covers the Fiat-Shamir context construction, statement-ID disambiguation, and binding completeness — NOT the math.                                                         | §13, §15          | Out-of-scope for this audit. The crypto primitives are standard and Aiken's BLS12-381 builtins inherit blst's audited implementation.                                                               |
| TS prover ↔ Aiken verifier byte-equality (Fiat-Shamir wire layout)                                                          | The KAT tests (`schnorr_kat`, `dhtuple_kat`, `sigma_or_kat`, `encoding_parity_kat`) anchor parity but the SDK source that generated them is outside the target.                                               | §13               | A prover that emits a non-canonical FS preimage produces proofs the on-chain verifier rejects — denial-of-service for legitimate users, not theft.                                                  |
| External oracles or data feeds                                                                                              | None. Lovejoin reads no external data.                                                                                                                                                                        | N/A               | N/A                                                                                                                                                                                                 |
| Wallet / signer key management                                                                                              | No on-chain signer requirement (proofs gate everything).                                                                                                                                                      | §4                | N/A.                                                                                                                                                                                                |
| Governance / DAO upgrade procedures                                                                                         | None — protocol is hyperstructure-style with no upgrade key.                                                                                                                                                  | §3 admin roles    | N/A.                                                                                                                                                                                                |

### 3.8 Builder-Bypass Question

**Partially safe.** A handcrafted Cardano transaction cannot bypass the on-chain checks for the **ongoing** protocol logic: the sigma-OR / Schnorr proofs gate any spend of a well-formed mix-box, the fee-input/output count and value-drop checks gate `PayMixFee`, and the strict-increase check gates `Replenish`. **However**, a handcrafted transaction during the **bootstrap** window (between the seed UTxO being available and the legitimate bootstrap consuming it) can mint the protocol NFT and place it anywhere with any inline datum (see L-01 / L-02). Once the legitimate `ReferenceDatum` is in place at `reference_holder`, no handcrafted tx can change it (always-False spend), but every downstream validator trusts whichever `(policy_id, asset_name)` carrier UTxO is presented as `reference_input`. If two carriers exist, `read_reference_datum` aborts (singleton enforced at lib/lovejoin/reference.ak:30) — so a forged second carrier cannot replace the original; the protocol just gets bricked.

A second, smaller bypass surface: continuing-output address matching only checks payment credential, so a hand-built Mix tx can hijack stake credentials on every output (H-01) and attach reference scripts (M-01). These are not principal theft but recurring value leak.

---

## 4. Trust Model & Privileged Keys

| Role                      | Held By                                                        | Authority Scope                                                                                             | On-Chain Enforcement                                                                               | Off-Chain Enforcement                    | Notes                                                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bootstrap operator        | Whoever owns the seed UTxO at `one_shot_mint`'s parameter time | One-time: mint the NFT, place it at `reference_holder` with the right `ReferenceDatum`, spawn 10 fee shards | Mint policy enforces (seed consumed, name=`"lovejoin"`, qty=1). Destination + datum NOT enforced.  | Bootstrap shell scripts.                 | L-01..L-03. After bootstrap the role disappears.                                                                                                                             |
| Owner of mix-box `(a, b)` | Holder of secret `x` s.t. `b = [x]·a`                          | Spend that specific mix-box via Owner branch                                                                | Schnorr verify in mix_logic.validate_owner                                                         | n/a (knowledge-of-`x` is the credential) | This is a cryptographic role, not a Cardano role.                                                                                                                            |
| Mixer                     | Any owner of a well-formed mix-box                             | Trigger a Mix tx involving their box (≥2 inputs total)                                                      | Sigma-OR per-input proof in mix_logic.validate_mix; `mix_box.spend` requires the withdraw to fire  | n/a                                      | Multi-party concurrent action; each input's owner provides its own proof.                                                                                                    |
| Replenisher               | Anyone                                                         | Add ADA to a fee shard                                                                                      | fee_contract.validate_replenish strict-increase                                                    | n/a                                      | Permissionless by design.                                                                                                                                                    |
| Cert publisher            | Whoever submits the `RegisterCredential` cert at bootstrap     | Register the mix_logic stake credential so it can act as a withdraw script                                  | mix_logic.publish accepts `RegisterCredential`; rejects `Unregister`, delegation, governance certs | n/a                                      | F-5 fix prevents a malicious unregister. The credential is never delegated (no rewards on the mix_logic credential itself — but see H-01 for the per-UTxO stake credential). |

**Explicit no-admin claim.** Lovejoin has no upgrade path, no admin signer, no governance hook. The reference UTxO is locked at `reference_holder` (always-False) and the canonical mint policy is one-shot, so all parameters are immutable post-bootstrap. The risk surface this introduces is the **bootstrap-time** misconfiguration window (L-01..L-03).

---

## 5. Tx-Shape Map

Per validator × redeemer constructor:

| Validator / Redeemer                                          | Allowed Inputs                                           | Allowed Outputs                                                                                                         | Required Signers     | Required Mint / Burn                                  | Validity-Range Bound | Cross-Validator Deps                                                                                                             | Tests                                                               |
| ------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `reference_holder.spend`                                      | n/a (always-False)                                       | n/a                                                                                                                     | n/a                  | n/a                                                   | n/a                  | n/a                                                                                                                              | yes (defense-in-depth tested implicitly by the always-False return) |
| `one_shot_mint.mint`                                          | seed UTxO must be in `tx.inputs`                         | unconstrained                                                                                                           | n/a                  | mint exactly `[Pair("lovejoin", 1)]` under own policy | n/a                  | none                                                                                                                             | happy + neg (F-17 typo)                                             |
| `mix_box.spend` (well-formed inline `MixDatum`)               | own input + ref input set unconstrained                  | unconstrained                                                                                                           | n/a                  | n/a                                                   | n/a                  | requires `Withdraw(Script(mix_logic_hash))` in `tx.withdrawals`                                                                  | yes                                                                 |
| `mix_box.spend` (non-well-formed datum / NoDatum / DatumHash) | own input                                                | unconstrained                                                                                                           | n/a                  | n/a                                                   | n/a                  | none (Rule-2 recovery)                                                                                                           | yes (F-2)                                                           |
| `mix_logic.withdraw` (`Owner { proofs }`)                     | ≥1 well-formed mix-script inputs                         | unconstrained (proof binds them via ctx)                                                                                | n/a (proof = signer) | n/a                                                   | n/a                  | reference NFT must be in `reference_inputs`                                                                                      | yes (incl. F-4 KAT)                                                 |
| `mix_logic.withdraw` (`Mix { proofs }`)                       | ≥2 well-formed mix-script inputs                         | first N must be at mix script with ada-only `denom_lovelace` and inline `MixDatum`; remaining MUST NOT be at mix script | n/a (proof = signer) | n/a                                                   | n/a                  | reference NFT must be in `reference_inputs`                                                                                      | yes (positive + negative, multiple N values)                        |
| `mix_logic.publish` (`RegisterCredential`)                    | n/a (cert)                                               | n/a                                                                                                                     | n/a                  | n/a                                                   | n/a                  | none                                                                                                                             | yes (F-5 cert matrix)                                               |
| `mix_logic.publish` (any other certificate)                   | rejected                                                 | n/a                                                                                                                     | n/a                  | n/a                                                   | n/a                  | n/a                                                                                                                              | yes (F-5)                                                           |
| `fee_contract.spend` (non-unit datum)                         | own input                                                | unconstrained                                                                                                           | n/a                  | n/a                                                   | n/a                  | none (Rule-2 recovery)                                                                                                           | yes                                                                 |
| `fee_contract.spend` (`PayMixFee`)                            | exactly 1 fee-script input (this) + ≥2 mix-script inputs | exactly 1 fee-script output, datum=`()`, ada-only, lovelace dropped by `tx.fee`                                         | n/a                  | n/a                                                   | n/a                  | requires `Withdraw(Script(mix_logic_hash))` redeemer to be `Mix { .. }` (F-1 gate); requires reference NFT in `reference_inputs` | yes (incl. F-1 regression)                                          |
| `fee_contract.spend` (`Replenish`)                            | exactly 1 fee-script input (this)                        | exactly 1 fee-script output, datum=`()`, ada-only, lovelace strictly increased                                          | n/a                  | n/a                                                   | n/a                  | reference NFT in `reference_inputs`                                                                                              | yes                                                                 |

`else(_) { fail }` is the catch-all for every other script purpose on every validator (deny-by-default, see §19 dead-ends).

---

## 6. Ranking System

**Severity tiers:** Critical / High / Medium / Low / Informational / Optimization. Definitions per §4 of the audit prompt:

- **Critical** — direct theft, unauthorized minting, lock-forever, total bypass of intended validation.
- **High** — major invariant break, serious abuse, realistic loss-of-funds under common assumptions, recurring unbounded value leak.
- **Medium** — incorrect behavior, limited griefing, unsafe off-chain reliance, broken accounting in narrow cases, Cardano-specific shape issues.
- **Low** — narrow edge case, brittle assumption, validation gap unlikely to be exploited.
- **Informational** — documentation, naming, missing tests, ergonomics.
- **Optimization** — CPU / mem / size / cost-model improvement; never security tradeoff.

**Confidence labels:** Confirmed / Likely / Suspected / Unverified.

**Status values:** Open / Needs Verification / Not Exploitable As Written / Design Tradeoff / Intentional Hyperstructure Behavior / Optimization Opportunity.

**Production-readiness scale:**

- **Mainnet-ready** — Critical/High = 0; tests cover all redeemer constructors with negatives; hyperstructure paths classified.
- **Needs Work** — at least one High; OR Critical=0 but coverage gaps remain; OR a benchmark gap exists.
- **Not Ready** — any Critical; OR tests largely absent; OR hyperstructure paths Dangerous.
- **Research / Experimental** — author's stated intent matches the level of rigor.

Lovejoin: **Needs Work** — H-01 is open; lifecycle gaps L-01..L-03 require off-chain audit; no benchmarks (I-02).

---

## 7. Summary of Findings

Sorted Critical → High → Medium → Low → Informational → Optimization, then by Confidence → Component.

| ID   | Severity      | Confidence | Status                   | CWC     | Title                                                                                      | Component                    | File:Line                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | ------------- | ---------- | ------------------------ | ------- | ------------------------------------------------------------------------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H-01 | High          | Confirmed  | Open                     | CWC-018 | Stake-credential hijack on continuing mix-script and fee-script outputs                    | mix_logic + fee_contract     | [mixbox.ak:27-32](../../contracts/lovejoin/lib/lovejoin/mixbox.ak#L27-L32), [fee.ak:23-28](../../contracts/lovejoin/lib/lovejoin/fee.ak#L23-L28), [mix_logic.ak:269](../../contracts/lovejoin/validators/mix_logic.ak#L269), [fee_contract.ak:149](../../contracts/lovejoin/validators/fee_contract.ak#L149), [fee_contract.ak:177](../../contracts/lovejoin/validators/fee_contract.ak#L177) |
| M-01 | Medium        | Confirmed  | Open                     | CWC-021 | Reference-script injection on continuing outputs (min-ADA bloat)                           | mix_logic + fee_contract     | same call sites as H-01                                                                                                                                                                                                                                                                                                                                                                       |
| L-01 | Low           | Suspected  | Needs Verification       | CWC-015 | Off-chain-only enforcement of one-shot NFT destination                                     | one_shot_mint + bootstrap    | [one_shot_mint.ak:29-49](../../contracts/lovejoin/validators/one_shot_mint.ak#L29-L49)                                                                                                                                                                                                                                                                                                        |
| L-02 | Low           | Suspected  | Needs Verification       | CWC-015 | Off-chain-only enforcement of `ReferenceDatum` content at bootstrap                        | reference_holder + bootstrap | [reference_holder.ak:24-30](../../contracts/lovejoin/validators/reference_holder.ak#L24-L30)                                                                                                                                                                                                                                                                                                  |
| L-03 | Low           | Suspected  | Needs Verification       | CWC-015 | Off-chain-only enforcement of 10-shard fee-pool bootstrap                                  | fee_contract + bootstrap     | [fee_contract.ak:1-23](../../contracts/lovejoin/validators/fee_contract.ak#L1-L23)                                                                                                                                                                                                                                                                                                            |
| L-04 | Low           | Suspected  | Needs Verification       | CWC-023 | Mix branch fires without requiring a `PayMixFee` input (cross-validator coupling gap)      | mix_logic.withdraw (Mix)     | [mix_logic.ak:150-226](../../contracts/lovejoin/validators/mix_logic.ak#L150-L226)                                                                                                                                                                                                                                                                                                            |
| I-01 | Informational | Confirmed  | Open                     | CWC-030 | `aiken.toml` `version = 0.3.0` ahead of committed `plutus.json` `preamble.version = 0.2.0` | build artifact               | [aiken.toml](../../contracts/lovejoin/aiken.toml), [plutus.json](../../contracts/lovejoin/plutus.json)                                                                                                                                                                                                                                                                                        |
| I-02 | Informational | Confirmed  | Open                     | CWC-030 | Insufficient `bench` coverage for hot-path redeemers                                       | all validators               | n/a (zero `bench` blocks repo-wide)                                                                                                                                                                                                                                                                                                                                                           |
| I-03 | Informational | Confirmed  | Open                     | CWC-030 | Test fixtures cannot construct adversarial `stake_credential` variants (pairs with H-01)   | test_fixtures                | [test_fixtures.ak:96-102](../../contracts/lovejoin/lib/lovejoin/test_fixtures.ak#L96-L102)                                                                                                                                                                                                                                                                                                    |
| I-04 | Informational | Confirmed  | Open                     | CWC-030 | Test fixtures never attach a `reference_script` to a continuing output (pairs with M-01)   | test_fixtures                | [test_fixtures.ak:115-247](../../contracts/lovejoin/lib/lovejoin/test_fixtures.ak#L115-L247)                                                                                                                                                                                                                                                                                                  |
| I-05 | Informational | Confirmed  | Design Tradeoff          | CWC-027 | `lovejoin/dhtuple.ak` is unused by validators (kept as parity anchor for KAT tests)        | dhtuple module               | [dhtuple.ak:1-47](../../contracts/lovejoin/lib/lovejoin/dhtuple.ak#L1-L47)                                                                                                                                                                                                                                                                                                                    |
| O-01 | Optimization  | Suspected  | Optimization Opportunity | CWC-016 | `validate_replenish` uses `list.count` on `tx.inputs` without early-exit                   | fee_contract                 | [fee_contract.ak:172-174](../../contracts/lovejoin/validators/fee_contract.ak#L172-L174)                                                                                                                                                                                                                                                                                                      |

---

## 8. Detailed Findings

### H-01 Stake-credential hijack on continuing mix-script and fee-script outputs

**Severity:** High

**Confidence:** Confirmed

**Status:** Open

**CWC ID:** CWC-018 (Insufficient Access Control)

**Root Cause:** `address-perimeter-incomplete`

**Component:** `mix_logic` (Mix branch continuing outputs) + `fee_contract` (PayMixFee + Replenish continuing outputs); shared root in helpers `output_at_script` ([mixbox.ak:27-32](../../contracts/lovejoin/lib/lovejoin/mixbox.ak#L27-L32)) and `output_at_fee` ([fee.ak:23-28](../../contracts/lovejoin/lib/lovejoin/fee.ak#L23-L28)).

**Location:**

- [lib/lovejoin/mixbox.ak:27-32](../../contracts/lovejoin/lib/lovejoin/mixbox.ak#L27-L32) — root helper
- [lib/lovejoin/fee.ak:23-28](../../contracts/lovejoin/lib/lovejoin/fee.ak#L23-L28) — root helper
- [validators/mix_logic.ak:269](../../contracts/lovejoin/validators/mix_logic.ak#L269) — Mix branch prefix continuing-output check
- [validators/fee_contract.ak:148-150](../../contracts/lovejoin/validators/fee_contract.ak#L148-L150) — PayMixFee continuing-output check
- [validators/fee_contract.ak:176-178](../../contracts/lovejoin/validators/fee_contract.ak#L176-L178) — Replenish continuing-output check

**Quoted Code ([lib/lovejoin/mixbox.ak:27-32](../../contracts/lovejoin/lib/lovejoin/mixbox.ak#L27-L32)):**

```aiken
/// True iff the output's payment credential is a script with the given hash.
pub fn output_at_script(output: Output, mix_script_hash: ScriptHash) -> Bool {
  when output.address.payment_credential is {
    Script(script_hash) -> script_hash == mix_script_hash
    _ -> False
  }
}
```

**Quoted Code ([lib/lovejoin/fee.ak:23-28](../../contracts/lovejoin/lib/lovejoin/fee.ak#L23-L28)):**

```aiken
/// True iff the output is at the fee script.
pub fn output_at_fee(output: Output, fee_script_hash: ScriptHash) -> Bool {
  when output.address.payment_credential is {
    Script(script_hash) -> script_hash == fee_script_hash
    _ -> False
  }
}
```

**Quoted Code ([validators/mix_logic.ak:267-272](../../contracts/lovejoin/validators/mix_logic.ak#L267-L272)):**

```aiken
      if prefix_remaining > 0 {
        // Prefix step: at_script + decode + accumulate.
        expect output_at_script(output, reference_datum.mix_script_hash)
        expect
          expect_ada_only_lovelace(output.value) == reference_datum.denom_lovelace
        expect InlineDatum(inline_data) = output.datum
```

**What It Is:**
Every continuing output in Lovejoin (mix-script outputs from a Mix tx, and fee-script outputs from `PayMixFee` / `Replenish`) is matched against the protocol script hash by inspecting the `payment_credential` field of the output's `Address` only. The output's `stake_credential` is never read or constrained. A Cardano address is `(payment_credential, stake_credential)`; setting payment credential to the protocol script while pointing stake credential at an attacker-owned key gives the attacker unilateral control of the **staking rewards** earned on those UTxOs, even though the protocol still owns the spend rules.

**Why It Is Bad — Cardano Semantic Cited:**
Cardano's reward accounting separates payment authority (who can spend) from staking authority (who collects delegation rewards). The reward-account credential `stake_credential` decides where the lovelace at that address gets delegated and who can withdraw the rewards via `tx.withdrawals`. The validator gating spends only sees `tx.outputs[].address.payment_credential` and checks for the protocol's `Script(h)`; it never asserts `stake_credential == None` (or `== own_input.output.address.stake_credential`, or any canonical hyperstructure stake credential). On every Mix tx, the mixer picks the stake credentials of the N continuing outputs freely. Across the whole pool of N×denom_lovelace, the rewards earned during the period before the next Mix flow accrue to whoever was last to mix.

**Attack Scenario:**
Attacker is themselves a depositor (the only on-chain requirement to trigger a Mix tx is a single well-formed mix-box at the script — the attacker can deposit one).

- Inputs: 2 well-formed mix-script inputs (attacker's box + one other depositor's box), reference_input with the protocol NFT, attacker's wallet input for fees.
- Outputs:
  - 2 continuing mix-script outputs at `Address { payment_credential: Script(mix_script_hash), stake_credential: Some(Inline(VerificationKey(attacker_vk))) }`, each holding `denom_lovelace`, with the new `(a'_i, b'_i)` MixDatum.
  - Attacker's change.
- Mint: none.
- Signers: attacker_vk on the wallet input.
- Validity range: any.
- Withdraw redeemer for `mix_logic`: `Mix { proofs = [proof_for_attacker_box, proof_for_other_box] }`. Both proofs verify against the canonical FS context (which only binds `serialise_data(output.datum)` and `serialise_data(output.value)` and `mix_script_hash` — not the address's stake portion).

The Mix tx validates. The protocol's pool now has 2×denom_lovelace under the attacker's stake credential. The attacker delegates that stake to a pool of their choice; rewards accrue to the attacker's reward account. The rewards are withdrawable by the attacker via a normal `tx.withdrawals` (the validator's `mix_logic.withdraw` is a stake-script withdraw on a different credential — the protocol's mix_logic credential — so the attacker's withdrawals don't trigger any Lovejoin validator).

End-state: attacker earns staking rewards on the entire pool until the next Mix tx, at which point the next mixer can re-hijack to themselves. The contestation does not return rewards to the protocol; it just rotates which attacker collects.

**Proof / Evidence:**

- Quoted code above — primary evidence (root helpers + every caller).
- Cross-reference: [attacks/authentication.md:272-324](../../attacks/authentication.md#L272-L324) (Insufficient Staking-Credential Control / Stake Hijack); no direct CTF analogue.
- The Lovejoin codebase contains zero greps that bind `stake_credential` on continuing outputs (verified: `grep -rn "stake_credential" --include="*.ak" .` returns only test fixtures and stdlib definitions, never an assertion on a continuing output).

**How To Fix:**
Replace the two helpers with a single `is_protocol_output(o, expected_hash)` and call it from every continuing-output check site:

```aiken
pub fn is_protocol_output(output: Output, expected_script_hash: ScriptHash) -> Bool {
  when output.address.payment_credential is {
    Script(h) ->
      and {
        h == expected_script_hash,
        output.address.stake_credential == None,
        output.reference_script == None,   // resolves M-01 in the same edit
      }
    _ -> False
  }
}
```

Alternative (if the protocol later wants to delegate the pool itself to a canonical hyperstructure stake credential): replace `== None` with `== Some(Inline(Script(canonical_stake_script_hash)))` and bake `canonical_stake_script_hash` into `ReferenceDatum`. The "no admin" claim is preserved because the canonical script can itself be always-False or always-True.

**Tests To Add:**

- Negative
  - [ ] `mix_logic_mix_rejects_continuing_output_with_attacker_stake_vk` — Mix tx with output at `Address { payment_credential: Script(mix_script_hash), stake_credential: Some(Inline(VerificationKey(attacker_vk))) }`; assert validator returns False.
  - [ ] `mix_logic_mix_rejects_continuing_output_with_attacker_stake_script` — same but `Some(Inline(Script(attacker_script_hash)))`.
  - [ ] `mix_logic_mix_rejects_continuing_output_with_pointer_stake_credential` — `Some(Pointer(_))`.
  - [ ] `fee_contract_paymixfee_rejects_fee_output_with_attacker_stake_vk`.
  - [ ] `fee_contract_replenish_rejects_fee_output_with_attacker_stake_vk`.
- Positive
  - [ ] `mix_logic_mix_accepts_continuing_output_with_stake_credential_None` (regression — current happy path covers this implicitly; add an explicit test once `is_protocol_output` is in place).
- Property
  - [ ] Fuzz `stake_credential` over the 5-shape variants from `aiken-lang/fuzz` `cardano.address` (None / Inline VK / Inline Script / Pointer) — assert all non-`None` shapes fail.

**Additional Notes:**

- Severity discipline: this is a **value leak**, not principal theft. The N×denom lovelace can never be moved out of `mix_script` without a valid Schnorr or sigma-OR proof, so the depositors' principal is preserved. But the staking rewards on that principal are diverted indefinitely (until the next mix), which makes this a **recurring unbounded** value leak relative to the pool size. Per §4 of the audit prompt: "Value leak, permanent and unbounded relative to principal at risk → High (cap)." We pick High.
- The stake-credential hijack is contested every Mix tx — the next mixer re-rotates control. This does not soften the finding because the rewards already accrued by the previous attacker are NOT recoverable.
- Closing the same root cause also closes M-01 (reference_script field).
- Pairs with **I-03**: existing test fixtures hardcode `stake_credential: None` everywhere, which is why no negative test caught this.

**Knowledge References:**

- [attacks/authentication.md:272-324](../../attacks/authentication.md#L272-L324) (Insufficient Staking-Credential Control)
- [taxonomy.md:121-152](../../taxonomy.md#L121-L152) (CWC-018)

**Tags:** `stake-credential`, `address-perimeter`, `value-leak`, `staking-hijack`, `CWC-018`, `mix-pool`, `fee-shard`

---

### M-01 Reference-script injection on continuing outputs (min-ADA bloat)

**Severity:** Medium

**Confidence:** Confirmed

**Status:** Open

**CWC ID:** CWC-021 (Reference Script Vulnerability)

**Root Cause:** `address-perimeter-incomplete`

**Component:** `mix_logic` (Mix branch continuing outputs) + `fee_contract` (PayMixFee + Replenish continuing outputs); same shared helpers as H-01.

**Location:**

- [validators/mix_logic.ak:269](../../contracts/lovejoin/validators/mix_logic.ak#L269) — Mix prefix continuing-output check
- [validators/fee_contract.ak:148-150](../../contracts/lovejoin/validators/fee_contract.ak#L148-L150) — PayMixFee fee-output check
- [validators/fee_contract.ak:176-178](../../contracts/lovejoin/validators/fee_contract.ak#L176-L178) — Replenish fee-output check

**Quoted Code ([validators/mix_logic.ak:267-275](../../contracts/lovejoin/validators/mix_logic.ak#L267-L275)):**

```aiken
      if prefix_remaining > 0 {
        // Prefix step: at_script + decode + accumulate.
        expect output_at_script(output, reference_datum.mix_script_hash)
        expect
          expect_ada_only_lovelace(output.value) == reference_datum.denom_lovelace
        expect InlineDatum(inline_data) = output.datum
        let mix_datum = decode_mix_datum_strict(inline_data)
        let stmt =
          DHTupleStatementPt {
```

(No `expect output.reference_script == None` anywhere in the quoted block — nor at any caller of `output_at_script` / `output_at_fee`. Confirmed by `grep -rn "reference_script" --include="*.ak" . | grep -v test`.)

**What It Is:**
Continuing outputs at the mix script and at the fee script are matched by `payment_credential` only; the `reference_script: Option<ScriptHash>` field on each `Output` is never asserted to be `None`. An attacker constructing a Mix or Replenish tx can attach a reference-script field to any continuing output. Subsequent transactions can use that UTxO as a `tx.reference_inputs` entry to bring an arbitrary script onto another tx's `tx.scripts` cheaply (paying only the per-byte ref-script lookup fee); the attacker has effectively used the protocol pool as a free reference-script storage layer.

**Why It Is Bad — Cardano Semantic Cited:**
Cardano outputs carry a fourth field, `reference_script: Option<ScriptHash>`, which is the script-hash payload that any later transaction may include in its reference-script set without paying that script's per-byte construction cost again. Min-ADA on a Plutus V3 output scales with `(serialised_size_of_value + ref_script_size × byte_cost)`. The denom is fixed at `denom_lovelace` (e.g. 100 ADA per spec) — far above the min-ADA for even a 100 KB ref-script — so the attacker can attach any script ≤ ~3 MB without bumping into the value-side check. The attacker's tx pays the (small) inclusion fee; the protocol pool then permanently carries the bytes.

Two consequences:

1. **Min-ADA bloat:** The protocol's pool now contains UTxOs with non-zero ref-script bytes. If the pool ever needs to migrate (e.g. because a future audit recommends a parameterized re-deployment), users moving boxes must pay min-ADA inflated by ref-script bytes — a permanent encumbrance.
2. **Free script storage:** The attacker can park useful scripts in the pool for later reference-input use elsewhere. This is the canonical [`ctf/10_king_of_cardano.md`](../../ctf/10_king_of_cardano.md) shape.

The cryptographic FS context is **not** affected: `serialise_data(output.value)` does not include the ref-script field (it lives in a separate Output position), and the Mix-branch FS context only hashes `output.datum` and `output.value`. So the attack does not break Mix proofs — it only bloats the pool.

**Attack Scenario:**
Attacker triggers a Mix tx with the same shape as H-01:

- Inputs: 2 well-formed mix-script inputs.
- Outputs: 2 continuing mix-script outputs at the canonical address, each holding `denom_lovelace` and inline `MixDatum`, plus `reference_script: Some(arbitrary_script_hash)` on each output.
- Other fields per §5 Mix shape.

The validator passes because `output_at_script` only checks payment credential, ada-only check passes (the value is the same denom regardless of ref-script), datum decode succeeds, sigma-OR proofs verify. The two outputs now carry the attacker's chosen reference scripts. Same shape applies to `Replenish` (one fee-script output with attached ref-script).

End-state: the protocol pool permanently encumbered with attacker-chosen ref-script bytes; attacker can use those UTxOs as reference-input sources for unrelated future txs at no marginal cost.

**Proof / Evidence:**

- Quoted code above.
- [attacks/transaction_shape.md:259-285](../../attacks/transaction_shape.md#L259-L285) (Reference-Script Injection / Min-ADA Bloat).
- [ctf/10_king_of_cardano.md:1-173](../../ctf/10_king_of_cardano.md) (canonical CTF for this shape).

**How To Fix:**
Same single-helper fix as H-01:

```aiken
pub fn is_protocol_output(output: Output, expected_script_hash: ScriptHash) -> Bool {
  when output.address.payment_credential is {
    Script(h) ->
      and {
        h == expected_script_hash,
        output.address.stake_credential == None,
        output.reference_script == None,
      }
    _ -> False
  }
}
```

Replace every `output_at_script` / `output_at_fee` call site with `is_protocol_output(...)`. The negative version `!output_at_script` (mix_logic.ak:292, the Mix tail-output check) needs no change — it's asserting "output is NOT at mix_script", which is still satisfied by an attacker output that adds extras.

**Tests To Add:**

- Negative
  - [ ] `mix_logic_mix_rejects_continuing_output_with_reference_script_attached` — Mix tx with prefix outputs carrying `reference_script: Some(arbitrary_hash)`.
  - [ ] `fee_contract_paymixfee_rejects_fee_output_with_reference_script_attached`.
  - [ ] `fee_contract_replenish_rejects_fee_output_with_reference_script_attached`.
- Property
  - [ ] Fuzz `reference_script` over `Option<ScriptHash>` (None vs Some); assert Some always rejects.

**Additional Notes:**

- Severity is Medium because the impact is bounded griefing (bloat / free storage), not direct theft or pool drain.
- Closes H-01 in the same edit if the unified `is_protocol_output` helper is adopted.
- Pairs with **I-04**: existing fixtures never construct `reference_script: Some(_)` on a continuing output, so no negative test caught this.

**Knowledge References:**

- [attacks/transaction_shape.md:259-285](../../attacks/transaction_shape.md#L259-L285) (Reference-Script Injection)
- [ctf/10_king_of_cardano.md:1-173](../../ctf/10_king_of_cardano.md#L1-L173)
- [taxonomy.md:121-152](../../taxonomy.md#L121-L152) (CWC-021)

**Tags:** `reference-script`, `address-perimeter`, `min-ada-bloat`, `CWC-021`, `mix-pool`, `fee-shard`

---

### L-01 Off-chain-only enforcement of one-shot NFT destination

**Severity:** Low

**Confidence:** Suspected

**Status:** Needs Verification

**CWC ID:** CWC-015 (State Transition Violation — lifecycle bypass at UTxO creation)

**Root Cause:** `lifecycle-off-chain-only`

**Component:** `one_shot_mint` mint policy + the off-chain bootstrap pipeline.

**Location:**

- [validators/one_shot_mint.ak:29-49](../../contracts/lovejoin/validators/one_shot_mint.ak#L29-L49)

**Quoted Code ([validators/one_shot_mint.ak:29-49](../../contracts/lovejoin/validators/one_shot_mint.ak#L29-L49)):**

```aiken
validator one_shot_mint(seed_tx_id: TransactionId, seed_idx: Int) {
  mint(_redeemer: Data, policy_id: assets.PolicyId, self: Transaction) {
    let seed =
      OutputReference { transaction_id: seed_tx_id, output_index: seed_idx }
    let seed_consumed =
      self.inputs
        |> list.any(fn(input) { input.output_reference == seed })

    // Exactly one (asset_name, quantity) pair under this policy. The
    // pattern-match on `[Pair(_, _)]` enforces dict size == 1, so the
    // explicit size check folds away. Asset name is pinned to
    // `"lovejoin"` (hex 6c6f76656a6f696e); quantity is pinned to 1.
    let tokens_under_policy = assets.tokens(self.mint, policy_id)
    expect [Pair(asset_name, quantity)] = tokens_under_policy |> dict.to_pairs

    and {
      seed_consumed,
      asset_name == #"6c6f76656a6f696e",
      quantity == 1,
    }
  }
```

**What It Is:**
The one-shot mint policy enforces (a) the seed UTxO is consumed, (b) exactly one token is minted under this policy, (c) the asset name equals `"lovejoin"`. It does **not** enforce that the minted NFT goes to the `reference_holder` script address. Whoever first consumes the seed UTxO can mint the protocol NFT and place it anywhere — into their own wallet, into another script, or into a `reference_holder` address with a wrong inline datum.

**Why It Is Bad — Cardano Semantic Cited:**
Cardano's mint phase runs the mint policy but does not constrain output placement of the minted token; that is the responsibility of the spending validator on the destination address, OR of the mint policy itself if the destination is part of its security contract. `reference_holder` is always-False, so it has no creation-time validator (validators don't run on UTxO creation; only on spend). If the bootstrap pipeline mis-places the NFT, the mistake is permanent (the seed UTxO can no longer be consumed; the policy can never fire again). Every downstream validator (mix_logic, fee_contract) trusts whatever UTxO presents `(one_shot_mint_policy_id, "lovejoin")` as the reference UTxO via `lib/lovejoin/reference.ak`. If two carriers exist, `read_reference_datum` aborts (singleton enforced — see §10), so the protocol just bricks. If the carrier exists with a wrong datum, `expect parsed: ReferenceDatum = datum_data` aborts.

This is a classic [bank_05](../../ctf/bank_05_misconfiguration.md) / [bank_04](../../ctf/bank_04_lifecycle.md) lifecycle gap: the _initial_ UTxO's invariants (correct address, correct datum) are not enforced by an on-chain validator at creation time.

**Attack Scenario:**
This is a **bootstrap-window** attack, not an ongoing-protocol attack:

- Time T0: `one_shot_mint` is parameterized against seed UTxO `S`.
- Time T1: the legitimate bootstrap operator submits a tx consuming `S`, minting the NFT, sending it to `reference_holder` with the right datum.
- **Race window:** any party that can spend `S` between T0 and T1 (e.g. the bootstrap operator's own wallet is compromised, or `S` is publicly spendable) can mint the NFT and put it anywhere.

End-state: protocol misconfigured at deploy time; cannot be self-correcting (no upgrade path).

**Proof / Evidence:**

- Quoted code above shows the mint handler with no destination check.
- [attacks/state.md:165-218](../../attacks/state.md#L165-L218) (Lifecycle Bypass At UTxO Creation) and [attacks/state.md:224-](../../attacks/state.md#L224) (Misconfigured Config UTxO As Trust Anchor).
- [ctf/bank_04_lifecycle.md:1-136](../../ctf/bank_04_lifecycle.md#L1-L136) and [ctf/bank_05_misconfiguration.md:1-112](../../ctf/bank_05_misconfiguration.md#L1-L112) — exact CTF analogues.

**How To Fix:**
Two on-chain enforcement options, in increasing strictness:

1. **Destination check inside the mint policy.** Add to `one_shot_mint.mint`:

   ```aiken
   // Require the minted NFT to be sent to the reference_holder script address
   // with an InlineDatum that decodes as ReferenceDatum.
   expect Some(target_output) =
     self.outputs |> list.find(fn(o) {
       output_at_script(o, reference_holder_hash) &&
         assets.quantity_of(o.value, policy_id, asset_name) == 1
     })
   expect InlineDatum(d) = target_output.datum
   expect _: ReferenceDatum = d
   ```

   This requires baking `reference_holder_hash` into `one_shot_mint`'s parameter list — a circular dependency since `reference_holder` is itself parameterized by `(policy_id, asset_name)`. Resolvable by computing both hashes off-chain in the bootstrap and passing the destination hash as a third one_shot_mint param.

2. **Post-deploy on-chain verification UTxO.** Mint a second token at bootstrap that lives at a "deploy-acknowledgement" script that asserts the reference UTxO's full address+datum shape on its own spend. Heavier; not recommended.

For a hyperstructure protocol, option 1 is preferred — it eliminates the off-chain trust assumption entirely.

**Tests To Add:**

- Negative
  - [ ] `one_shot_mint_rejects_when_nft_not_sent_to_reference_holder` — bootstrap tx that mints the NFT to an arbitrary address.
  - [ ] `one_shot_mint_rejects_when_target_datum_is_not_reference_datum_shape` — minted NFT sent to reference_holder with a wrong-shape datum.
- Positive
  - [ ] `one_shot_mint_accepts_canonical_bootstrap_tx` — minted NFT sent to reference_holder with canonical `ReferenceDatum`.

**Additional Notes:**

- Severity Low because: (a) it requires control of the seed UTxO, (b) the legitimate bootstrap operator is the protocol deployer (security boundary is the deployer's wallet), (c) any misconfiguration produces a "broken protocol" not "stolen funds" — the depositors' funds are protected by the mint policy's one-shot guarantee post-bootstrap. The reason this still matters for an audit is that hyperstructure protocols are explicitly meant to remove the trusted-deployer assumption.
- Status `Needs Verification`: the off-chain bootstrap (`infra/bootstrap/00-build-reference.sh` referenced in [README.md](../../contracts/lovejoin/README.md)) is outside this audit's scope. Audit it separately.

**Knowledge References:**

- [attacks/state.md:165-218](../../attacks/state.md#L165-L218) (Lifecycle Bypass)
- [ctf/bank_04_lifecycle.md:1-136](../../ctf/bank_04_lifecycle.md#L1-L136)
- [ctf/bank_05_misconfiguration.md:1-112](../../ctf/bank_05_misconfiguration.md#L1-L112)
- [taxonomy.md:121-152](../../taxonomy.md#L121-L152) (CWC-015)

**Tags:** `lifecycle`, `bootstrap`, `one-shot-mint`, `off-chain-enforcement`, `CWC-015`

---

### L-02 Off-chain-only enforcement of `ReferenceDatum` content at bootstrap

**Severity:** Low

**Confidence:** Suspected

**Status:** Needs Verification

**CWC ID:** CWC-015

**Root Cause:** `lifecycle-off-chain-only`

**Component:** `reference_holder` + the off-chain bootstrap pipeline.

**Location:**

- [validators/reference_holder.ak:24-30](../../contracts/lovejoin/validators/reference_holder.ak#L24-L30)
- [lib/lovejoin/reference.ak:21-34](../../contracts/lovejoin/lib/lovejoin/reference.ak#L21-L34)

**Quoted Code ([validators/reference_holder.ak:24-35](../../contracts/lovejoin/validators/reference_holder.ak#L24-L35)):**

```aiken
validator reference_holder(
  _reference_nft_policy: PolicyId,
  _reference_nft_name: AssetName,
) {
  spend(_d: Option<Data>, _r: Data, _utxo: OutputReference, _self: Transaction) {
    False
  }

  else(_) {
    fail
  }
}
```

**Quoted Code ([lib/lovejoin/reference.ak:21-34](../../contracts/lovejoin/lib/lovejoin/reference.ak#L21-L34)):**

```aiken
pub fn read_reference_datum(
  self: Transaction,
  policy: PolicyId,
  name: AssetName,
) -> ReferenceDatum {
  let carriers =
    self.reference_inputs
      |> list.filter(fn(input) { holds_reference_nft(input, policy, name) })

  expect [Input { output, .. }] = carriers
  expect InlineDatum(datum_data) = output.datum
  expect parsed: ReferenceDatum = datum_data
  parsed
}
```

**What It Is:**
The reference UTxO at `reference_holder` carries an inline `ReferenceDatum` whose fields (`denom_lovelace`, `max_fee_per_mix_lovelace`, `mix_script_hash`, `mix_logic_script_hash`, `fee_script_hash`) are written at bootstrap time by an off-chain script. `reference_holder.spend` is always-False, so the datum is immutable post-bootstrap. There is no on-chain enforcement that the values written are sane (e.g. `denom_lovelace > 0`, `max_fee_per_mix_lovelace > 0` and below some economic threshold, script hashes match the actual `mix_script` / `mix_logic` / `fee_contract` validators compiled against the same parameters).

**Why It Is Bad — Cardano Semantic Cited:**
This is the same family as L-01: the _initial_ UTxO state is established by a transaction that does not run a validator on the destination address (`reference_holder` is always-False, and validators don't run on creation regardless). Downstream validators trust this datum unconditionally:

- `mix_logic.validate_mix` reads `denom_lovelace` to enforce per-output value (mix_logic.ak:271). A wrong value at bootstrap permanently mis-prices the pool.
- `mix_logic.validate_owner` reads `mix_script_hash` to bind the FS context (mix_logic.ak:129).
- `mix_logic.validate_mix` reads `mix_script_hash` for the prefix/tail output classification (mix_logic.ak:269, mix_logic.ak:292).
- `fee_contract.validate_pay_mix_fee` reads `mix_logic_script_hash` to look up the withdraw redeemer (fee_contract.ak:106), `mix_script_hash` for the input classifier (fee_contract.ak:135), `max_fee_per_mix_lovelace` as the fee cap (fee_contract.ak:159), and `fee_script_hash` for the own-input cross-check (fee_contract.ak:111-131).

A wrong script hash here doesn't let an attacker substitute a malicious validator (the hash is what the validator's own logic checks against), but it can permanently brick that pathway.

**Attack Scenario:**
Same as L-01: bootstrap-window misconfiguration. An attacker who controls the bootstrap can write any `ReferenceDatum`. End state: pool deployed with wrong denom or wrong fee cap; cannot be corrected.

**Proof / Evidence:**

- Quoted code above (always-False spend; `read_reference_datum` decodes whatever's there).
- [attacks/state.md:224-](../../attacks/state.md#L224) (Misconfigured Config UTxO As Trust Anchor).
- [ctf/bank_05_misconfiguration.md:1-112](../../ctf/bank_05_misconfiguration.md#L1-L112).

**How To Fix:**
The fix coordinates with L-01: extend the `one_shot_mint` policy to also assert the destination output's inline datum decodes as a `ReferenceDatum` with sane bounds:

```aiken
expect parsed: ReferenceDatum = d
expect parsed.denom_lovelace > 0
expect parsed.max_fee_per_mix_lovelace > 0
expect parsed.max_fee_per_mix_lovelace < parsed.denom_lovelace  // or some economic invariant
// Script hash equality to the deployed scripts is harder — see "Notes" below.
```

For script-hash equality (preventing an attacker from baking `mix_script_hash = attacker_script` into the datum and routing future Mix txs through a malicious validator), the only watertight on-chain fix is to **recompute** the expected script hashes inside `one_shot_mint`. That's not feasible because Aiken doesn't expose script-hash derivation as a builtin. The practical mitigation is operational: require the bootstrap script to deterministically derive the four hashes from a single seed and write them into the `ReferenceDatum`; commit the bootstrap script in source control and run it under reproducibility checks.

**Tests To Add:**

- Negative
  - [ ] `one_shot_mint_rejects_when_target_datum_has_zero_denom`.
  - [ ] `one_shot_mint_rejects_when_target_datum_has_max_fee_above_denom`.
- Positive
  - [ ] `one_shot_mint_accepts_canonical_reference_datum`.

**Additional Notes:**

- Severity Low for the same reasons as L-01.
- Status `Needs Verification`: audit the off-chain bootstrap pipeline.
- The script-hash entries in the `ReferenceDatum` are essentially a "mutable circular dependency cut" — each downstream validator could be parameterized directly by the others' hashes (replacing the `ReferenceDatum` lookup), but that creates the same circular-dependency problem at compile time. The current design is acceptable as long as the bootstrap is honest.

**Knowledge References:**

- [attacks/state.md:224-](../../attacks/state.md#L224) (Misconfigured Config UTxO)
- [ctf/bank_05_misconfiguration.md:1-112](../../ctf/bank_05_misconfiguration.md#L1-L112)
- [taxonomy.md:121-152](../../taxonomy.md#L121-L152) (CWC-015)

**Tags:** `lifecycle`, `bootstrap`, `reference-datum`, `off-chain-enforcement`, `CWC-015`

---

### L-03 Off-chain-only enforcement of 10-shard fee-pool bootstrap

**Severity:** Low

**Confidence:** Suspected

**Status:** Needs Verification

**CWC ID:** CWC-015

**Root Cause:** `lifecycle-off-chain-only`

**Component:** `fee_contract` + the off-chain bootstrap pipeline.

**Location:**

- [validators/fee_contract.ak:1-23](../../contracts/lovejoin/validators/fee_contract.ak#L1-L23)
- [lib/lovejoin/types.ak:29-32](../../contracts/lovejoin/lib/lovejoin/types.ak#L29-L32)

**Quoted Code ([validators/fee_contract.ak:1-23](../../contracts/lovejoin/validators/fee_contract.ak#L1-L23)):**

```aiken
//// `fee_contract` — sharded fee pool spend validator.
////
//// Spec: §0 Rule 2, §3.
////
//// 10 shard UTxOs (the `fee_shard_target`) live at this validator. Two
//// redeemer paths preserve the shard count (1 input → 1 output):
////
////   * `PayMixFee` — consumed by a Mix tx; the value drop on this shard
////     equals the tx's fee, with `tx.fee ≤ max_fee_per_mix_lovelace`. The
////     mix_logic withdraw redeemer in the same tx must be `Mix { .. }`
////     (not `Owner`), and there must be ≥ 2 mix-script inputs — together
////     these gate "this is actually a Mix tx" (see audit finding F-1).
////   * `Replenish` — strict-increase top-up; usable in a Deposit tx.
////
//// Rule 2 (hyperstructure): an input whose datum isn't `()` is treated as
//// accidentally parked and the spend is allowed (recovery path). Real fee
//// shards always carry `()`.
```

**Quoted Code ([lib/lovejoin/types.ak:29-32](../../contracts/lovejoin/lib/lovejoin/types.ak#L29-L32)):**

```aiken
/// No `fee_shard_target` either, as of M4.5: the canonical 10-shard pool is
/// off-chain coordination — no validator reads the count, and committing it
/// on-chain forced every reference-datum decode to walk one more field.
/// Dropped as part of the M4.5 redeploy schema cleanup.
```

**What It Is:**
The protocol is designed around 10 fee shards living at `fee_contract`, but this is **not** an on-chain invariant. The validator enforces conservation per spend (1 fee-input → 1 fee-output for both PayMixFee and Replenish), but there is no on-chain check that "exactly 10 fee-script UTxOs exist" or that all 10 were created at bootstrap. The `fee_shard_target` field was deliberately removed from `ReferenceDatum` (see types.ak quoted above) on the grounds that no validator reads it.

**Why It Is Bad — Cardano Semantic Cited:**
The spec relies on the 10-shard count to (a) reduce per-tx contention (each Mix tx picks one of 10 shards to consume, allowing 10 Mix txs to run concurrently without UTxO contention) and (b) bound the worst-case drain (an attacker can drain at most 10 × `max_fee_per_mix_lovelace`). If the bootstrap creates fewer shards (or zero), property (a) degrades; if it creates more, the drain bound increases linearly with shard count. Cardano's ledger has no concept of "this script address must hold exactly N UTxOs"; the only on-chain enforcement would be a creation-time mint policy that mints "shard tokens" (one per shard, capped at 10).

**Attack Scenario:**
This is a **bootstrap mistake**, not an attacker action: the bootstrap operator forgets to spawn one of the shards, and the protocol launches with 9 shards. No UTxO is at risk; performance and security degrade gracefully.

The adversarial variant is: an attacker who controls the bootstrap creates 100 shards instead of 10. Drain ceiling is now 100 × `max_fee_per_mix_lovelace`. Still bounded, but 10× higher than intended.

**Proof / Evidence:**

- Quoted code (the spec narrates "10 shards"; the validator does not).
- The drain-attack note in the same file (fee_contract.ak:18-23) explicitly defers shard-count enforcement to "post-M2 follow-up."

**How To Fix:**
Two options:

1. **Mint a shard token at bootstrap.** Add a second mint policy `fee_shard_mint` parameterized by the same seed UTxO, requiring it to mint exactly `K` tokens at canonical name `"fee-shard-#{i}"` where `i ∈ [0, K)`. Each fee shard then carries one shard token in addition to ADA. `fee_contract.spend` requires the input to carry exactly one shard token (and the output to carry the same one). This guarantees the shard count is forever capped at K.
2. **Document and accept.** Mark in the README that "10 shards is convention; deployments may differ; the on-chain max drain is `shard_count × max_fee_per_mix_lovelace`." Add this to `ReferenceDatum` as `fee_shard_count` (re-introducing the field that M4.5 removed) and let `read_reference_datum` decode it.

Option 1 is the hyperstructure-correct fix; option 2 is acceptable for a protocol that trusts its bootstrap operator.

**Tests To Add:**

- Positive
  - [ ] (with option 1) `fee_shard_mint_accepts_exactly_K_shard_tokens`.
- Negative
  - [ ] (with option 1) `fee_contract_paymixfee_rejects_input_without_shard_token`.

**Additional Notes:**

- Severity Low because the impact is bounded and the worst case is "more drain capacity" (still self-funded by attacker), not principal theft.
- The M4.5 schema-cleanup decision to drop `fee_shard_target` was likely an over-optimization at the cost of an enforceable invariant. Re-adding it as either a `ReferenceDatum` field or a per-shard mint token is recommended.

**Knowledge References:**

- [attacks/state.md:165-218](../../attacks/state.md#L165-L218) (Lifecycle Bypass)
- [ctf/bank_04_lifecycle.md:1-136](../../ctf/bank_04_lifecycle.md#L1-L136)
- [taxonomy.md:121-152](../../taxonomy.md#L121-L152) (CWC-015)

**Tags:** `lifecycle`, `bootstrap`, `fee-shard`, `off-chain-enforcement`, `CWC-015`, `drain-bound`

---

### L-04 Mix branch fires without requiring a `PayMixFee` input (cross-validator coupling gap)

**Severity:** Low

**Confidence:** Suspected

**Status:** Needs Verification

**CWC ID:** CWC-023 (Cross-Validator Incoherence)

**Root Cause:** `mix-fee-coupling-one-directional`

**Component:** `mix_logic.withdraw` (Mix branch).

**Location:**

- [validators/mix_logic.ak:150-226](../../contracts/lovejoin/validators/mix_logic.ak#L150-L226)
- [validators/fee_contract.ak:77-161](../../contracts/lovejoin/validators/fee_contract.ak#L77-L161) (the other side of the coupling)

**Quoted Code ([validators/mix_logic.ak:150-158](../../contracts/lovejoin/validators/mix_logic.ak#L150-L158)):**

```aiken
fn validate_mix(
  self: Transaction,
  reference_datum: ReferenceDatum,
  mix_inputs: List<MixDatum>,
  proofs: List<SigmaOrProof>,
) -> Bool {
  let n = list.length(mix_inputs)
  expect n >= 2
  expect list.length(proofs) == n
```

**Quoted Code ([validators/fee_contract.ak:94-110](../../contracts/lovejoin/validators/fee_contract.ak#L94-L110)):**

```aiken
  // Rule 1 — the mix_logic withdraw must use the Mix redeemer. We look up
  // the redeemer by `Withdraw(Script(mix_logic_script_hash))` in
  // `self.redeemers` (a sorted Pairs by ScriptPurpose) and `expect`-cast it
  // to MixLogicRedeemer. If the cast hard-fails (Owner-shape data) the
  // whole script aborts, which is the right "fee_contract rejects this tx"
  // semantics.
  //
  // Hoisted ABOVE the input fold so Owner-redeemer attacker txs (F-1 drain)
  // reject without paying for an `self.inputs` traversal.
  expect Some(mix_logic_redeemer_data) =
    pairs.get_first(
      self.redeemers,
      Withdraw(Script(reference_datum.mix_logic_script_hash)),
    )
  expect mix_logic_redeemer: MixLogicRedeemer = mix_logic_redeemer_data
  expect Mix { .. } = mix_logic_redeemer
```

**What It Is:**
`fee_contract.PayMixFee` requires that the `mix_logic` withdraw redeemer in the same transaction be `Mix { .. }` (the F-1 fix). But the converse coupling does not exist: `mix_logic.validate_mix` accepts a Mix tx whether or not a fee shard is consumed. So a depositor can run a Mix tx that pays no protocol fee at all (only the Cardano network fee).

**Why It Is Bad — Cardano Semantic Cited:**
Cardano's withdraw-zero pattern allows `mix_logic.withdraw` to fire on any tx that includes a 0-lovelace withdrawal at the mix_logic credential. There is no on-chain mechanism that forces a particular spend script to also be present. So the spec's "Mix txs pay a fee" rule is enforced only one-directionally: if you DO consume a fee shard, you must be in a Mix tx; but you can be in a Mix tx without consuming a fee shard.

**Attack Scenario:**
Attacker is a regular depositor running a Mix tx with N=2 of their own boxes (or any other valid Mix shape). They simply omit the fee-shard input from their tx body. The validator chain runs:

- `mix_box.spend` on each input: requires `mix_logic` withdraw ✓
- `mix_logic.withdraw` with `Mix { proofs }`: verifies all proofs, structural rules pass ✓
- No fee-shard input → `fee_contract.spend` never runs.

End-state: protocol does not collect a fee for this Mix tx. The attacker pays only the Cardano network fee.

The question is whether this is **intended** (the spec is genuinely fee-optional) or **unintended** (the spec wants per-Mix fee but missed the enforcement on the mix_logic side). The fee_contract.ak file's drain-attack note ("a user can pay max_fee_per_mix_lovelace while only mixing N=2 inputs") is consistent with both readings.

**Proof / Evidence:**

- Quoted code above (no fee-shard reference in `validate_mix`).
- [attacks/state.md cross-validator gap](../../attacks/state.md#L120) and CWC-023 in [taxonomy.md:121-152](../../taxonomy.md#L121-L152).

**How To Fix:**
If the spec actually requires per-Mix fee:

```aiken
// Inside validate_mix, add:
expect Some(_) =
  list.find(self.inputs, fn(input) {
    is_protocol_input(input, reference_datum.fee_script_hash)  // payment cred only is fine here
  })
```

(Naming: a "fee-input" detection helper that mirrors `input_at_fee` already exists.)

If the spec does not require a per-Mix fee, document the design intent explicitly in `ReferenceDatum` or in the README so that downstream auditors don't re-flag this.

**Tests To Add:**

- Positive (current behavior is "Mix without fee accepted"):
  - [ ] `mix_logic_mix_accepts_tx_without_fee_input` — explicit test of current behavior.
- Negative (if the fix is applied):
  - [ ] `mix_logic_mix_rejects_tx_without_fee_input`.

**Additional Notes:**

- Severity Low because the worst case is "no protocol fee collected" — no principal at risk.
- Status `Needs Verification`: the spec is not in this audit's scope, so the audit cannot confirm intent. Recommend the protocol team explicitly mark this as either "Design Tradeoff" or "Open" after a spec review.

**Knowledge References:**

- [attacks/state.md:120-160](../../attacks/state.md#L120-L160) (Cross-Validator Gap)
- [ctf/bank_04_lifecycle.md:1-136](../../ctf/bank_04_lifecycle.md#L1-L136) (cross-validator coordination)
- [taxonomy.md:121-152](../../taxonomy.md#L121-L152) (CWC-023)

**Tags:** `cross-validator`, `coupling`, `fee-collection`, `withdraw-zero`, `CWC-023`

---

### I-01 `aiken.toml` `version = 0.3.0` ahead of committed `plutus.json` `preamble.version = 0.2.0`

**Severity:** Informational

**Confidence:** Confirmed

**Status:** Open

**CWC ID:** CWC-030 (Code Quality)

**Root Cause:** `build-artifact-stale`

**Component:** Build artifacts.

**Location:**

- [aiken.toml](../../contracts/lovejoin/aiken.toml)
- [plutus.json](../../contracts/lovejoin/plutus.json)

**Quoted Code ([aiken.toml](../../contracts/lovejoin/aiken.toml)):**

```toml
name = "logical-mechanism/lovejoin"
version = "0.3.0"
```

**Quoted Code (`plutus.json` preamble, via `jq -r .preamble.version`):**

```json
"version": "0.2.0"
```

**What It Is:**
The committed `plutus.json` blueprint was emitted from a v0.2.0 source tree; the current `aiken.toml` declares v0.3.0. A re-run of `aiken build` would emit a fresh blueprint at v0.3.0. This is a build-hygiene gap, not a security gap, but it means an integrator who deploys directly from the committed `plutus.json` is deploying an older script than the source advertises.

**Why It Is Bad — Cardano Semantic Cited:**
`plutus.json`'s `preamble.version` is a free-text field copied from `aiken.toml` at build time. It does not affect script semantics, but it is the only way an integrator (or a future audit) can confirm "the blueprint I'm holding matches the source I'm reading." Cardano's deployment model commits a specific script-hash on-chain, derived from the UPLC bytes — if the v0.2.0 and v0.3.0 sources produced byte-identical UPLC, the hash is the same and there's no on-chain divergence; if they produced different UPLC, the deployed script does not match the audited source.

**Attack Scenario:**
None directly. The risk is operational: an integrator might apply parameter substitutions to the stale blueprint, deploy, and end up with a script-hash that doesn't match what the v0.3.0 source would produce. Not exploitable by an external attacker.

**Proof / Evidence:**

```bash
$ awk '/^version/ {print}' contracts/lovejoin/aiken.toml
version = "0.3.0"
$ jq -r .preamble.version contracts/lovejoin/plutus.json
0.2.0
```

**How To Fix:**
Re-run `aiken build` and re-commit `plutus.json`.

**Tests To Add:**

- N/A — this is a build-hygiene check, not a runtime invariant. Optionally add a CI check that `jq -r .preamble.version plutus.json == awk '/^version/ {print $3}' aiken.toml`.

**Additional Notes:**

- Compiler versions match (`aiken.toml: v1.1.21` vs `plutus.json: v1.1.21+42babe5`; the suffix is the commit short hash).
- This is the auto-finding emitted by Phase 0 of the audit prompt.

**Knowledge References:**

- [taxonomy.md:121-152](../../taxonomy.md#L121-L152) (CWC-030)

**Tags:** `build-hygiene`, `versioning`, `plutus.json`, `CWC-030`

---

### I-02 Insufficient `bench` coverage for hot-path redeemers

**Severity:** Informational

**Confidence:** Confirmed

**Status:** Open

**CWC ID:** CWC-030

**Root Cause:** `bench-coverage-missing`

**Component:** All validators.

**Location:**

- Repository-wide: zero `^bench\s+` declarations in `*.ak` files (verified via `grep -rE "^bench\s+" --include="*.ak" .` → 0 matches outside `build/`).

**Quoted Code:**
N/A — the finding is the absence of `bench` blocks across the entire codebase. The grep evidence above is the primary artefact.

**What It Is:**
Lovejoin's hot paths are cryptography-heavy (per-input sigma-OR verification on N inputs, each with N branches; per-input Schnorr verification on N inputs; `bls12_381_g1_uncompress` is the dominant per-op cost) and the codebase shows extensive optimization commentary (single-walk prologue, denom_value_bytes caching, `precompute_statements`, `header_const_prefix` reuse). Yet there is no Aiken `bench` block anywhere in the repository to anchor those optimization claims with measured CPU/mem numbers.

**Why It Is Bad — Cardano Semantic Cited:**
Cardano's per-tx CPU/mem budget is the ultimate ceiling on the Mix branch's `N`. Without baseline benchmarks, the claim "we can support N=k mix inputs" is unverified, and any future change to the validator (or the stdlib it imports) cannot be evaluated for performance regression.

**Attack Scenario:**
None directly. The risk is operational: a future optimization (or de-optimization) lands without measurement, and Mainnet Mix txs at the documented N start failing for budget reasons.

**Proof / Evidence:**

```bash
$ grep -rE "^bench\s+" --include="*.ak" contracts/lovejoin/ | grep -v "/build/" | wc -l
0
```

**How To Fix:**
Add `bench` blocks for each redeemer × scenario. Per-redeemer-constructor coverage table (see §17 for the source-of-truth):

- Benchmark
  - [ ] `bench mix_logic__owner__low_n` (N=1)
  - [ ] `bench mix_logic__owner__mid_n` (N=4, typical bulk withdraw)
  - [ ] `bench mix_logic__owner__high_n` (N=10 or whatever the empirical ceiling is)
  - [ ] `bench mix_logic__mix__low_n` (N=2)
  - [ ] `bench mix_logic__mix__mid_n` (N=4)
  - [ ] `bench mix_logic__mix__high_n` (N=8 or empirical max)
  - [ ] `bench mix_logic__mix__worst_case_datum_size` — synthetic where every output datum is at the max byte length the validator accepts
  - [ ] `bench fee_contract__pay_mix_fee` (single scenario; cold path)
  - [ ] `bench fee_contract__replenish` (single scenario; cold path)
  - [ ] `bench mix_box__spend_well_formed` (cold path; one bench)
  - [ ] `bench one_shot_mint__mint` (cold path; one bench)

Use realistic transaction shapes — real input counts including wallet/change inputs, real native-asset counts on the user's wallet inputs (the validator doesn't read those, but the per-input Cardano fixed cost still scales with input count).

**Tests To Add:**

- See benchmark checklist above.

**Additional Notes:**

- The codebase's optimization comments cite specific savings ("saves N²−N uncompressions per tx", "saves 2N+N concats per Mix tx") — anchor each one with a before/after bench measurement so future regressions are detectable.
- This finding is the aggregate per the Phase 7b rule: every "No" in the §17 per-redeemer-constructor `Bench?` column is one checkbox here.

**Knowledge References:**

- [optimizations/aiken_optimization_guide.md](../../optimizations/aiken_optimization_guide.md) #1 (Benchmark first)
- [taxonomy.md:121-152](../../taxonomy.md#L121-L152) (CWC-030)

**Tags:** `benchmarks`, `hot-path`, `optimization-anchor`, `CWC-030`

---

### I-03 Test fixtures cannot construct adversarial `stake_credential` variants

**Severity:** Informational

**Confidence:** Confirmed

**Status:** Open

**CWC ID:** CWC-030

**Root Cause:** `fixture-stuck-at-default`

**Component:** Test fixture module.

**Location:**

- [lib/lovejoin/test_fixtures.ak:96-102](../../contracts/lovejoin/lib/lovejoin/test_fixtures.ak#L96-L102)

**Quoted Code ([lib/lovejoin/test_fixtures.ak:96-102](../../contracts/lovejoin/lib/lovejoin/test_fixtures.ak#L96-L102)):**

```aiken
pub fn script_address(hash: ByteArray) -> Address {
  Address { payment_credential: Script(hash), stake_credential: None }
}

pub fn vk_address(hash: ByteArray) -> Address {
  Address { payment_credential: VerificationKey(hash), stake_credential: None }
}
```

**What It Is:**
Every fixture in the test suite that constructs an `Address` does so with `stake_credential: None`. There is no fixture variant for `Some(Inline(VerificationKey(_)))`, `Some(Inline(Script(_)))`, or `Some(Pointer(_))`. As a direct consequence, no negative test in the entire suite (1,440 declarations, 257 `fail`-tests) can detect a stake-credential-hijack bug — even if a test author wanted to write the H-01 negative test, they would have to extend `test_fixtures.ak` first.

**Why It Is Bad — Cardano Semantic Cited:**
Test coverage's adversarial reach is upper-bounded by the shapes the fixture builders can produce. A fixture that hardcodes `stake_credential: None` makes the H-01 finding undetectable by the test suite even after the bug is reported. This is a meta-coverage gap — the test suite is well-structured for what it can express, but the fixture vocabulary is too narrow.

**Attack Scenario:**
N/A — this is a coverage gap, not an exploit. It pairs with H-01.

**Proof / Evidence:**

```bash
$ grep -nE "stake_credential\s*:\s*[A-Z]" --include="*.ak" -r contracts/lovejoin/ | grep -v "/build/"
contracts/lovejoin/validators/mix_box.test.ak:59:        stake_credential: None,
contracts/lovejoin/lib/lovejoin/test_fixtures.ak:97:  Address { payment_credential: Script(hash), stake_credential: None }
contracts/lovejoin/lib/lovejoin/test_fixtures.ak:101:  Address { payment_credential: VerificationKey(hash), stake_credential: None }
# Every match is `None`. No `Some(...)` anywhere outside stdlib fixtures.
```

**How To Fix:**
Extend `test_fixtures.ak` with variants:

```aiken
pub fn script_address_with_stake_vk(script_hash: ByteArray, vk: ByteArray) -> Address {
  Address {
    payment_credential: Script(script_hash),
    stake_credential: Some(Inline(VerificationKey(vk))),
  }
}

pub fn script_address_with_stake_script(script_hash: ByteArray, stake_hash: ByteArray) -> Address {
  Address {
    payment_credential: Script(script_hash),
    stake_credential: Some(Inline(Script(stake_hash))),
  }
}
```

Then add the H-01 negative tests using those builders.

**Tests To Add:**

- See H-01 Tests To Add section.

**Additional Notes:**

- This is the variance row "Address.stake_credential: all None → Informational finding" from Phase 7c.

**Knowledge References:**

- [test_patterns.md](../../test_patterns.md) (test coverage methodology)
- [taxonomy.md:121-152](../../taxonomy.md#L121-L152) (CWC-030)

**Tags:** `test-fixture`, `coverage-gap`, `stake-credential`, `CWC-030`

---

### I-04 Test fixtures never attach a `reference_script` to a continuing output

**Severity:** Informational

**Confidence:** Confirmed

**Status:** Open

**CWC ID:** CWC-030

**Root Cause:** `fixture-stuck-at-default`

**Component:** Test fixture module.

**Location:**

- [lib/lovejoin/test_fixtures.ak:115-247](../../contracts/lovejoin/lib/lovejoin/test_fixtures.ak#L115-L247) (every fixture builder hardcodes `reference_script: None`)

**Quoted Code (representative — [lib/lovejoin/test_fixtures.ak:160-169](../../contracts/lovejoin/lib/lovejoin/test_fixtures.ak#L160-L169)):**

```aiken
pub fn mix_box_output(a: ByteArray, b: ByteArray, lovelace: Int) -> Output {
  let datum: Data = MixDatum { a, b }
  Output {
    address: script_address(mix_script_hash),
    value: assets.from_lovelace(lovelace),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}
```

**What It Is:**
Every output fixture (mix*box, fee_shard, vk_output_lovelace, reference_input) hardcodes `reference_script: None`. No test in the suite constructs a continuing output with `reference_script: Some(*)`. As a result, the M-01 negative test cannot exist without first extending the fixture vocabulary.

**Why It Is Bad — Cardano Semantic Cited:**
Same meta-coverage shape as I-03. The validator sees `Output { address, value, datum, reference_script }` and the spec's check-list calls for asserting `reference_script == None` on every continuing output (§5 of the audit checklist), but the test suite cannot exercise this assertion in either direction.

**Attack Scenario:**
N/A — pairs with M-01.

**Proof / Evidence:**

```bash
$ grep -nE "reference_script\s*:\s*[A-Z]" --include="*.ak" -r contracts/lovejoin/ | grep -v "/build/"
# Every match is `None`. Zero `Some(_)` matches.
```

**How To Fix:**
Add a variant builder:

```aiken
pub fn mix_box_output_with_ref_script(
  a: ByteArray, b: ByteArray, lovelace: Int, ref_script_hash: ByteArray,
) -> Output {
  let datum: Data = MixDatum { a, b }
  Output {
    address: script_address(mix_script_hash),
    value: assets.from_lovelace(lovelace),
    datum: InlineDatum(datum),
    reference_script: Some(ref_script_hash),
  }
}
```

Then add the M-01 negative tests.

**Tests To Add:**

- See M-01 Tests To Add section.

**Additional Notes:**

- Variance row "Output.reference_script: all None → Informational finding" from Phase 7c.

**Knowledge References:**

- [test_patterns.md](../../test_patterns.md)
- [taxonomy.md:121-152](../../taxonomy.md#L121-L152) (CWC-030)

**Tags:** `test-fixture`, `coverage-gap`, `reference-script`, `CWC-030`

---

### I-05 `lovejoin/dhtuple.ak` is unused by validators (kept as parity anchor for KAT tests)

**Severity:** Informational

**Confidence:** Confirmed

**Status:** Design Tradeoff

**CWC ID:** CWC-027 (Dead Code)

**Root Cause:** `crypto-parity-anchor`

**Component:** `lib/lovejoin/dhtuple.ak`.

**Location:**

- [lib/lovejoin/dhtuple.ak:1-47](../../contracts/lovejoin/lib/lovejoin/dhtuple.ak#L1-L47)
- Referenced only by [lib/lovejoin/dhtuple_kat.test.ak](../../contracts/lovejoin/lib/lovejoin/dhtuple_kat.test.ak) and [lib/lovejoin/encoding_parity_kat.test.ak](../../contracts/lovejoin/lib/lovejoin/encoding_parity_kat.test.ak).

**Quoted Code ([lib/lovejoin/dhtuple.ak:1-21](../../contracts/lovejoin/lib/lovejoin/dhtuple.ak#L1-L21)):**

```aiken
//// proveDHTuple verifier.
////
//// Spec: §"proveDHTuple".
////
//// Statement: prover knows `x ∈ Z_r` such that `u = [x]·g` AND `v = [x]·h`.
//// In Mix branch terms: g=a, h=b, u=a', v=b'. Verifier accepts iff
////   [z]·g == t0 + [c]·u  AND  [z]·h == t1 + [c]·v
//// with c = H(g, h, u, v, t0, t1, ctx) mod r.
```

**What It Is:**
`lovejoin/dhtuple.ak` provides a standalone DH-tuple verifier (`dhtuple.verify`). No production validator imports it; only KAT and encoding-parity tests do. The Mix branch is implemented via the N-way sigma-OR verifier (`lovejoin/sigma_or.ak`), which inlines the DH-tuple equations rather than calling `dhtuple.verify`. So the module is a reference / parity anchor: if the SDK's prover ever changes its DH-tuple FS preimage layout, the parity tests will fail and this module's expectations document what the canonical layout should be.

**Why It Is Bad — Cardano Semantic Cited:**
This is not bad — it is a documented design choice. The note is here so a future auditor doesn't re-flag it as dead code. The module ships in `plutus.json`'s blueprint dependency graph but is not part of any compiled validator's UPLC (unused functions are tree-shaken).

**Attack Scenario:**
N/A.

**Proof / Evidence:**

```bash
$ grep -rn "dhtuple\|DHTupleProof" --include="*.ak" contracts/lovejoin/ | grep -v "/build/"
contracts/lovejoin/lib/lovejoin/dhtuple.ak:16:pub type DHTupleProof {
contracts/lovejoin/lib/lovejoin/dhtuple.ak:27:  proof: DHTupleProof,
contracts/lovejoin/lib/lovejoin/encoding_parity_kat.test.ak:50:test parity_dhtuple_0() {
# ... only test files use it.
```

**How To Fix:**
No change recommended. Optionally add a one-line comment at the top of `dhtuple.ak`: `//// NOTE: Validators do not import this module — it is a parity anchor for the SDK's prover. See encoding_parity_kat.test.ak.`

**Tests To Add:**
None — existing parity tests are the load-bearing usage.

**Additional Notes:**

- Dead-code findings on parity anchors should be marked `Design Tradeoff`, not `Open`. The cost is module-source-size (47 lines); the benefit is a checked invariant on FS preimage layout.

**Knowledge References:**

- [taxonomy.md:121-152](../../taxonomy.md#L121-L152) (CWC-027)

**Tags:** `dead-code`, `parity-anchor`, `crypto-spec`, `CWC-027`

---

### O-01 `validate_replenish` uses `list.count` on `tx.inputs` without early-exit

**Severity:** Optimization

**Confidence:** Suspected

**Status:** Optimization Opportunity

**CWC ID:** CWC-016 (Resource Exhaustion / cost-driver)

**Root Cause:** `stdlib-redflag-list-count`

**Component:** `fee_contract.validate_replenish`.

**Location:**

- [validators/fee_contract.ak:172-174](../../contracts/lovejoin/validators/fee_contract.ak#L172-L174)

**Quoted Code ([validators/fee_contract.ak:171-175](../../contracts/lovejoin/validators/fee_contract.ak#L171-L175)):**

```aiken
) -> Bool {
  let fee_input_count =
    self.inputs |> list.count(fn(input) { input_at_fee(input, own_hash) })
  expect fee_input_count == 1
```

**What It Is:**
`list.count` walks every input in `tx.inputs`, applying the predicate. The check is "exactly one fee-script input." A single-pass fold with early-exit at `count > 1` would short-circuit on the first violation; for the happy path (1 fee input + a few wallet inputs) the cost difference is negligible, but for adversarial txs with many inputs the savings scale linearly.

**Why It Is Bad — Cardano Semantic Cited:**
Per [optimizations/stdlib_red_flags.md](../../optimizations/stdlib_red_flags.md), `list.count` is a flagged helper. The acceptable case is "predicate cheap, N small". `input_at_fee` is cheap (one pattern-match), and Replenish is a cold path (called rarely), so the impact is small. The fix is the same shape as `validate_pay_mix_fee`'s single-pass fold (already done in fee_contract.ak:120-143).

**Attack Scenario:**
None directly. The cost of replacing this is small (10-20 lines), and the gain is "cleaner pattern + slightly cheaper validation on griefing-shaped txs."

**Proof / Evidence:**

- Quoted code above.
- Compare against the optimized PayMixFee fold (fee_contract.ak:120-143) for the canonical replacement pattern.

**How To Fix:**

```aiken
fn validate_replenish(
  self: Transaction,
  own_input: Input,
  own_hash: ScriptHash,
) -> Bool {
  // Single-pass fold mirroring validate_pay_mix_fee. Counts fee inputs;
  // bails out as soon as count exceeds 1. Returns the count for the
  // expect == 1 below.
  let fee_input_count =
    list.foldl(
      self.inputs,
      0,
      fn(input, acc) {
        if input_at_fee(input, own_hash) {
          acc + 1
        } else {
          acc
        }
      },
    )
  expect fee_input_count == 1
  // ... rest unchanged
}
```

(Aiken's `list.foldl` does not natively short-circuit; for true early-exit you'd need a manual recursion. Given the cold-path nature, a custom recursion is over-engineering. The straightforward `list.foldl` already eliminates one allocation level over `list.count`.)

**Tests To Add:**

- Benchmark
  - [ ] `bench fee_contract__replenish__many_inputs` — measure CPU/mem before and after the fold rewrite.

**Additional Notes:**

- **No baseline benchmark exists** (see I-02), so this finding's "Risk: low; benchmark before/after required" is an absolute requirement, not a suggestion.
- This is the only Optimization finding worth surfacing — the rest of the codebase is already heavily optimized (denom_value_bytes caching, header_const_prefix reuse, precompute_statements lift, single-walk prologue). Optimization findings on already-optimized code without a baseline benchmark are noise.

**Expected Benefit:** small constant-factor improvement on Replenish-with-many-inputs txs; negligible on the typical happy path (1 fee + 1-2 wallet inputs).

**Risk:** Low; benchmark before/after required.

**Knowledge References:**

- [optimizations/stdlib_red_flags.md](../../optimizations/stdlib_red_flags.md) (`list.count` row)
- [optimizations/aiken_optimization_guide.md](../../optimizations/aiken_optimization_guide.md) #21 (don't re-traverse), #14 (build local caches)
- [taxonomy.md:121-152](../../taxonomy.md#L121-L152) (CWC-016)

**Tags:** `optimization`, `list.count`, `fold`, `CWC-016`, `cold-path`

---

## 9. Hyperstructure Review

### hs-01 `reference_holder.spend` always-False

**Location:** [validators/reference_holder.ak:24-30](../../contracts/lovejoin/validators/reference_holder.ak#L24-L30)

**Classification:** Safe and intentional

**What It Allows:** Nothing — the validator returns False unconditionally, so the reference UTxO at this script can never be spent. It is consumed only as `tx.reference_inputs`, which Cardano reads without running the validator.

**Constraints That Must Hold (4-criteria check):**

- Liveness purpose: yes — the path enables hyperstructure-style permanence (the protocol parameters cannot be changed because the UTxO holding them cannot be spent).
- Dust-bounded: yes by construction — no spend means no value can ever be moved.
- Documented (code + user-facing): yes ([validators/reference_holder.ak:1-19](../../contracts/lovejoin/validators/reference_holder.ak#L1-L19) carries a 19-line module-docstring; the README also describes the reference UTxO).
- Test exists for non-stale UTxO: implicit — the always-False return is its own test (the spend handler unconditionally rejects).

**Test Coverage:** [validators/reference_holder.test.ak](../../contracts/lovejoin/validators/reference_holder.test.ak) (53 lines).

**Documentation:** Strong inline + README mention.

**Recommendation:** Accept-as-is.

---

### hs-02 `mix_box.spend` Rule-2 recovery on non-well-formed inline datum (`None -> True`)

**Location:** [validators/mix_box.ak:62-65](../../contracts/lovejoin/validators/mix_box.ak#L62-L65)

**Classification:** Safe and intentional

**What It Allows:** Anyone may sweep a UTxO at the `mix_box` script whose inline datum decodes via `try_decode_well_formed_data` as `None` — i.e., the datum is `Constr 0 [a, b]` but `length(a) ≠ 48` or `length(b) ≠ 48` or `a == b`, or the constructor index is non-zero, or the field types are wrong.

**Constraints That Must Hold (4-criteria check):**

- Liveness purpose: yes — the path enables anyone to recover UTxOs accidentally parked at the mix script with malformed datums (e.g. a depositor mistypes the BLS encoding).
- Dust-bounded: not strictly bounded by the validator (any value can sit at the mix script with a malformed datum), but the loss is the depositor's accidental loss; an attacker cannot induce someone else's UTxO to land here without that party's consent.
- Documented (code + user-facing): yes ([validators/mix_box.ak:13-15](../../contracts/lovejoin/validators/mix_box.ak#L13-L15) "Otherwise — datum is missing, hash-stored, or doesn't decode to the expected shape — return True"; spec §0 Rule 2 referenced).
- Test exists for non-stale UTxO not swept: yes ([validators/mix_box.test.ak](../../contracts/lovejoin/validators/mix_box.test.ak) F-2 regression block tests cover well-formed inline → must NOT pass without withdraw).

**Test Coverage:** Strong (mix_box.test.ak, including F-2 regression KAT).

**Documentation:** Strong inline + spec.

**Recommendation:** Accept-as-is.

---

### hs-03 `mix_box.spend` Rule-2 recovery on `NoDatum` / `DatumHash(_)` (`_ -> True`)

**Location:** [validators/mix_box.ak:66-68](../../contracts/lovejoin/validators/mix_box.ak#L66-L68)

**Classification:** Safe and intentional

**What It Allows:** Anyone may sweep a UTxO at the `mix_box` script whose datum is `NoDatum` or `DatumHash(_)` (regardless of whether the hash's preimage is in `tx.datums`).

**Constraints That Must Hold (4-criteria check):**

- Liveness purpose: yes — same as hs-02 but for the cases where the inline-datum check fails earlier.
- Dust-bounded: same as hs-02.
- Documented (code + user-facing): yes — `// NoDatum or DatumHash(_): not part of the privacy pool. Recovery.` ([validators/mix_box.ak:66](../../contracts/lovejoin/validators/mix_box.ak#L66)).
- Test exists for non-stale UTxO not swept: yes — F-2 regression tests include the `DatumHash` case explicitly.

**Test Coverage:** Strong; F-2 closes the asymmetry between `mix_box`'s Option<Data> view and `mix_logic`'s typed-Datum view.

**Documentation:** Strong.

**Recommendation:** Accept-as-is.

---

### hs-04 `fee_contract.spend` Rule-2 recovery on non-unit datum (`!is_unit_optional → True`)

**Location:** [validators/fee_contract.ak:52-54](../../contracts/lovejoin/validators/fee_contract.ak#L52-L54)

**Classification:** Safe and intentional

**What It Allows:** Anyone may sweep a UTxO at the `fee_contract` script whose datum is not `Some(Constr 0 [])` — i.e., not the unit `()` constructor.

**Constraints That Must Hold (4-criteria check):**

- Liveness purpose: yes — recovery for accidentally-parked UTxOs.
- Dust-bounded: same shape as hs-02/03; loss bound is whatever someone accidentally parked.
- Documented (code + user-facing): yes ([validators/fee_contract.ak:15-17](../../contracts/lovejoin/validators/fee_contract.ak#L15-L17)).
- Test exists for non-stale UTxO not swept: yes ([validators/fee_contract.test.ak](../../contracts/lovejoin/validators/fee_contract.test.ak) covers the unit-datum required path for both PayMixFee and Replenish).

**Test Coverage:** Strong.

**Documentation:** Strong.

**Recommendation:** Accept-as-is.

---

### Other always-true / always-false branches (NOT hyperstructure paths)

The following matches from `grep -nE "_ -> True|_ -> False"` are catch-all `_ -> False` (deny-by-default; good style — not findings) or `_ -> True` inside helpers operating on validated subjects:

- [validators/mix_logic.ak:68](../../contracts/lovejoin/validators/mix_logic.ak#L68) — `_ -> False` for non-`RegisterCredential` certificates. **Deny-by-default; intentional; F-5 fix.**
- [validators/mix_logic.ak:344](../../contracts/lovejoin/validators/mix_logic.ak#L344) — `_ -> False` in `pairs_match_and_all` length-mismatch arm. **Deny-by-default.**
- [lib/lovejoin/mixbox.ak:30](../../contracts/lovejoin/lib/lovejoin/mixbox.ak#L30) — `_ -> False` in `output_at_script` non-script-credential arm. **Deny-by-default.**
- [lib/lovejoin/fee.ak:26,36](../../contracts/lovejoin/lib/lovejoin/fee.ak#L26) — `_ -> False` in `output_at_fee` and `is_unit_inline_datum`. **Deny-by-default.**
- [lib/lovejoin/value.ak:22](../../contracts/lovejoin/lib/lovejoin/value.ak#L22) — `_ -> False` in `ada_only`. **Deny-by-default.**
- [lib/lovejoin/sigma_or.ak:220](../../contracts/lovejoin/lib/lovejoin/sigma_or.ak#L220) — `_ -> False` in `parallel_all` length-mismatch arm. **Deny-by-default.**

All catalogued in §19 Dead Ends.

---

## 10. Singleton & Twin UTxO Analysis

| Singleton Assumption                                                                                      | Where Asserted                                                                                                                                                               | Auth Anchor                                                                                                                         | Verdict                                                                                                   |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Reference UTxO holding `(one_shot_mint_policy, "lovejoin")` is unique                                     | [lib/lovejoin/reference.ak:30](../../contracts/lovejoin/lib/lovejoin/reference.ak#L30) — `expect [Input { output, .. }] = carriers`                                          | One-shot mint policy ([validators/one_shot_mint.ak](../../contracts/lovejoin/validators/one_shot_mint.ak)) makes the NFT one-of-one | Enforced. If two carriers exist (impossible post-bootstrap given the one-shot policy), the script aborts. |
| Each Mix tx has exactly N continuing mix-script outputs (N-prefix) and the rest must NOT be at mix-script | [validators/mix_logic.ak:251-303](../../contracts/lovejoin/validators/mix_logic.ak#L251-L303) — `walk_outputs` asserts `prefix_remaining == 0` at end-of-list                | n/a (per-tx invariant)                                                                                                              | Enforced via single-walk.                                                                                 |
| Each PayMixFee tx has exactly 1 fee-script input and exactly 1 fee-script output                          | [validators/fee_contract.ak:120-150](../../contracts/lovejoin/validators/fee_contract.ak#L120-L150) — fold counts inputs to == 1; filter + `expect [fee_output]` for outputs | n/a (per-tx invariant)                                                                                                              | Enforced.                                                                                                 |
| Each Replenish tx has exactly 1 fee-script input and exactly 1 fee-script output                          | [validators/fee_contract.ak:172-178](../../contracts/lovejoin/validators/fee_contract.ak#L172-L178)                                                                          | n/a (per-tx invariant)                                                                                                              | Enforced via `list.count == 1` (see O-01 for an optimization note).                                       |
| 10 fee shards exist at the fee script (off-chain assertion)                                               | NOT enforced on chain                                                                                                                                                        | n/a                                                                                                                                 | **Not enforced** — see L-03.                                                                              |

No "twin protocol UTxO" risk on the reference-NFT side (one-shot policy + post-mint singleton enforcement). The fee shards are not singletons by design; per-tx coupling enforces "exactly one in this tx." Mix-boxes are not singletons by design.

---

## 11. Lifecycle / UTxO-Creation Analysis

| Validator                                                                   | Creation Path                                                             | Enforces Initial Invariant?                                                                                                              | Enforcer (on-chain / off-chain / both)            | Finding ID                                         |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------- |
| `reference_holder`                                                          | bootstrap tx (consumes seed UTxO, mints NFT, creates ref UTxO)            | partial — one_shot_mint asserts (seed consumed, name=`"lovejoin"`, qty=1) but NOT destination or datum content                           | both — mint policy + off-chain bootstrap pipeline | L-01, L-02                                         |
| `one_shot_mint` (token creation)                                            | same bootstrap tx                                                         | yes — one_shot_mint mint policy enforces seed-consumption + name + quantity                                                              | on-chain (mint policy)                            | (no finding — handled by one_shot_mint itself)     |
| `mix_box` UTxOs                                                             | depositor's wallet creates an output at mix-script with inline `MixDatum` | NO — depositor can create a mix-script UTxO with any datum (including malformed). The protocol relies on Rule-2 recovery to handle that. | off-chain (depositor's wallet)                    | (intentional Rule-2 hyperstructure; not a finding) |
| `fee_contract` UTxOs                                                        | bootstrap tx creates 10 shards                                            | NO — count is not enforced on chain                                                                                                      | off-chain bootstrap pipeline                      | L-03                                               |
| `mix_logic` (no UTxOs at this script — it's a withdraw + publish validator) | n/a                                                                       | n/a                                                                                                                                      | n/a                                               | n/a                                                |

---

## 12. Mint ↔ Spend Coupling Matrix

| Policy          | Asset                     | Action  | Spend Validator | Redeemer                        | Coupling Enforcement                                                                                                                                                                                                                                                    |
| --------------- | ------------------------- | ------- | --------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `one_shot_mint` | `(policy_id, "lovejoin")` | mint +1 | none required   | mint redeemer (`Data`, ignored) | One-shot policy: requires seed UTxO consumption; can fire only once. No spend validator coupling needed because the policy is single-use and the seed UTxO's spend validator (whatever it is at bootstrap — typically a depositor's wallet) provides the authorization. |
| `one_shot_mint` | `(policy_id, "lovejoin")` | burn -1 | n/a             | n/a                             | Pattern-match `expect [Pair(asset_name, quantity)]` + `quantity == 1` rejects `quantity == -1` (the dict entry would be `Pair(_, -1)` which still matches the pattern but fails `quantity == 1`). So the NFT cannot be burned via this policy.                          |

Verdict: coupling is correct — the one-shot is intentionally not coupled to a spend validator (the seed-consumption check is the coupling). No `bank_06_free_mint`-style cross-validator path because there is only one mint policy and the `RegisterCredential` cert is not a mint.

---

## 13. Replay / Off-Chain Signature Analysis

**Ed25519 cheques: not applicable.** Lovejoin uses no `verify_ed25519_signature` calls in production. The protocol's "signatures" are sigma-protocol proofs (Schnorr and N-way sigma-OR over BLS12-381 G1).

**Cryptographic-context audit (Phase 5g) — analysed in §15.**

---

## 14. Cross-Validator Coherence

| Coupling                                                                   | Direction                    | On-Chain Enforcement                                                                                                                                                                                                                             | Status                                                                                                                                                                                                            |
| -------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mix_box.spend` ↔ `mix_logic.withdraw`                                     | `mix_box` → `mix_logic`      | `mix_box` requires `pairs.has_key(self.withdrawals, mix_logic_credential)` ([validators/mix_box.ak:60-61](../../contracts/lovejoin/validators/mix_box.ak#L60-L61)).                                                                              | Both fire together for well-formed mix-boxes. Bidirectional in spirit (mix_logic's withdraw is meaningless without a mix_box input to actually consume), even though the on-chain assertion is one-directional. ✓ |
| `fee_contract.PayMixFee` ↔ `mix_logic.withdraw(Mix)`                       | `fee_contract` → `mix_logic` | `fee_contract.validate_pay_mix_fee` looks up `Withdraw(Script(mix_logic_script_hash))` in `self.redeemers` and asserts it is `Mix { .. }` ([validators/fee_contract.ak:103-109](../../contracts/lovejoin/validators/fee_contract.ak#L103-L109)). | One-directional (Fee → Mix yes; Mix → Fee NO). See L-04.                                                                                                                                                          |
| `mix_logic.publish(RegisterCredential)`                                    | one-time at bootstrap        | `mix_logic.publish` accepts only `RegisterCredential` ([validators/mix_logic.ak:65-70](../../contracts/lovejoin/validators/mix_logic.ak#L65-L70)).                                                                                               | One-time event at bootstrap; subsequent re-registration would fail Cardano's per-credential uniqueness. ✓                                                                                                         |
| `reference_holder` ← `reference_inputs` (read by mix_logic + fee_contract) | one-directional read         | `read_reference_datum` asserts singleton carrier + InlineDatum + ReferenceDatum shape ([lib/lovejoin/reference.ak:21-34](../../contracts/lovejoin/lib/lovejoin/reference.ak#L21-L34)).                                                           | reference UTxO is permanently locked at always-False, so the auth anchor cannot be modified. ✓                                                                                                                    |
| `one_shot_mint` ↔ destination of the minted NFT                            | one-directional, one-time    | NOT enforced — see L-01.                                                                                                                                                                                                                         | Off-chain enforced.                                                                                                                                                                                               |

---

## 15. Oracle Authentication & Freshness

**Not applicable.** Lovejoin has no oracle dependency. The reference UTxO at `reference_holder` is the closest analog (a "config oracle" in a loose sense), but it is internally authenticated by the protocol's own one-shot NFT (no external feed) and is permanently immutable post-bootstrap (always-False spend). No `validity_range` checks exist anywhere in the production code, because no time-sensitive logic exists.

### 15.x Cryptographic Context Audit (Phase 5g)

| File:line                                                                          | Verifier | Domain Tag                 | Statement ID                         | FS Preimage Components                                          | Bound to Inputs?                 | Bound to Outputs?                                                                                        | Bound to OutputRefs?                                                         | Bound to Mint?                  | Bound to Validity Range?      | Bound to Signer/Owner?                   | Notes                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------- | -------- | -------------------------- | ------------------------------------ | --------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------- | ----------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [schnorr.ak:40-44](../../contracts/lovejoin/lib/lovejoin/schnorr.ak#L40-L44)       | Schnorr  | `"lovejoin/sigmajoin/v1/"` | `0x01` (statement_id_prove_dlog)     | `DOMAIN ‖ 0x01 ‖ base ‖ u ‖ t ‖ ctx`                            | yes (input.a, input.b → base, u) | yes (Owner ctx = serialise(self.outputs))                                                                | YES (Owner ctx includes serialise(self.inputs[].output_reference) — F-4 fix) | n/a (Owner does not gate mints) | n/a (no time-sensitive logic) | n/a (knowledge of `x` is the credential) | Owner branch only. F-4 closes input-ref binding.                                                                                                                                                               |
| [sigma_or.ak:154-168](../../contracts/lovejoin/lib/lovejoin/sigma_or.ak#L154-L168) | Sigma-OR | `"lovejoin/sigmajoin/v1/"` | `0x03` (statement_id_sigma_or_n)     | `DOMAIN ‖ 0x03 ‖ N(1B) ‖ a ‖ b ‖ (ap, bp)×N ‖ (t0, t1)×N ‖ ctx` | yes (input.a, input.b in header) | yes (statements are output (a',b'); ctx = serialise(output.datum) ‖ denom_value_bytes ‖ mix_script_hash) | NO (Mix ctx omits input_refs — see Notes)                                    | n/a                             | n/a                           | n/a (knowledge of `x` is the credential) | Mix branch. Per-input proof binds (input.(a,b), statements, ctx) — replay vector is "duplicate-(a,b) inputs" but irrational for attacker (see §19 dead-ends entry "Mix-branch FS-context input-ref omission"). |
| [dhtuple.ak:38-46](../../contracts/lovejoin/lib/lovejoin/dhtuple.ak#L38-L46)       | DH-tuple | `"lovejoin/sigmajoin/v1/"` | `0x02` (statement_id_prove_dh_tuple) | `DOMAIN ‖ 0x02 ‖ g ‖ h ‖ u ‖ v ‖ t0 ‖ t1 ‖ ctx`                 | n/a (helper)                     | n/a (helper)                                                                                             | n/a (helper)                                                                 | n/a                             | n/a                           | n/a                                      | Module unused by validators (I-05).                                                                                                                                                                            |

Decision-rule findings:

- **Domain tag present:** yes (`"lovejoin/sigmajoin/v1/"`); pinned in [hash.ak:15](../../contracts/lovejoin/lib/lovejoin/hash.ak#L15). ✓
- **Statement ID disambiguator present:** yes (1-byte type tag: 0x01 / 0x02 / 0x03). ✓
- **Output-set bound:** yes for both Owner and Mix. ✓
- **Input-ref bound for Owner:** yes (post-F-4). ✓
- **Input-ref bound for Mix:** no. **Suspected** but **not exploitable** (see §19 dead-ends). Severity: Informational. No finding row produced — documented as a near-miss.
- **Mint-set bound:** n/a (proofs do not gate mints).
- **Validity-range bound:** n/a (no time-sensitive logic).
- **Owner-binding (per-principal):** the proof IS the credential; no separate signer.

XOR fold (sigma-OR): commutativity is acceptable here because each input's proof is bound to that input's specific (a, b) via the FS preimage's per-input header. Permuting branches in the proof would change `c_global` (since c_global = blake2b_256 over an order-sensitive byte concatenation), so an attacker cannot reorder branches to match a permuted statement set without invalidating the hash. ✓

Pre-computation lifts (`precompute_statements`, `header_const_prefix`): verified byte-equivalent — see [encoding_parity_kat.test.ak](../../contracts/lovejoin/lib/lovejoin/encoding_parity_kat.test.ak) and [value_serialise_parity.test.ak](../../contracts/lovejoin/lib/lovejoin/value_serialise_parity.test.ak). The lifts move work outside the per-input loop without changing FS preimage bytes. ✓

---

## 16. Optimization Review

**Baseline benchmarks: NO (`bench` count = 0 repository-wide). Every optimization claim in this section must say "no baseline; benchmark before/after required." (See I-02.)**

The codebase is already heavily optimized — the source carries extensive inline commentary about specific optimizations applied:

- Single-walk `walk_outputs` in `validate_mix` ([mix_logic.ak:251-303](../../contracts/lovejoin/validators/mix_logic.ak#L251-L303)) subsumes 8 prior traversals (`list.take`, `list.drop`, two `list.all`s, `list.map(decode)`, two folds, `precompute_statements` lift).
- `denom_value_bytes` cache ([mix_logic.ak:183-184](../../contracts/lovejoin/validators/mix_logic.ak#L183-L184)) saves N−1 `serialise_data(output.value)` calls per Mix tx by exploiting that all prefix outputs are forced to the same denom.
- `header_const_prefix` precompute ([mix_logic.ak:211, hash.ak:93-98](../../contracts/lovejoin/validators/mix_logic.ak#L211)) saves N `from_int_big_endian` + 2N concats per Mix tx.
- `precompute_statements` ([sigma_or.ak:59-73](../../contracts/lovejoin/lib/lovejoin/sigma_or.ak#L59-L73)) lifts the N×N `bls12_381_g1_uncompress` cost to N — the single biggest knob for raising the Mix tx N ceiling.
- Single-pass fold in `validate_pay_mix_fee` ([fee_contract.ak:120-143](../../contracts/lovejoin/validators/fee_contract.ak#L120-L143)) replaces 4 prior traversals (find own_input, defense-in-depth credential check, mix-input count, fee-input count).
- `expect_ada_only_lovelace` ([value.ak:45-52](../../contracts/lovejoin/lib/lovejoin/value.ak#L45-L52)) fuses ada-only check + lovelace extract into a single dict walk.
- Inlined `parallel_all` ([sigma_or.ak:207-222](../../contracts/lovejoin/lib/lovejoin/sigma_or.ak#L207-L222)) and `pairs_match_and_all` ([mix_logic.ak:335-346](../../contracts/lovejoin/validators/mix_logic.ak#L335-L346)) avoid `list.zip` + `list.all`.
- `xor32` ([sigma_or.ak:75-87](../../contracts/lovejoin/lib/lovejoin/sigma_or.ak#L75-L87)) leans on `xor_bytearray`'s built-in length check, removing N² explicit length asserts.

Stdlib red flags audit (production code only, excluding `*.test.ak` and `build/`):

| Helper                                                       | Hits                                                                                         | Acceptable?                                                                                                              |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assets.flatten` / `assets.flatten_with`                     | 0                                                                                            | n/a                                                                                                                      |
| `assets.restricted_to`                                       | 0                                                                                            | n/a                                                                                                                      |
| `dict.from_pairs` / `dict.map` / `dict.keys` / `dict.values` | 0                                                                                            | n/a                                                                                                                      |
| `list.sort` / `list.flat_map` / `list.zip` / `list.reverse`  | `list.reverse` 1 ([mix_logic.ak:195](../../contracts/lovejoin/validators/mix_logic.ak#L195)) | yes — final step before iteration order matters; documented (`stmts_rev` accumulates in reverse, single reverse at end). |
| `list.count`                                                 | 1 ([fee_contract.ak:173](../../contracts/lovejoin/validators/fee_contract.ak#L173))          | borderline — see O-01.                                                                                                   |
| `list.map`                                                   | 1 ([mix_logic.ak:124](../../contracts/lovejoin/validators/mix_logic.ak#L124) — `self.inputs  | > list.map(fn(i) { i.output_reference })`)                                                                               | acceptable — Owner branch only, output is consumed once by `serialise_data`. Could be inlined into the serialise but the gain is one-time per Owner tx (cold path). Not flagged. |

| ID   | Optimization                                                                                                  | Component                         | Expected Benefit                              | Risk                                                  | File:Line                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| O-01 | Replace `list.count` with single-pass `list.foldl` (or short-circuit recursion) for Replenish fee-input count | `fee_contract.validate_replenish` | small constant on adversarial-many-inputs txs | low; **no baseline; benchmark before/after required** | [fee_contract.ak:172-174](../../contracts/lovejoin/validators/fee_contract.ak#L172-L174) |

That is the only Optimization finding worth recording. (Detailed finding under §8.)

### "Don't Compute, Verify" Pass (Phase 9b)

The codebase already applies this principle — `walk_outputs` accumulates the FS preimage during a single pass rather than computing a sort or hash externally; `precompute_statements` lifts uncompression off the per-input hot path; the protocol relies on redeemer-supplied proofs rather than re-deriving witnesses. No new candidates surfaced.

---

## 17. Test Coverage Review

### 16-row matrix (per [test_patterns.md](../../test_patterns.md))

| #   | Test Area                                   | Present? | Notes                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Happy-path for each redeemer                | yes      | one_shot_mint, mix_box (well-formed), mix_logic Owner / Mix, fee_contract PayMixFee / Replenish, publish RegisterCredential — all positive paths covered.                                                                                                             |
| 2   | Negative tests per critical check           | partial  | 257 fail-tests across the production test files; covers F-1, F-2, F-4, F-5, F-17 regression matrices. **Missing:** any negative for stake_credential or reference_script on continuing outputs (H-01, M-01) — see I-03 / I-04.                                        |
| 3   | Property/fuzz tests over Value / Datum      | yes      | `lib/lovejoin/fuzz_value.test.ak`, `fuzz_encoding.test.ak`, `fuzz_mixbox.test.ak`, `fuzz_xor.test.ak` (F-19 bundle).                                                                                                                                                  |
| 4   | Double-satisfaction tx shapes               | partial  | Mix branch's per-input proof binding makes DS-style attacks structurally impossible (each input has its own proof bound to (a, b) and ctx). No explicit test labelled "double-satisfaction" but the per-input binding is exercised by the multi-input positive tests. |
| 5   | Datum mutation                              | yes      | mix_box.test.ak F-2 and mix_logic.test.ak cover well-formed-vs-malformed transitions.                                                                                                                                                                                 |
| 6   | Redeemer mutation                           | yes      | fee_contract.test.ak F-1 covers Owner-vs-Mix; mix_logic.test.ak covers Mix-vs-Owner branch separation.                                                                                                                                                                |
| 7   | Wrong-signer                                | n/a      | No signer requirements — proofs are the credential.                                                                                                                                                                                                                   |
| 8   | Duplicate inputs / outputs                  | partial  | The walk_outputs logic enforces "exactly N prefix at script + non-script tail"; tests cover N ∈ {2, 3, 4, 6, 8}. No explicit "two identical inputs" test (Cardano forbids that anyway via UTxO uniqueness).                                                           |
| 9   | Wrong-asset / extra-mint                    | yes      | one*shot_mint.test.ak F-17 covers wrong asset name; the `expect [Pair(*, \_)]` pattern rejects multi-asset mints.                                                                                                                                                     |
| 10  | Burn tests for terminal redeemers           | n/a      | Protocol has no terminal-burn — the reference NFT is permanent (never burned).                                                                                                                                                                                        |
| 11  | Validity-interval edge cases                | n/a      | No validity-range usage in production.                                                                                                                                                                                                                                |
| 12  | Reference-input mutation                    | partial  | reference_holder.test.ak covers always-False. mix_logic / fee_contract tests construct synthetic ref_inputs but no test injects a second carrier of the protocol NFT to exercise the singleton enforcement.                                                           |
| 13  | Continuing-output stake-cred mutation       | **NO**   | I-03 — fixture cannot construct adversarial stake_credential.                                                                                                                                                                                                         |
| 14  | Continuing-output reference-script attached | **NO**   | I-04 — fixture never sets `reference_script: Some(_)`.                                                                                                                                                                                                                |
| 15  | Benchmarks for hot paths                    | **NO**   | I-02 — zero `bench` blocks.                                                                                                                                                                                                                                           |
| 16  | Worst-case datum-size benchmark             | **NO**   | I-02.                                                                                                                                                                                                                                                                 |

### Per-redeemer-constructor coverage

| Validator          | Redeemer Constructor           | Happy?                      | Negative?                                                               | Property?                                | Bench? |
| ------------------ | ------------------------------ | --------------------------- | ----------------------------------------------------------------------- | ---------------------------------------- | ------ |
| `reference_holder` | spend (any)                    | yes (always-False return)   | n/a (always-False)                                                      | n/a                                      | NO     |
| `one_shot_mint`    | mint (any)                     | yes                         | yes (F-17 wrong asset name; missing seed)                               | yes (fuzz_encoding via bytes round-trip) | NO     |
| `mix_box`          | spend (well-formed)            | yes                         | yes (F-2 NoDatum, F-2 DatumHash, missing withdrawal)                    | yes (fuzz_mixbox)                        | NO     |
| `mix_box`          | spend (non-well-formed → True) | yes (F-2 recovery)          | yes (proves the "well-formed input cannot use this branch" cross-check) | yes                                      | NO     |
| `mix_logic`        | withdraw `Owner`               | yes (incl. F-4 KAT)         | yes (F-4 replay regression, wrong proof, wrong N)                       | yes (schnorr_kat negative-flip suite)    | NO     |
| `mix_logic`        | withdraw `Mix`                 | yes (multiple N: 2,3,4,6,8) | yes (wrong proof, wrong N, wrong output value/shape)                    | yes (sigma_or_kat, fuzz_xor)             | NO     |
| `mix_logic`        | publish `RegisterCredential`   | yes (F-5)                   | yes (every other cert type)                                             | n/a                                      | NO     |
| `fee_contract`     | spend `PayMixFee`              | yes                         | yes (F-1 Owner-vs-Mix, wrong fee delta, missing ref)                    | partial (no fuzz over value)             | NO     |
| `fee_contract`     | spend `Replenish`              | yes                         | yes (decrease, native asset, wrong datum)                               | partial                                  | NO     |
| `fee_contract`     | spend (non-unit datum → True)  | yes (Rule-2 recovery)       | yes (proves "unit datum cannot reach this branch")                      | yes (encoding fuzz)                      | NO     |

Every "No" in `Bench?` is one item in I-02's checklist.

### Test smells found

- **No `test fail__` named tests** — but the codebase uses the equivalent `test name() fail` form consistently (the trailing `fail` keyword), which is the same semantic enforcement (Aiken aborts the test if the body returns True). Counter-counted via `grep -E "^test\s+\w+\([^)]*\)\s+fail"` → 257 hits. NOT a smell here.
- **No re-import of production into tests beyond the `Transaction` view** — verified by spot-checking validators/\*.test.ak; tests construct `Transaction` literals via `test_fixtures.ak` builders and call the validator's handler directly. ✓
- **Synthetic context size** — fixtures default to 1-2 inputs / 1-2 outputs; no fixture builds a "realistic Cardano tx" with wallet change, multiple native assets on user inputs, etc. This is a minor smell (already counted under I-02 as "scenario realism" for benchmarks).
- **Hardcoded test data not reflecting Cardano realities** — e.g. `denom_lovelace = 10_000_000` (10 ADA) in fixtures; real protocol denom may differ. Acceptable for tests.

### 17.x Test-fixture variance audit (Phase 7c)

| Fixture Field              | Default                                                 | Variants Tested                                                                                             | Verdict                                                                              |
| -------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Address.stake_credential` | `None`                                                  | none                                                                                                        | **no variants** → I-03                                                               |
| `Output.reference_script`  | `None`                                                  | none                                                                                                        | **no variants** → I-04                                                               |
| `tx.mint`                  | `assets.zero` (stdlib placeholder default)              | one_shot_mint tests construct adversarial mint values; mix_logic / fee_contract / mix_box tests use default | acceptable (only one_shot_mint reads `tx.mint`; the others rightly leave it default) |
| `tx.certificates`          | `[]`                                                    | mix_logic publish tests construct adversarial certificate variants (F-5 matrix)                             | acceptable                                                                           |
| `tx.validity_range`        | `interval.everything()` (stdlib placeholder default)    | none                                                                                                        | acceptable — no production validator reads `validity_range`                          |
| `Output.value` shape       | single-asset (lovelace-only via `assets.from_lovelace`) | multi-asset values are tested in PayMixFee / Replenish negative tests (rejecting native assets)             | acceptable                                                                           |

---

## 18. Off-Chain Builder Review

**Not applicable.** TARGET_CONTRACT_FOLDER (`/home/logic/Documents/LogicalMechanism/audit_machine/contracts/lovejoin`) contains no off-chain transaction-builder code. The README mentions an off-chain SDK at `pnpm --filter @lovejoin/sdk` but that lives outside the target. Per the audit-prompt rule, this section is N/A with the reason recorded.

The §3.8 builder-bypass question is answered in §3.

---

## 19. Dead Ends / Non-Issues / False Positives

| Item Checked                                                        | Result                        | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                       | Evidence                                                                                                                                                                                 |
| ------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------- |
| `assets.flatten` on bounded values in production                    | not present                   | grep `assets.flatten` in production: 0 hits                                                                                                                                                                                                                                                                                                                                                                                                  | `grep -rE "assets\.flatten" --include="\*.ak" contracts/lovejoin/                                                                                                                        | grep -v "/build/" | grep -v "\.test\.ak"` returns 0 |
| `list.head` on `tx.inputs` (always non-empty for Spend)             | not present                   | grep returns 0 hits                                                                                                                                                                                                                                                                                                                                                                                                                          | `grep -rE "list\.head\(.*tx\.inputs" --include="*.ak"` returns 0                                                                                                                         |
| Permissive branch (`X -> True`) gated by cross-validator constraint | n/a                           | All `_ -> True` paths in the production code are intentional Rule-2 hyperstructure escape hatches with documented liveness purpose (see §9 hs-02..hs-04).                                                                                                                                                                                                                                                                                    | §9                                                                                                                                                                                       |
| Missing signer where ownership is by NFT                            | acceptable                    | The protocol uses sigma-protocol proofs as the credential, not signers. Knowledge of `x` such that `b = [x]·a` proves ownership of mix-box `(a, b)`. The reference NFT's "ownership" is irrelevant because the UTxO is locked at always-False.                                                                                                                                                                                               | [validators/mix_logic.ak:106-142](../../contracts/lovejoin/validators/mix_logic.ak#L106-L142), [validators/reference_holder.ak](../../contracts/lovejoin/validators/reference_holder.ak) |
| Catch-all `_ -> fail` (deny-by-default)                             | acceptable                    | Every validator has `else(_) { fail }` as the catch-all for non-matching script purposes. Good style.                                                                                                                                                                                                                                                                                                                                        | All five validators.                                                                                                                                                                     |
| Catch-all `_ -> False` deny-by-default in match arms                | acceptable                    | mix_logic.publish line 68, mix_logic.ak:344, mixbox.ak:30, fee.ak:26,36, value.ak:22, sigma_or.ak:220 — all are deny-by-default for unhandled cases.                                                                                                                                                                                                                                                                                         | §9 "Other always-true / always-false branches"                                                                                                                                           |
| `find_script_outputs` returning multiple, bound by `expect [x]`     | partially applicable          | fee_contract uses `list.filter` + `expect [fee_output]` which is the same shape (singleton-or-fail).                                                                                                                                                                                                                                                                                                                                         | [fee_contract.ak:148-150](../../contracts/lovejoin/validators/fee_contract.ak#L148-L150), [fee_contract.ak:176-178](../../contracts/lovejoin/validators/fee_contract.ak#L176-L178)       |
| Missing validity-range check where deadline lives in partner script | n/a                           | Lovejoin has no time-sensitive logic; validity_range is unused in production.                                                                                                                                                                                                                                                                                                                                                                | grep `validity_range` in production: 0 hits                                                                                                                                              |
| Absent ADA min-check (ledger enforces min-ADA)                      | acceptable                    | Validators do not re-check min-ADA; they enforce a stricter `denom_lovelace` invariant on mix outputs and a stricter "delta == fee" invariant on fee outputs.                                                                                                                                                                                                                                                                                | [mix_logic.ak:271](../../contracts/lovejoin/validators/mix_logic.ak#L271), [fee_contract.ak:158-160](../../contracts/lovejoin/validators/fee_contract.ak#L158-L160)                      |
| Absent `lovelace_of(self.mint) == 0` check                          | acceptable                    | one_shot_mint pattern-matches on `[Pair(asset_name, quantity)]`; ledger forbids ADA in `tx.mint` so the only entry is the protocol asset.                                                                                                                                                                                                                                                                                                    | [validators/one_shot_mint.ak:42](../../contracts/lovejoin/validators/one_shot_mint.ak#L42)                                                                                               |
| Absent `quantity_of(o.value, p, n) >= 0` check                      | acceptable                    | Ledger forbids negative output quantities. Validators enforce stricter equalities.                                                                                                                                                                                                                                                                                                                                                           | n/a                                                                                                                                                                                      |
| Absent duplicate-key checks on `tx.datums` / `tx.redeemers`         | acceptable                    | Ledger guarantees uniqueness. The fee_contract uses `pairs.get_first(self.redeemers, Withdraw(Script(...)))` which trusts uniqueness.                                                                                                                                                                                                                                                                                                        | [fee_contract.ak:103-107](../../contracts/lovejoin/validators/fee_contract.ak#L103-L107)                                                                                                 |
| `lovejoin/dhtuple.ak` appears unused                                | acceptable (parity anchor)    | Module is referenced only by KAT and encoding-parity tests. Documented in I-05.                                                                                                                                                                                                                                                                                                                                                              | I-05                                                                                                                                                                                     |
| Mix-branch FS-context input-ref omission (would F-4 apply?)         | not exploitable               | F-4 fixed Owner replay where a third-party observer reuses a published proof against a duplicate-(a,b) box. Mix branch is structurally different: full replay requires N duplicate inputs (one per original input) AND those duplicates cost N×denom_lovelace; the produced duplicate output (a',b') benefits the legitimate Owner (who can claim 2× their deposit), not the attacker. Net: attacker loses (N−1)×denom_lovelace. Irrational. | §15 Phase-5g table, attacker-cost analysis                                                                                                                                               |
| Replenish accepts arbitrary increase from anyone                    | acceptable (intentional)      | Permissionless top-up is a feature — anyone can fund the fee pool. The strict-increase invariant prevents value-loss.                                                                                                                                                                                                                                                                                                                        | [fee_contract.ak:163-187](../../contracts/lovejoin/validators/fee_contract.ak#L163-L187)                                                                                                 |
| Mix tx with no fee-shard input is allowed                           | flagged as L-04               | Coverage in L-04.                                                                                                                                                                                                                                                                                                                                                                                                                            | L-04                                                                                                                                                                                     |
| Owner branch outputs are unconstrained value-wise                   | acceptable                    | Owner is withdrawing; the proof's FS context binds outputs (preventing third-party replay). The owner choosing to grief themselves by sending to an always-fail script is irrational.                                                                                                                                                                                                                                                        | [validators/mix_logic.ak:106-142](../../contracts/lovejoin/validators/mix_logic.ak#L106-L142)                                                                                            |
| `mix_logic.publish` rejects every cert except `RegisterCredential`  | acceptable (intentional, F-5) | Rejecting `UnregisterCredential`, delegation, governance certs is the correct hyperstructure default — the credential exists, is registered, and nothing else can ever happen to it.                                                                                                                                                                                                                                                         | [mix_logic.ak:65-70](../../contracts/lovejoin/validators/mix_logic.ak#L65-L70), F-5 regression in [mix_logic.test.ak:538](../../contracts/lovejoin/validators/mix_logic.test.ak#L538)    |

### 19.1 Grep Inventory

| #   | Phase                                     | Pattern (truncated)                                                                                                                                                                                              | Hit Count (production)                                                 | Sample File:Line                      | Notes                                                                 |
| --- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| 1   | 3 (datum/context shape)                   | `InlineDatum\|expect Some\|from_data\|datum_hash\|NoDatum\|Option<.*Datum`                                                                                                                                       | many                                                                   | mixbox.ak:43                          | seed for §3                                                           |
| 2   | 3                                         | `OutputDatum\|DatumHash\|self\.datums\|tx\.datums`                                                                                                                                                               | a few                                                                  | mixbox.ak:35                          |                                                                       |
| 3   | 3 (auth/signer)                           | `extra_signatories\|required_signer\|VerificationKeyHash\|payment_credential\|stake_credential\|signed_by`                                                                                                       | many                                                                   | fee.ak:24                             | seeds H-01 / I-03                                                     |
| 4   | 3 (withdraw)                              | `withdraw\(\|withdraw_zero\|validate_withdraw`                                                                                                                                                                   | 1                                                                      | mix_logic.ak:46                       | the lone production withdraw handler                                  |
| 5   | 3 (publish/cert)                          | `publish\(\|propose\(\|vote\(\|certificate`                                                                                                                                                                      | a few                                                                  | mix_logic.ak:65                       | F-5                                                                   |
| 6   | 3 (off-chain sig / cheque)                | `verify_ed25519_signature\|serialise_data\|blake2b_224\|blake2b_256\|cheque\|nonce\|replay`                                                                                                                      | several                                                                | mix_logic.ak:121                      | no `verify_ed25519_signature` in production                           |
| 7   | 3 (validity range)                        | `validity_range\|lower_bound\|upper_bound\|is_inclusive\|is_entirely_after\|is_entirely_before\|Finite\|deadline\|expiry\|lock_until`                                                                            | 0 in production                                                        | n/a                                   | dead-ends row "no validity_range"                                     |
| 8   | 3 (reference inputs)                      | `reference_inputs\|find_input\|find_script_outputs\|list\.head\(.*reference`                                                                                                                                     | a few                                                                  | reference.ak:27                       |                                                                       |
| 9   | 3 (pairing/output discovery)              | `list\.find\(.*outputs\|list\.find\(.*inputs\|list\.filter\(.*outputs\|list\.filter\(.*inputs\|count_input_scripts\|count_script_outputs`                                                                        | 2                                                                      | fee_contract.ak:63, mix_box.ak:53     |                                                                       |
| 10  | 3 (always-true / fail)                    | `_ -> True\|_ -> False\|True\s*\}\|fail\s*\}\|_ -> fail`                                                                                                                                                         | many                                                                   | mix_logic.ak:68, mix_box.ak:67        | seeds §6 hyperstructure classification                                |
| 11  | 3 (mint/burn/policy)                      | `fn mint\|mint\(\|Mint\|PolicyId\|from_minted_value\|assets\.tokens\|tokens\(`                                                                                                                                   | a few                                                                  | one_shot_mint.ak:30                   |                                                                       |
| 12  | 3 (one-shot/seed)                         | `OutputReference\|seed\|one_shot\|one-shot`                                                                                                                                                                      | a few                                                                  | one_shot_mint.ak:32                   |                                                                       |
| 13  | 3 (value/multi-asset)                     | `assets\.flatten\|without_lovelace\|lovelace_of\|quantity_of\|value\.policies\|assets\.zero\|merge\(\|from_lovelace\|from_asset`                                                                                 | several                                                                | mix_logic.ak:184, value.ak:46         |                                                                       |
| 14  | 3 (`match` `>=` value)                    | `match\s*\(\|>=.*value\|value.*>=`                                                                                                                                                                               | 0 in production                                                        | n/a                                   | safe                                                                  |
| 15  | 3 (stdlib red flags hot path)             | `assets\.flatten(_with)?\|assets\.restricted_to\|dict\.from_pairs\|dict\.map\|dict\.keys\|dict\.values\|list\.sort\|list\.count\|list\.flat_map\|list\.zip\|list\.reverse\|list\.length\(.*list\.filter`         | 1 (`list.count`) + 1 (`list.reverse`, documented)                      | fee_contract.ak:173, mix_logic.ak:195 | seeds O-01                                                            |
| 16  | 3 (arithmetic risk)                       | `/[^/]\|\bdivide\b\|\bmod\b\|underflow\|overflow\|negate\|basis\|bp`                                                                                                                                             | 0 risky in production                                                  | n/a                                   | only doc-comment hits; no division, no mod, no signed-arithmetic risk |
| 17  | 3 (Pair / Pairs / dict)                   | `Pair\(\|Pairs<\|dict\.get\|dict\.to_pairs`                                                                                                                                                                      | several                                                                | value.ak:46-49, one_shot_mint.ak:42   |                                                                       |
| 18  | 3 (tests/benchmarks)                      | `^test\s+\|^test\s+fail__\|via\s\|fuzz\.\|^bench\s+`                                                                                                                                                             | tests: many; benches: 0                                                | n/a                                   | seeds I-02                                                            |
| 19  | 3 (stdlib import style)                   | `use cardano/transaction\|use cardano/assets\|use aiken/transaction\|use aiken/transaction/value`                                                                                                                | modern only (no legacy)                                                | mix_logic.ak:28                       |                                                                       |
| 20  | 5b (mint↔spend coupling)                  | mint policy enumeration                                                                                                                                                                                          | 1 mint policy (`one_shot_mint`); no spend coupling required (one-shot) | one_shot_mint.ak                      | §12                                                                   |
| 21  | 5c (singleton/twin)                       | `expect [x]\|list.find singleton`                                                                                                                                                                                | 1 (reference UTxO singleton enforcement)                               | reference.ak:30                       | §10                                                                   |
| 22  | 5d (cross-validator coherence)            | redeemer cross-references                                                                                                                                                                                        | 1 (PayMixFee → Mix)                                                    | fee_contract.ak:103-109               | seeds L-04                                                            |
| 23  | 5e (off-chain signature payload)          | `verify_ed25519_signature`                                                                                                                                                                                       | 0 in production                                                        | n/a                                   | §13 N/A                                                               |
| 24  | 5f (address perimeter)                    | `payment_credential\s*==\|payment_credential\s*=>\|Script\(.*\)\s*->\|fn\s+\w+_at_(script\|fee\|own\|own_script)\|output_at_\|input_at_\|find_script_outputs\|find_script_output\|\.address\.payment_credential` | helpers + every caller (~10 sites)                                     | mixbox.ak:27, fee.ak:23               | seeds H-01 + M-01                                                     |
| 25  | 5g (crypto context)                       | `bls12_381\|verify_ed25519_signature\|schnorr\|sigma\|fiat_shamir\|domain_separator\|domain_tag\|blake2b_256.*serialise_data\|blake2b_224.*serialise_data\|challenge\|preimage\|statement_id\|merkle\|kzg`       | many                                                                   | hash.ak:15-22, sigma_or.ak            | §15 Phase-5g table                                                    |
| 26  | 6 (always-true classification)            | `_ -> True\|True\s*\}\|^\s*True\s*$`                                                                                                                                                                             | 4 productive paths                                                     | §9                                    | seeds §9                                                              |
| 27  | 7b (per-redeemer constructor enumeration) | `type\s+\w+Redeemer\|^pub\s+type\s+\w+\s*\{`                                                                                                                                                                     | 2 (MixLogicRedeemer, FeeRedeemer)                                      | types.ak:50,57                        | §17 per-redeemer table                                                |
| 28  | 7b (`fail__` naming)                      | `^test\s+fail__`                                                                                                                                                                                                 | 0 (codebase uses `test name() fail` form, equivalent)                  | n/a                                   | not a smell                                                           |
| 29  | 7c (variance: stake_credential)           | `stake_credential\s*:\s*[A-Z]`                                                                                                                                                                                   | 3 (all `None`)                                                         | test_fixtures.ak:97,101               | seeds I-03                                                            |
| 30  | 7c (variance: reference_script)           | `reference_script\s*:\s*[A-Z]`                                                                                                                                                                                   | many (all `None`)                                                      | test_fixtures.ak:128 etc.             | seeds I-04                                                            |
| 31  | 7c (variance: tx.mint default)            | `\bmint\s*:\s*assets\.zero\|\bmint\s*:\s*\[\]`                                                                                                                                                                   | 1 (stdlib placeholder default only)                                    | n/a                                   | acceptable                                                            |
| 32  | 7c (variance: tx.validity_range)          | `validity_range\s*:\s*interval\.everything\|validity_range\s*:\s*Interval`                                                                                                                                       | 1 (stdlib placeholder default)                                         | n/a                                   | acceptable                                                            |
| 33  | 9 (`bench` count)                         | `^bench\s+`                                                                                                                                                                                                      | **0**                                                                  | n/a                                   | I-02                                                                  |

If any future re-audit finds the row count above does not match the greps named in Phases 3, 5b-5g, 6, 7b-7c, 9 of the audit prompt, the audit was incomplete. (Verified row count: 33 matches the prompt's grep enumeration.)

---

## 20. Final Recommendations

### 20.0 Coordinated Fixes

| Root Cause Slug                | Findings         | Proposed Single Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Effort                                                                                                                                                           | Risk                                                                          |
| ------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `address-perimeter-incomplete` | H-01, M-01       | Replace `output_at_script` ([mixbox.ak:27-32](../../contracts/lovejoin/lib/lovejoin/mixbox.ak#L27-L32)) and `output_at_fee` ([fee.ak:23-28](../../contracts/lovejoin/lib/lovejoin/fee.ak#L23-L28)) with a single `is_protocol_output(o, expected_script_hash)` helper that asserts payment cred + `stake_credential == None` + `reference_script == None`. Replace every continuing-output call site (mix_logic.ak:269, fee_contract.ak:149, fee_contract.ak:177) with the new helper. | one helper + ~3 call-site replacements + add the negative tests from H-01/M-01 + extend test_fixtures with stake-cred + ref-script variants (closes I-03 / I-04) | Low (refactor; the negative tests are simultaneously the regression coverage) |
| `lifecycle-off-chain-only`     | L-01, L-02, L-03 | Extend `one_shot_mint` to assert (a) the minted NFT is sent to the canonical `reference_holder` address (parameterize by reference_holder_hash); (b) the destination's inline datum decodes as `ReferenceDatum` with sane bounds (denom > 0, max_fee > 0, max_fee < denom); (c) (optional, separate mint policy) cap fee-shard token count at K.                                                                                                                                       | one mint-policy edit + parameter-graph update + bootstrap-script update                                                                                          | Medium (changes the bootstrap interface; coordinate with off-chain SDK)       |
| `fixture-stuck-at-default`     | I-03, I-04       | Extend `test_fixtures.ak` with `script_address_with_stake_*`, `mix_box_output_with_ref_script`, `fee_shard_output_with_ref_script` builders. Use them in the new H-01 / M-01 negative tests.                                                                                                                                                                                                                                                                                           | one fixture-module edit + 4-6 new tests                                                                                                                          | Low                                                                           |
| `bench-coverage-missing`       | I-02             | Add 11 `bench` blocks per the I-02 checklist.                                                                                                                                                                                                                                                                                                                                                                                                                                          | spread across all five validator test files                                                                                                                      | Low; high value (anchors all subsequent optimization work)                    |

(I-01 / I-05 / O-01 / L-04 each have a unique root cause and do not appear above.)

### Must Fix Before Mainnet

1. **H-01** — Replace continuing-output checks with the unified `is_protocol_output` helper. The address-perimeter gap is exploitable on every Mix tx.

### Should Fix Before Mainnet

2. **M-01** — Closed by the same edit as H-01.
3. **L-01 / L-02 / L-03** — Tighten bootstrap-time invariants on chain. At minimum, parameterize `one_shot_mint` against `reference_holder_hash` and assert NFT destination + datum shape.

### Nice To Have

4. **L-04** — Decide whether per-Mix fee is mandatory; either enforce it on `mix_logic.validate_mix` or document the design intent.
5. **I-01** — Re-run `aiken build` and re-commit `plutus.json`.

### Optimization Backlog

6. **O-01** — Replace `list.count` with `list.foldl` in `validate_replenish`. Benchmark before/after.

### Documentation Backlog

7. **I-05** — Add a one-line note at the top of `dhtuple.ak` describing its parity-anchor role.
8. **I-02** — Once `bench` blocks land, document the empirical Mix-tx N ceiling in the README.
9. **I-03 / I-04** — Once fixture variants land, document the fixture vocabulary in `test_fixtures.ak`'s top-of-file comment.

---

## 21. Appendix: Files Inspected

| File                                                                                      | Lines                                                                                                                       | Purpose                                    | What Was Checked                                                                                                                    |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| [aiken.toml](../../contracts/lovejoin/aiken.toml)                                         | n/a                                                                                                                         | Project manifest                           | version, compiler pin, deps                                                                                                         |
| [plutus.json](../../contracts/lovejoin/plutus.json)                                       | n/a                                                                                                                         | Compiled blueprint                         | preamble version vs aiken.toml; compiler match                                                                                      |
| [README.md](../../contracts/lovejoin/README.md)                                           | n/a                                                                                                                         | Quickstart                                 | validator inventory, spec map, build flow                                                                                           |
| [validators/reference_holder.ak](../../contracts/lovejoin/validators/reference_holder.ak) | 35                                                                                                                          | Always-False reference holder              | always-False semantics, parameterization, hyperstructure classification                                                             |
| [validators/one_shot_mint.ak](../../contracts/lovejoin/validators/one_shot_mint.ak)       | 54                                                                                                                          | One-shot mint policy                       | seed consumption, asset name pin, quantity pin, lifecycle gap (L-01)                                                                |
| [validators/mix_box.ak](../../contracts/lovejoin/validators/mix_box.ak)                   | 74                                                                                                                          | Mix-box spend delegator                    | F-2 inline-only gate, Rule-2 recovery (hs-02, hs-03), withdraw-zero coupling                                                        |
| [validators/mix_logic.ak](../../contracts/lovejoin/validators/mix_logic.ak)               | 346                                                                                                                         | Withdraw + Publish validator               | Owner branch (Schnorr), Mix branch (sigma-OR), single-walk prologue, F-4 ctx, F-5 cert matrix, address perimeter (H-01, M-01), L-04 |
| [validators/fee_contract.ak](../../contracts/lovejoin/validators/fee_contract.ak)         | 187                                                                                                                         | Fee-shard spend validator                  | F-1 PayMixFee gate, single-pass fold, Rule-2 recovery (hs-04), Replenish strict-increase, address perimeter (H-01, M-01), O-01      |
| [lib/lovejoin/types.ak](../../contracts/lovejoin/lib/lovejoin/types.ak)                   | 60                                                                                                                          | Shared protocol types                      | ReferenceDatum / MixDatum / MixLogicRedeemer / FeeRedeemer shapes; M4.5 schema-cleanup note (L-03 cross-reference)                  |
| [lib/lovejoin/mixbox.ak](../../contracts/lovejoin/lib/lovejoin/mixbox.ak)                 | 123                                                                                                                         | Mix-box helpers (well-formedness, address) | output_at_script (root of H-01/M-01), well-formed Data decoder, strict decoder for prefix walk                                      |
| [lib/lovejoin/fee.ak](../../contracts/lovejoin/lib/lovejoin/fee.ak)                       | 58                                                                                                                          | Fee-shard helpers                          | output_at_fee (root of H-01/M-01), is_unit_inline_datum                                                                             |
| [lib/lovejoin/value.ak](../../contracts/lovejoin/lib/lovejoin/value.ak)                   | 52                                                                                                                          | ada-only value extractor                   | expect_ada_only_lovelace single-walk shape                                                                                          |
| [lib/lovejoin/reference.ak](../../contracts/lovejoin/lib/lovejoin/reference.ak)           | 38                                                                                                                          | Reference-input lookup                     | singleton enforcement (§10), L-02 cross-reference                                                                                   |
| [lib/lovejoin/bls.ak](../../contracts/lovejoin/lib/lovejoin/bls.ak)                       | 76                                                                                                                          | BLS12-381 G1 wrappers                      | scalar canonical decode (`v < r`), point uncompress (subgroup check via builtin)                                                    |
| [lib/lovejoin/hash.ak](../../contracts/lovejoin/lib/lovejoin/hash.ak)                     | 146                                                                                                                         | Fiat-Shamir preimage builders              | DOMAIN tag, statement IDs, header_const_prefix optimization                                                                         |
| [lib/lovejoin/schnorr.ak](../../contracts/lovejoin/lib/lovejoin/schnorr.ak)               | 46                                                                                                                          | Schnorr verifier                           | base-parametric Schnorr, FS preimage with statement_id_prove_dlog                                                                   |
| [lib/lovejoin/sigma_or.ak](../../contracts/lovejoin/lib/lovejoin/sigma_or.ak)             | 222                                                                                                                         | N-way sigma-OR verifier                    | XOR fold, parallel_all, precompute_statements, verify_pre                                                                           |
| [lib/lovejoin/dhtuple.ak](../../contracts/lovejoin/lib/lovejoin/dhtuple.ak)               | 47                                                                                                                          | DH-tuple verifier (parity anchor)          | I-05 — unused by validators, kept for KAT parity                                                                                    |
| [lib/lovejoin/test_fixtures.ak](../../contracts/lovejoin/lib/lovejoin/test_fixtures.ak)   | 248                                                                                                                         | Test-fixture builders                      | I-03 / I-04 — fixture variance gaps                                                                                                 |
| [validators/\*.test.ak](../../contracts/lovejoin/validators/)                             | 762 + 766 + 196 + 187 + 234 + 102 = 2247 lines                                                                              | Per-validator positive + negative tests    | F-1, F-2, F-4, F-5, F-17 regression KATs; per-N positive paths; certificate matrix                                                  |
| [lib/lovejoin/\*\_kat.test.ak](../../contracts/lovejoin/lib/lovejoin/)                    | schnorr_kat 814 + dhtuple_kat 1624 + sigma_or_kat 4809 + encoding_parity_kat 1532 + value_serialise_parity 102 = 8881 lines | Cross-implementation parity KATs           | byte-equal FS preimage layout vs SDK prover                                                                                         |
| [lib/lovejoin/fuzz\_\*.test.ak](../../contracts/lovejoin/lib/lovejoin/)                   | 4 files, ~336 lines total                                                                                                   | Property fuzz tests (F-19 bundle)          | decoders, value normalization, sigma-OR XOR fold, mixbox shape                                                                      |

### Validator coverage sub-table

| Validator          | Lines Read | Redeemers Found                                                                                 | Redeemers Audited | Tests Found     |
| ------------------ | ---------- | ----------------------------------------------------------------------------------------------- | ----------------- | --------------- |
| `reference_holder` | 35         | 1 (any spend → False)                                                                           | 1                 | yes (53 lines)  |
| `one_shot_mint`    | 54         | 1 (any mint redeemer; structural rules apply)                                                   | 1                 | yes (234 lines) |
| `mix_box`          | 74         | 1 (any spend redeemer; datum shape branches the logic)                                          | 1                 | yes (196 lines) |
| `mix_logic`        | 346        | 2 withdraw constructors (Owner, Mix) + 1 publish branch (RegisterCredential vs everything-else) | 3                 | yes (762 lines) |
| `fee_contract`     | 187        | 2 spend constructors (PayMixFee, Replenish) + 1 Rule-2 recovery branch                          | 3                 | yes (766 lines) |
