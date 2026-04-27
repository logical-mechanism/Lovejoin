# 08 — Threat model

## Trust assumptions

- **DDH is hard** in BLS12-381 G1 prime-order subgroup.
- **blake2b-256 behaves as a random oracle** for Fiat-Shamir.
- **HMAC-SHA256 is a secure PRF** (RFC 6979 nonce derivation).
- **Cardano consensus is not under attack.** Reorgs deeper than 2k blocks are tolerated by re-syncing.
- **The user's local environment is uncompromised.**
- **`@noble/curves` and Aiken's BLS12-381 builtins are correct.**
- **ogmios and db-sync feed correct data.**
- **The reference UTxO is and remains the protocol's source of truth for parameters.**
- **The collateral provider does not maliciously fail their own scripts** (which would cause them to lose collateral and force a Mix tx to fail). They have economic incentive not to do this; they're paid for service.

## Adversary classes

### A1 — Passive observer
Reads the chain. Computes statistics over public data.

**Goal:** link a deposit to a withdrawal.

**Defense:** Sigmajoin's indistinguishability under DDH. After `k` mixes at width `N`, success probability is `(1/N)^k`.

**Caveats:**
- **Timing.** Quick deposit → mixes → withdraw narrows candidate set. *Mitigation:* UI suggests minimum mix duration; SDK adds jitter on multi-mix sequences.
- **Fee fingerprints — Mix is clean.** Mix tx has no submitter wallet input (fee from a fee-contract shard, collateral from the collateral provider). The *mix* itself leaks no submitter identity. **Deposit and Withdraw still use the user's wallet.** Same wallet on both → linked. *Mitigation:* fresh wallet for withdraw + Seedelf destination.
- **Collateral provider as wallet identifier.** The collateral provider's wallet appears as a signer for every Mix tx using the service. This is the same wallet across many users; an observer learns "this Mix used giveme.my-style collateral" but not "user X submitted it." *Mitigation:* the same wallet appearing many times is the point — it's an anonymity set on the collateral side.
- **Single-pool monoculture.** Tiny pool means tiny anonymity set.
- **Pool heuristics from amounts.** Fixed denomination → no value-based linking.
- **Fee shard balance correlation.** A deposit increases one specific shard; a Mix decreases one. Sharding (10 shards) and many users dampen this.

### A2 — Active attacker, no funds at stake

- **Steal funds:** requires forging Schnorr or sigma-OR. Reduces to discrete log or DDH. Out of reach.
- **Drain the fee contract:** PayMixFee requires real Mix txs with valid sigma-OR proofs. An attacker producing them is performing real mixes, which benefits the network. Replenish strictly increases value.
- **Drain via paired Owner withdraws:** Owner spend with 2+ mix-boxes can satisfy the fee contract's "≥ 2 mix inputs" check. This lets an Owner withdraw their own boxes paid by the fee contract. We accept this as user reclamation of their own deposited fee credit, not as theft. Acceptable residual.
- **Censor mixes:** front-running a Mix is impossible because the proof binds to specific output datums.
- **Replay the same tx:** identical to legitimate; no theft.
- **Deanonymize via the protocol:** no information channel beyond what A1 gets.

### A3 — Malicious co-mixer

Another user submitting Mix txs targeting the victim's box.

- They learn the same as A1 plus their own `y_i` mappings.
- Repeated targeted mixing of the victim narrows the trajectory **only if** the attacker can also identify their own outputs across mixes (they can; they hold their own secrets).
- *Mitigation:* uniform random N-tuple selection. With higher `N`, the per-mix anonymity gain (`1/N`) makes it harder to dominate.
- *Mitigation:* the victim self-mixes more.

### A4 — Compromised UI / SDK build
- Compromised SDK can leak `x` or mis-generate it.
- *Mitigation:* reproducible builds; SRI hashes; source-self-host preferred.

### A5 — Reference-UTxO compromise

