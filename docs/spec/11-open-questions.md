# 11 — Open questions

Most resolved. Remaining items are deferred or empirical-at-M2.

---

## Resolved

### ~~OQ-1 — Denomination set~~
ADA only, single denomination from `config/network.json`. Test config 10 ADA. Multi-denom is M8+ (added on demand).

### ~~OQ-2 — Native asset support~~
Not in v1.

### ~~OQ-3 — Mixer model~~
Every user is a mixer in v1; UI exposes a "Mix N random pool boxes" button. No dedicated mixer-bot service in v1.

### ~~OQ-4 — Stealth withdraw~~
Out of scope at the protocol level. Recommend Seedelf at the wallet layer.

### ~~OQ-5 — Fee strategy~~
Shared `fee_contract` validator with two paths (PayMixFee, Replenish). Sharded across 10 UTxOs.

### ~~OQ-6 — Local test infra~~
Preprod for everything. Contracts bootstrapped via cardano-cli + cardano-node shell scripts.

### ~~OQ-7 — Off-chain crypto library~~
`@noble/curves` for BLS12-381 G1 + `@noble/hashes` for blake2b/HMAC.

### ~~OQ-8 — Wallet / tx builder~~
mesh by default. Confirm mesh handles externally-supplied collateral at M3 start; fall back to lucid-evolution if blocked.

### ~~OQ-9 — Backend infra~~
Assume db-sync and ogmios always-on, reachable via env-var URLs.

### ~~OQ-10 — Spec layout~~
Multi-file in `docs/spec/`.

### ~~OQ-A — `MAX_FEE_PER_MIX` value~~
Empirically calibrated at M2 stress test. `ceil(max_observed × 1.25)`.

### ~~OQ-B — Default `N_rounds`~~
20/30/50 suggestions; default 30; minimum 5.

### ~~OQ-C — Allow `N_rounds = 0`?~~
No. UI enforces `≥ 5`.

### ~~OQ-D — Fee contract fragmentation~~
Sharded into ~10 long-lived UTxOs; Replenish path tops up existing shards.

### ~~OQ-E — Mesh fee-contract compatibility~~
Assume it works. Confirm at M3. Fall back to lucid-evolution only if proven blocked.

### ~~OQ-F — Aiken version pinning~~
**Aiken 1.1.21** pinned at M0.

### ~~OQ-G — Browser key storage~~
Encrypted IndexedDB with Argon2id, modeled on Lace/Eternl/Nami.

### ~~OQ-H — RFC 6979 deterministic nonces~~
Yes. HMAC-SHA256-keyed, unpredictable to attackers, deterministic for the prover. Safer than RNG-based for our use case.

### ~~OQ-I — Withdraw signer~~
No signer for the box. Spent purely by Schnorr proof bound to `txOutputsHash`. Mirrors Seedelf.

### ~~OQ-J — Reference script publication~~
Hyperstructure pattern: always-False `reference_holder` validator, one-shot-mint NFT, `ProtocolParams` inline datum, validators look up via `tx.reference_inputs`.

### ~~OQ-N — Fee contract drain mitigation~~
Structurally drain-safe. Not a meaningful concern.

### ~~OQ-O — i18n~~
Yes, from M0.

### ~~OQ-P — Governance~~
Hyperstructure: permissionless, immutable, no admin.

### ~~OQ-T — Variable N in Mix~~
Yes — full Sigmajoin construction with N-way sigma-OR. `max_n` calibrated empirically at M2 (initial bet: 6). SDK defaults to `max_n` per Mix; UI exposes a slider.

### ~~OQ-U — Collateral source for Mix tx~~
Resolved via integration with the [Collateral-Provider / giveme.my](https://github.com/logical-mechanism/Collateral-Provider) service. Default `GivemeMyProvider` client in the SDK; user-overridable.

### ~~OQ-V — Mandatory collateral provider~~
The collateral provider is **mandatory** for Mix txs — without it, the submitter's wallet appears as the collateral signer and tracking becomes trivial, defeating the whole privacy gain. There is **no default fallback** to wallet-collateral for Mix txs. If the provider is unreachable, Mix submission is blocked until it recovers. Users can configure a custom provider in the SDK; that satisfies the mandatory-integration requirement just as well. A decentralized collateral provider remains a M8+ goal.

### ~~OQ-W — Collateral provider service fee~~
giveme.my is a **free service**. No payment flow needed in the SDK. If a future provider charges, we'll add account-management at that time.

### ~~OQ-X — Fall-back behavior when collateral provider is down~~
Resolved with OQ-V: no fallback. The UI shows a yellow banner and disables the Mix button until the provider is reachable. Users can switch to a custom provider via SDK config to bypass the dependency on any single service.

---

## Open

### OQ-K — Production ogmios / db-sync hosting
Deferred. Likely DigitalOcean. Decide near release.

### OQ-L — UI hosting
Deferred. Likely DigitalOcean alongside backend. Privacy users self-host or run from source.

### OQ-M — External audit
Currently only project contributors review the code (user reviews math; Claude reviews implementation). **Not equivalent to a third-party audit** for mainnet. Independent crypto + Cardano-contract reviewers required before mainnet. Decide before M7 close.

### OQ-Q — Mainnet `denom_lovelace`
Test config: 10 ADA. Production: TBD. Considerations:
- Higher = thinner pool but more privacy per box.
- Lower = thicker pool, more accessibility.
Decide before mainnet bootstrap.

### OQ-R — Indexer hosting model
Backend best run alongside ogmios + db-sync. Anyone can run their own. Hyperstructure principle.

### OQ-S — i18n locale list
Initial: English. Community translations welcomed; `CONTRIBUTING.md` to specify the contribution flow.

### OQ-Y — Decentralized collateral provider (M8+)

The current giveme.my integration is a centralized service — a partial trust assumption documented in [08-threat-model.md](08-threat-model.md) A6. Long-term direction:
- **Federated**: multiple competing free providers; SDK rotates among them. Reduces single-point-of-correlation risk.
- **Decentralized**: a smart-contract-based collateral pool that signs autonomously. Cardano's UTxO model + Plutus makes this constructible but adds significant complexity.

Defer to M8+. The existing centralized provider is acceptable for v1.
