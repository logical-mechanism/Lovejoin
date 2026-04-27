# integration-tests

Preprod-only end-to-end tests for the Lovejoin SDK.

## What's here

| File                         | Milestone | What it does                                          |
|------------------------------|-----------|--------------------------------------------------------|
| `test/deposit-withdraw.test.ts` | M3        | Deposit a mix-box + withdraw it back to a fresh address. Skipped without env vars. |

The M4 tests (mix, full lifecycle, fee exhaustion, collateral failure) land
when M4 ships.

## Running

These tests submit real transactions on Preprod. They require:

1. **Blockfrost project id** — free at https://blockfrost.io
2. **A Preprod wallet with ~30 ADA** — to fund deposits + cover tx fees.
3. **The `addresses.json` of a bootstrapped Preprod deployment** — committed
   at `artifacts/preprod/addresses.json`.

Set the env vars and run:

```bash
export BLOCKFROST_PROJECT_ID_PREPROD=preprod...
export LOVEJOIN_PAYMENT_SKEY=58205820...   # cardano-cli payment.skey hex
# OR
export LOVEJOIN_MNEMONIC="word1 word2 ... word24"

# Optional:
export LOVEJOIN_NETWORK=preprod                              # default
export LOVEJOIN_ADDRESSES=./artifacts/preprod/addresses.json # default

pnpm --filter integration-tests test -- deposit-withdraw
```

If any of the required env vars are missing the test reports a clear
`SKIP — env var X not set` and exits 0, so CI doesn't break for forks /
contributors who haven't set up Preprod creds.

## What "passes 10 consecutive runs" means

The exit criterion in `milestones.json` (M3) requires 10 sequential green
runs of `deposit-withdraw`. The runner script lives at
`scripts/run-deposit-withdraw-x10.sh` once the test stabilizes.