- **Cannot mint a duplicate NFT.** One-shot policy parameterized by a now-spent UTxO; can fire once.
- **Cannot move the legitimate NFT.** reference_holder validator is False.
- **Cannot trick validators into reading a different UTxO.** Validators verify reference input contains exactly the protocol NFT.

Structurally impossible.

### A6 — Malicious or unreliable collateral provider

The collateral provider is a mandatory dependency for Mix txs. Risks:

- **The provider can refuse service**, denying mixing to specific submitters or all of them. *Mitigation:* SDK supports custom providers — a power user can run their own. Long-term: decentralized provider (M8+).
- **The provider can deliberately fail their own scripts** to forfeit collateral and break the Mix tx. They lose money to do this; nobody else loses funds. The provider's wallet becomes visible. Reputation handles this in practice.
- **The provider can correlate request timing with on-chain Mix txs** to deanonymize submitters who sourced collateral from them. The provider cannot see the submitter's wallet or destination, but they see request IPs and timing. *Mitigation:* TOR / VPN at the request layer; provider's API does not require account-level identity (giveme.my is free and stateless); SDK sends only the minimal info needed (collateral amount + tx body digest).
- **The provider's wallet might be deanonymized via other means** (mainnet activity, off-chain leaks). That's the provider's own opsec problem and is out of our control.
- **The provider going down**: Mix txs are blocked until recovery. Acceptable for v1 — privacy is more important than uptime, and the alternative (fall back to wallet-collateral) defeats the protocol's wallet-anonymity property.

The collateral provider is a partial trust assumption: the user trusts the provider for *liveness* (will they sign when asked?) and for *opsec* (will they log my IP and correlate?). The user does NOT trust the provider for custody — collateral is just a forfeit-on-failure mechanism, not a fund custody.

For a fully trustless system (mainnet long-term goal), we'd want a decentralized collateral provider with zero-knowledge request handling. Out of scope for v1; M8+ work.

### A7 — Future: outsourced mixer-bot operators (M8+)
Out of scope for v1.

## Specific attacks and defenses

### Replay / malleability
**Defense:** Owner proof's challenge incorporates `serialize(tx.outputs)`; substitution invalidates.

### Front-running a Mix
**Defense:** Mix proof binds to all N output datums and values. Mutation invalidates.

### Datum substitution in Mix outputs
**Defense:** datum is in the proof ctx; mutation invalidates. Attacker still needs the corresponding `x'` to spend the substituted box.

### Subgroup confusion
**Defense:** `bls12_381_G1_uncompress` performs subgroup check. Validator additionally rejects `a == b`.

### RFC 6979 nonce safety
**Defense:** an attacker who can predict the nonce would have to break HMAC-SHA256. Out of reach.

### Withdraw without box-signer
**Defense:** Schnorr proof bound to `serialize(tx.outputs)`. Attacker cannot rebind to different outputs.

### Malicious N-way OR proof construction
**Defense:** verifier checks `c == XOR_i c_i` where `c = H(transcript)`. The simulator branch can fool a single equation but not the XOR-completion check; both must hold simultaneously, and the prover knows the witness for at least one branch.

### Side channels
The off-chain prover uses constant-time scalar mul (`@noble/curves`). RFC 6979 nonce derivation removes RNG side channels.

## Out of scope

- Quantum adversaries.
- Backdoored `crypto.getRandomValues`.
- Long-range Ouroboros attacks.

## Severity classification

- **P0** — funds can be stolen, or invalid proofs are accepted. Halt all work, hotfix.
- **P1** — privacy promise broken (passive observer linking beyond stated bounds), or DoS preventing mixing > 1 hour.
- **P2** — privacy leak requiring active attacker effort, or correctness bug in non-critical paths.
- **P3** — UX issue, performance regression < 10%.

P0 and P1 trigger automatic mainnet pause and a public advisory.

## Audit gap (current state)

The only auditors today are project contributors. Independent crypto and contract reviewers required before any mainnet deployment. See [11-open-questions.md](11-open-questions.md) OQ-M.
