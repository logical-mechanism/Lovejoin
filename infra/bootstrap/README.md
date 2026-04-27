# Bootstrap

One-shot ceremony per network. Takes the protocol from compiled code to live,
immutable on-chain state.

After bootstrap finishes:

- `mix_box`, `mix_logic`, and `fee_contract` are published as CIP-33 reference
  scripts so future Mix txs cite them via `--tx-in-reference` instead of
  inlining ~5 KiB of script per tx.
- The `mix_logic` stake credential is registered (so withdraw-zero spends are
  valid going forward).
- A one-of-one **reference NFT** lives forever at the always-False
  `reference_holder` script address, with an inline `ProtocolParams` datum.
- 10 fee-contract shards are seeded at `fee_contract`.
- `artifacts/<network>/addresses.json` holds the canonical address book — it
  gets committed to git after a clean run.

## Stages

Four stages, orchestrated by `run.sh`. Stage 1 internally chains four txs.

| # | script | what it does | tx count |
|---|--------|--------------|---------:|
| 0 | `00-build-reference.sh`           | offline. Parameterizes the validators in dependency order (`one_shot_mint(seed) → mix_logic(NFT) → mix_box(mix_logic) → fee_contract(NFT)`), writes resolved hashes to `addresses.json`. | 0 |
| 1 | `01-publish-and-register.sh`      | recursive tx chain: publishes `mix_box`, `mix_logic`, `fee_contract` as CIP-33 reference scripts (one tx per script — keeps every tx well under the 16 KiB limit as validators grow), then registers the `mix_logic` stake credential, attaching the script via `--certificate-tx-in-reference` against tx 2's output. Each tx after the first spends the previous tx's change output as funding, so the operator only supplies one funding UTxO + one collateral UTxO. | 4 |
| 2 | `02-mint-and-lock.sh`             | **irreversible.** Spends `SEED_UTXO`, mints the one-of-one NFT, locks at `reference_holder` with the inline `ProtocolParams` datum. | 1 |
| 3 | `03-fund-fee-contract.sh`         | seeds 10 shards at `fee_contract`. | 1 |

`run.sh` calls these in sequence with confirmation polling between, and is
the recommended path. The per-stage scripts remain callable on their own for
recovery (see "Running a stage manually" below).

The single-script-per-tx convention inside stage 1 isolates failures (a publish
that fails costs only its own funding + fee, not the whole infrastructure
setup) and matches the recursive ref-input pattern the production txs will
use.

> **Plutus collateral note.** Under the Babbage/Conway happy path, collateral
> inputs are *preserved* (not consumed) — they're only seized if a script
> fails. So the same `COLLATERAL` UTxO from `prep-utxos` works for stages 1
> and 2 without rotation.

## Wallet

One keypair, multiple per-network address files. A Cardano signing key carries
no network identity — the same keypair works across preprod / preview /
mainnet; only the bech32 address encoding differs.

`init-wallet.sh` sets it up. Idempotent — re-running with an existing keypair
or address leaves it alone, so it's safe to run any time you add a new
network or want to make sure the wallet exists.

```sh
./infra/bootstrap/init-wallet.sh                  # preprod + preview
./infra/bootstrap/init-wallet.sh --include-mainnet # also mainnet (opt-in)
```

Layout (everything under `infra/bootstrap/wallets/`, all gitignored):

```
infra/bootstrap/wallets/
├── payment.skey               # shared signing key (NEVER commit)
├── payment.vkey               # shared verification key
├── payment.preprod.addr       # bech32 address for preprod
├── payment.preview.addr       # bech32 address for preview
└── payment.mainnet.addr       # only if --include-mainnet
```

Fund `payment.preprod.addr` from the [Preprod faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/).

Fund it from the [Preprod faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/).
Budget for a clean Preprod bootstrap (defaults assumed):

| stage | what                               | ≈ ADA |
|-------|------------------------------------|------:|
| 1     | three ref-script outputs + cert    | 80    |
| 2     | reference UTxO @ reference_holder  | 5     |
| 3     | 10 fee shards × `max_fee × 5`      | 40    |
|       | per-tx fees + collateral float     | 10    |
| **total** |                                | **≈ 135** |

Round up to ~150 ADA so you don't have to top up mid-bootstrap.

### UTxO layout

The faucet hands you ~10,000 ADA as a single UTxO. The bootstrap stages each
need a distinct UTxO with specific properties (Cardano forbids
`--tx-in-collateral` from overlapping with `--tx-in`, and the seed UTxO must
be a separate input from the funding UTxO too). So before running the stages
you split the faucet drop into the four shapes below:

| label | size       | used by                                                      |
|-------|-----------:|--------------------------------------------------------------|
| **A** FUNDING (stage 1) |  85 ADA | `01-publish-and-register.sh` (3 ref outputs + cert + chain fees) |
| **B** COLLATERAL        |  10 ADA | stages 1 & 2 (cert reg + mint); ada-only, returned by ledger so it persists across both |
| **C** SEED              |   7 ADA | `02-mint-and-lock.sh` (consumed by `one_shot_mint`) |
| **D** FUNDING (stage 3) |  45 ADA | `03-fund-fee-contract.sh` (10 shards × 4 ADA + fee) |
|       | + change   | leftover, sits at the wallet for next time |

`prep-utxos.sh` does the split in one tx and prints the UTxO refs you need
for each stage. Idempotent: if the wallet already has 4+ ada-only UTxOs at
the bootstrap address, it logs a "skipping" notice instead of double-splitting.

`balance.sh` prints the wallet's current UTxOs and total ADA. Run it any
time — it's the simplest way to confirm the faucet drop arrived, pick a
SOURCE for `prep-utxos`, or sanity-check between bootstrap stages.

