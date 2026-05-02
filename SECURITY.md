# Security policy

## Status of the protocol

Lovejoin is **alpha software, deployed only on Cardano Preprod**. No real funds are at stake. The on-chain protocol has not yet undergone an external audit. A formal audit and a coordinated disclosure window will precede any mainnet deployment.

Despite the alpha status, we take security seriously and want to hear from you if you find a problem. Disclosure is the right way to make the project safer.

## What's in scope

- The Aiken validators in [contracts/](contracts/), the on-chain protocol invariants, and the bootstrap ceremony in [infra/bootstrap/](infra/bootstrap/).
- The TypeScript SDK in [offchain/](offchain/) (crypto, tx-builders, ChainProvider implementations).
- The backend in [backend/](backend/) (indexer, API).
- The UI in [ui/](ui/) (wallet handling, vault, secret derivation, IndexedDB storage).
- The reference implementation in [crypto/](crypto/) when divergence from the TS or Aiken implementations causes a security-relevant invariant to fail.

Specifically of interest:

- Any way to deanonymize a depositor / withdrawer pair beyond the `(1/N)^k` linkage bound the protocol claims.
- Any way to spend a mix-box without satisfying the Owner branch's Schnorr proof or the Mix branch's N-way sigma-OR proof.
- Any way to drain the fee-contract pool, double-spend a fee shard, or cause a Mix tx to pay less than the spec requires.
- Any way to forge or replay a CIP-8 wallet signature so as to recover or steal another user's vault seed.
- TS / Aiken byte-encoding parity divergences that would make a proof valid off-chain but invalid on-chain (or vice versa).
- XSS, CSRF, prototype pollution, or any other web-side issue in the UI that could exfiltrate the in-memory vault seed or the IndexedDB-encrypted backup.

## What's out of scope

- Issues in third-party dependencies that have already been disclosed upstream. File those upstream and link to them here.
- Anything requiring physical access to the user's machine, social engineering, or compromise of the user's wallet provider.
- DoS against giveme.my or other external collateral providers. The collateral provider is pluggable; UI / SDK behavior when a provider misbehaves is in scope, but the provider itself is not our service.
- Issues that require running an old commit. Reproduce against the current `main` or `dev` tip.
- Cardano protocol-level issues (Ouroboros, Plutus VM, etc.). Report those to IOG.

## How to report

**Please do not open a public GitHub issue for security disclosures.**

Email **support@logicalmechanism.io** with:

- A clear description of the issue and the impact.
- A minimal reproduction (commands, transactions, or code).
- The commit SHA you tested against.
- Your preferred contact and credit information (optional; we are happy to credit researchers in the changelog).

If you want to encrypt the report, ask in your first email and we will reply with a public key.

## Disclosure process

1. You report privately.
2. We confirm and triage. We will tell you whether we agree the issue is in scope and roughly when we expect a fix.
3. We work on a fix. You are welcome to review patches before they ship.
4. We deploy the fix. For on-chain issues, this may require a redeploy of the reference UTxO; the existing pool is not upgradable.
5. We coordinate a public disclosure. Default window: **90 days from the initial report**, or sooner if a fix has shipped and reached users. We are flexible if you need more time and explain why.
6. We publish a security note in [CHANGELOG.md](CHANGELOG.md) and credit you (unless you prefer to remain anonymous).

If we have not responded within the timelines above, you are welcome to disclose publicly. We would rather you push us than sit on an issue.

## Bounty

Because lovejoin is **alpha on Preprod with no real funds at stake**, we do not currently run a paid bug bounty program. We do offer:

- **Public credit** in the changelog and release notes (or anonymity, your call).
- **Direct contact** with the maintainer for follow-up work.
- **Swag and modest gratitude payments** at the maintainer's discretion for high-quality reports, especially ones that find on-chain protocol issues.

A formal bounty program will be considered alongside the pre-mainnet audit. Until then, treat reports as a contribution to the project's safety, not as a transaction.
