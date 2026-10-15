# integration-tests

Preprod-only end-to-end tests for the Lovejoin SDK.

## What's here

| File                            | Milestone | What it does                                                                       |
| ------------------------------- | --------- | ---------------------------------------------------------------------------------- |
| `test/deposit-withdraw.test.ts` | M3        | Deposit a mix-box + withdraw it back to a fresh address. Skipped without env vars. |
| `test/token-pool.test.ts`       | tokens    | Every operation against the Preprod token-pool launch over Koios. Opt-in.          |

The M4 tests (mix, full lifecycle, fee exhaustion, collateral failure)
land when M4 ships.

## Running

These tests submit real transactions on Preprod. They require:

1. **Blockfrost project id** — free at https://blockfrost.io
2. **A Preprod wallet with ~30 ADA** — to fund deposits + cover tx fees.
3. **The `addresses.json` of a bootstrapped Preprod deployment** —
   committed at `artifacts/preprod/addresses.json`.

### Setup (one-time)

Copy the env template at the repo root and fill it in:

```bash
cp .env.example .env
$EDITOR .env
```

Required fields in `.env`:

```sh
BLOCKFROST_PROJECT_ID_PREPROD=preprod...

# Pick ONE wallet source:

# (a) cardano-cli skey hex — extract with:
#     jq -r .cborHex /path/to/payment.skey
LOVEJOIN_PAYMENT_SKEY=5820...

# (b) BIP-39 mnemonic
# LOVEJOIN_MNEMONIC="word1 word2 ... word24"
```

`.env` is gitignored. Anything in it stays on your machine.

### Run

```bash
make integration-test
```

The Makefile target sources `.env` automatically, builds the SDK, and
runs the test. If env vars are missing the test reports a clear
`SKIP — env var X not set` and exits 0, so CI doesn't break for
forks / contributors who haven't set up Preprod creds.

You can also invoke vitest directly if you've already exported the env:

```bash
pnpm --filter integration-tests test -- deposit-withdraw
```

### Token-pool test (Koios, no Blockfrost)

`test/token-pool.test.ts` runs against the token-pool launch made by
[`infra/bootstrap/koios-token-launch.py`](../infra/bootstrap/README.md#token-pool-rehearsal-on-preprod-through-koios),
through `KoiosProvider`. It deposits four boxes, mixes them with the wallet
paying at N = 2, 3, 4, checks that `mix_logic` rejects a Mix whose output value
differs from the box value (evaluation only), and withdraws two boxes in each
fee mode. The fee contract is out of scope: the launch funds no shards. It prints each tx's script budget, fee, and size, and writes them
to `artifacts/preprod-token/last-run.json`.

It submits real transactions, so it only runs when asked:

```bash
pnpm --filter @lovejoin/sdk build
LOVEJOIN_TOKEN_POOL_TEST=1 pnpm --filter integration-tests exec vitest run test/token-pool.test.ts
```

It uses the launch key in `infra/bootstrap/wallets/token-preprod/` and saves
each box's owner secret next to it before depositing; a later run first
withdraws any box an interrupted run left behind.

`vitest.config.ts` preloads `libsodium-hook.mjs`: the ESM build of
libsodium-wrappers-sumo 0.7.16 imports a file that ships in a sibling package,
which breaks every mesh import under Node. The hook redirects that one import.

## What "passes 10 consecutive runs" means

The exit criterion for M3 historically required 10 sequential green
runs of `deposit-withdraw`. Once a single run is reliably green, wrap it
in a shell loop:

```bash
for i in $(seq 1 10); do make integration-test || break; done
```