```sh
./infra/bootstrap/balance.sh                  # default: NETWORK=preprod
NETWORK=preview ./infra/bootstrap/balance.sh
```

## Running it

The recommended path is **`run.sh`** — it drives everything end-to-end with
confirmation polling between stages. Each per-stage script is still callable
on its own for recovery / debugging.

### Configure once via .env

Every script under `infra/bootstrap/` auto-sources `infra/bootstrap/.env` if
it exists. The file is gitignored (via the top-level `.env` pattern), so
your live values stay local.

```sh
cp infra/bootstrap/.env.example infra/bootstrap/.env
$EDITOR infra/bootstrap/.env       # set NETWORK, TESTNET_MAGIC, CARDANO_NODE_SOCKET_PATH
```

After that, no `export` per shell. CLI env-var passing still works for
overrides (e.g. `NETWORK=preview ./balance.sh` overrides the .env value
just for that invocation).

### Bootstrap, end-to-end

```sh
./infra/bootstrap/init-wallet.sh                # one-time keypair + addrs

# Fund infra/bootstrap/wallets/payment.preprod.addr from the Preprod faucet.
cat infra/bootstrap/wallets/payment.preprod.addr
./infra/bootstrap/balance.sh                    # confirm the faucet drop

./infra/bootstrap/run.sh                        # split → 0 → 1 → 2 → 3, with waits
```

`run.sh` does:

1. Sanity-checks the wallet (calls `balance.sh`).
2. Splits the faucet drop via `prep-utxos.sh`.
3. Polls until prep-utxos confirms.
4. Runs `00-build-reference.sh` (offline parameterization).
5. Runs `01-publish-and-register.sh`. Polls until the cert-registration tx confirms.
6. Runs `02-mint-and-lock.sh`. Polls until the reference UTxO is on chain. **(Irreversible step.)**
7. Runs `03-fund-fee-contract.sh`. Polls until the fee shards are on chain.
8. Prints the protocol identifiers + the `git commit` line for `addresses.json`.

Polling is via `cardano-cli query utxo --tx-in <ref>`: as soon as the previous
stage's first output is in the on-chain UTxO set, the next stage starts.
Default per-tx timeout is 5 minutes (override with `CONFIRMATION_TIMEOUT_S`).

### Running a stage manually

If `run.sh` fails partway, the per-stage scripts pick up from the artifact
state. `addresses.json` is the source of truth — re-run only the stages
whose fields aren't populated yet. Env-var contract:

```sh
SEED_UTXO=$SEED ./infra/bootstrap/00-build-reference.sh
FUNDING_UTXO=$FUNDING_STAGE1 COLLATERAL_UTXO=$COLLATERAL \
  ./infra/bootstrap/01-publish-and-register.sh
SEED_UTXO=$SEED COLLATERAL_UTXO=$COLLATERAL \
  ./infra/bootstrap/02-mint-and-lock.sh
FUNDING_UTXO=$FUNDING_STAGE3 ./infra/bootstrap/03-fund-fee-contract.sh
```

`prep-utxos.sh` prints the four UTxO refs in copy-pasteable form so you can
set the env vars without hand-editing.

Then commit:

```sh
git add artifacts/preprod/addresses.json
git commit -m "bootstrap(preprod): mint NFT <policy>, ref UTxO <txid>#<idx>"
```

### How the chain in stage 1 works

The script uses `cardano-cli conway transaction txid --tx-file <signed-tx>`
to derive each tx's id offline (no node call), then references that id as the
input of the next tx. Submission is sequential — `cardano-cli conway
transaction build` resolves the next input against the local node's UTxO set
+ mempool, so each tx must already be in flight before the next one builds.
On Preprod that means stage 1 takes one block window (~20 s) end to end; on a
slower node you may see "input not found" errors and need to add `sleep 5`
between submissions.

## What can go wrong

- **Seed UTxO consumed by the wrong tx.** The `one_shot_mint(seed)` policy
  fires only if `seed` is in the inputs of the mint tx. If 02 fails for any
  reason and the seed got spent in a different tx, you have to start over
  with a different seed. Re-run `00-build-reference.sh` with the new seed
  before retrying.
- **Inline-datum decode error at the reference UTxO.** Validators that read
  `ProtocolParams` will hard-fail if the datum doesn't decode. After 02
  confirms, sanity-check the inline datum (`cardano-cli query utxo`
  `--address <reference_holder_addr> --output-json`).
- **Stage 1 chain breaks mid-flight.** If tx 2 or 3 of stage 1 fails to
  confirm, re-run only the tail. The simplest recovery is to re-run stage 1
  with a fresh `FUNDING_UTXO` — the already-published ref scripts from the
  failed run cost only their funding (no protocol meaning until stage 2's
  reference UTxO exists). `addresses.json` will be overwritten on the
  re-run; the old ref-script UTxOs become orphan.
- **Stake registration cert deposit refund.** If you ever needed to recover
  the ~2 ADA cert deposit, you'd have to deregister the credential.
  `mix_logic.publish` rejects deregistration (Rule 2 hyperstructure stance),
  so you're not getting that ADA back.
- **Mainnet.** None of these scripts default to mainnet. The bootstrap is
  one-shot per network; mainnet bootstrap is gated behind the audit per
  spec OQ-Y.

## Practice run

Before doing the canonical Preprod bootstrap, do at least one full run on a
private wallet and verify each artifact. The mint is one-shot per `(seed,
network)` — once you've spent the seed, you can't reuse it. On Preprod
that's fine (request more faucet ADA), but the practice helps you catch
parameter mismatches before the canonical run lands.

See [docs/spec/12-build-guide.md §Risk 4](../../docs/spec/12-build-guide.md).
