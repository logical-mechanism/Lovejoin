# Seedelf integration

Lovejoin's Vault hosts the [Seedelf stealth wallet](https://github.com/logical-mechanism/Seedelf-Wallet) as a first-class wallet surface. Both protocols live on the same curve (BLS12-381 G1), use the same Schnorr Σ-protocol shape for the discrete-log relation, and share Lovejoin's wallet-derived seed for key material.

This document is the wallet-model and threat-model reference for users + reviewers. The protocol itself is unchanged from the upstream Seedelf deployment; Lovejoin only adds an off-chain integration on top.

## What Seedelf is

A Seedelf register is the pair `(generator, public_value)` published as an inline datum on the Seedelf wallet script. `public_value = generator^x` for a secret scalar `x` only the owner knows. The wallet validator accepts a spend iff the redeemer carries a Schnorr proof of knowledge of `x` bound to a one-time verification-key hash that the same tx places in `extra_signatories`.

Sending funds to someone's Seedelf is a regular Cardano payment to the wallet script address with the recipient's register re-randomized as the inline datum: `(g, u) -> (g^d, u^d)` for a fresh CSPRNG-sourced scalar `d`. The new register is computationally unlinkable to the original under ECDDH but still spendable by the same `x`.

## How Lovejoin derives Seedelf secrets

Lovejoin already holds a 32-byte vault seed derived from the connected wallet's CIP-8 `signData` over the canonical payload (`offchain/src/wallet/seed.ts`). Seedelf register secrets are derived from the **same** seed with a different HKDF info tag:

```
seed       = blake2b_256("lovejoin/owner-seed/v1" || stakeAddr || sig_bytes)
x_owner_i  = HKDF-SHA256(seed, info = "lovejoin/owner/v1"   || u32_be(i)) mod r
x_seed_i   = HKDF-SHA256(seed, info = "lovejoin/seedelf/v1" || u32_be(i)) mod r
```

Different info tag, independent key streams. A leak of one derivation never compromises the other.

## What the UI shows today

The Vault's Seedelf panel is **read-only**:

- It scans the Seedelf wallet contract address for UTxOs the active vault unlocks.
- It partitions them into "registers" (UTxOs carrying a `5eed0e1f…` locator NFT — your stealth identities) and "funds" (re-randomized payments into your registers).
- It surfaces the count of each plus the total ADA balance.

Mint / Send / Spend transactional flows ship in a follow-up update. For now, mint your first register and manage spending from the upstream [`seedelf-cli`](https://github.com/logical-mechanism/Seedelf-Wallet/tree/main/seedelf-platform/seedelf-cli) — the keys it derives are NOT compatible with Lovejoin's vault (`seedelf-cli` uses its own encrypted wallet file under `$HOME/.seedelf`). The UI will discover any register you have on chain regardless of where its NFT was minted; the secret is what gates ownership.

## Implicit tracking methods (ITMs)

Reproduced from the [Seedelf README](https://github.com/logical-mechanism/Seedelf-Wallet#implicit-tracking-methods) for visibility — Seedelf's stealth property survives only under these assumptions.

1. **First-mint linkability.** Minting a register requires a CIP-30 wallet input that signs the mint tx. Your wallet `ω` is now linked to the register `σ`. The spend side stays hidden; the link is one-way. To break it, use `seedelf-cli util mint` to publish a stealth re-mint `σ'` once `σ` is funded, then burn `σ`.

2. **Fee-paying UTxO linkability.** A spend tx hides the owner of the register being consumed, but the collateral input is key-witnessed and observable. When you exit Seedelf back to a wallet, the destination is observed too. Best practice: enter with one wallet, leave with another.

3. **Flood attack on the register set.** The wallet's anonymity depends on a healthy population of unique registers. A rich bad actor minting a large fraction of the contract's UTxOs reduces the effective set size. The only defense is encouraging honest, broad use of Seedelf.

4. **Network-level tracking.** Seedelf depends on third-party APIs (Blockfrost, Koios, giveme.my). Each tracks IP addresses for abuse prevention. Tor support is partial today. Use a VPN you trust or non-personal devices for high-sensitivity activity.

## Why we reuse the canonical deployment

The Seedelf wallet contract is permissionless and immutable. We use the same `wallet_script_hash` and `seedelf_policy_id` the upstream `seedelf-cli` does. The reference UTxOs holding the compiled scripts are also reused — operators running their own deployment can override every coordinate via the `VITE_SEEDELF_*` env vars (see `.env.example`).

Network-config defaults are in `config/network.{preprod,mainnet}.json` under the `seedelf` key. The SDK's `resolveSeedelfAddresses(network, overrides)` produces the same `SeedelfAddresses` object the scanner + tx-builders consume.

## What the SDK ships

Module `@lovejoin/sdk` exports under `offchain/src/seedelf/`:

| File           | Surface                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| `seed.ts`      | `deriveSeedelfSecret(seed, index)` — domain-separated HKDF                                                   |
| `register.ts`  | `createRegister`, `rerandomizeRegister`, `ownsSeedelfRegister`, `encodeRegisterDatum`, `decodeRegisterDatum` |
| `schnorr.ts`   | `proveSeedelfSchnorr`, `verifySeedelfSchnorr` (blake2b-224 Fiat-Shamir)                                      |
| `token.ts`     | `buildSeedelfTokenName`, `isSeedelfAssetName` (matches Aiken `token_name.generate`)                          |
| `signer.ts`    | `generateSeedelfEphemeralKey` (Ed25519 one-time-pad signer)                                                  |
| `redeemer.ts`  | `encodeMintRedeemer`, `encodeSpendRedeemer`, `placeholderSpendRedeemerHex`                                   |
| `scanner.ts`   | `scanSeedelfUtxos`, `classifySeedelfUtxos`                                                                   |
| `addresses.ts` | `SEEDELF_PREPROD_ADDRESSES`, `SEEDELF_MAINNET_ADDRESSES`, `resolveSeedelfAddresses`                          |
| `mint.ts`      | `planSeedelfMintTx` (plan-only — mesh wiring is caller's responsibility)                                     |
| `send.ts`      | `planSeedelfSendTx` (plan-only — regular wallet-paid payment)                                                |
| `spend.ts`     | `planSeedelfSpendTx` (Schnorr proofs + redeemers; uses an ephemeral signer + giveme.my collateral)           |

Plan helpers produce all the cryptographic + datum bytes a mesh tx-builder needs. The mesh wiring for spend follows the same pattern Lovejoin's `mix.ts` uses (no submitter wallet input, external collateral via `GivemeMyProvider`, witness merge via `appendVkeyWitness`).

## Threat model alignment with Lovejoin

| Property                       | Lovejoin Mix                                  | Seedelf Spend                        |
| ------------------------------ | --------------------------------------------- | ------------------------------------ |
| Wallet anonymity at submission | yes — no wallet input                         | yes — no wallet input                |
| Collateral provider            | giveme.my (mandatory)                         | giveme.my (mandatory)                |
| One-time pad                   | n/a (proof is its own pad via tx-binding ctx) | ephemeral vkh in `extra_signatories` |
| Replay defense                 | Schnorr ctx hashes outputs + input refs       | vkh + Schnorr binding                |
| Re-randomization               | per-Mix on every box                          | per-send to a register               |

Both flows trust the same collateral host. A malicious host can refuse to witness a spend (denying service) but cannot steal funds — the proof binds the spend to the wallet contract address, and the user retains their secret.
