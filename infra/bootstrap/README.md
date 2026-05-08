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

Five operator commands, run sequentially. Stage 1 is split in two so each half
can be inspected on-chain before the next runs.

| #   | script                    | what it does                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | `00-build-reference.sh`   | offline. Parameterizes the validators, writes resolved hashes to `addresses.json`.                                                                                                                                                                                                                                                                       |
| 1a  | `01a-publish.sh`          | builds + signs three publish txs offline (mix_box, mix_logic, fee_contract) using `build-raw`, chained via change outputs (manual fee + change math, since `transaction build` queries on-ledger UTxOs and would fail on the unconfirmed predecessors). Submits them in order. Writes `referenceScriptUtxos` and `stage1ChangeUtxo` to `addresses.json`. |
| 1b  | `01b-register.sh`         | registers the `mix_logic` stake credential. Run after `01a` confirms — uses `transaction build` (auto fee + change), references the published mix_logic ref script via `--certificate-tx-in-reference`, and consumes the chain's final change UTxO (`stage1ChangeUtxo` from `addresses.json`).                                                           |
| 2   | `02-mint-and-lock.sh`     | **irreversible.** Spends `SEED`, mints the one-of-one NFT, locks at `reference_holder` with the inline `ReferenceDatum`.                                                                                                                                                                                                                                 |
| 3   | `03-fund-fee-contract.sh` | seeds 10 shards at `fee_contract`.                                                                                                                                                                                                                                                                                                                       |

> **Plutus collateral note.** Under the Babbage/Conway happy path, collateral
> inputs are _preserved_ (not consumed) — they're only seized if a script
> fails. So the same `COLLATERAL` UTxO from `prep-utxos` works for `01b` and
> stage 2 without rotation.

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

| stage     | what                              |     ≈ ADA |
| --------- | --------------------------------- | --------: |
| 1         | three ref-script outputs + cert   |        80 |
| 2         | reference UTxO @ reference_holder |         5 |
| 3         | 10 fee shards × `max_fee × 5`     |        40 |
|           | per-tx fees + collateral float    |        10 |
| **total** |                                   | **≈ 135** |

Round up to ~150 ADA so you don't have to top up mid-bootstrap.

### UTxO layout

The faucet hands you ~10,000 ADA as a single UTxO. The bootstrap stages each
need a distinct UTxO with specific properties (Cardano forbids
`--tx-in-collateral` from overlapping with `--tx-in`, and the seed UTxO must
be a separate input from the funding UTxO too). So before running the stages
you split the faucet drop into the four shapes below:

| label                   |     size | used by                                                                                      |
| ----------------------- | -------: | -------------------------------------------------------------------------------------------- |
| **A** FUNDING (stage 1) |   85 ADA | funds `01a-publish`'s 3-tx chain; the chain's final change UTxO funds `01b-register`         |
| **B** COLLATERAL        |   10 ADA | `01b-register` + `02-mint-and-lock`; ada-only, returned by ledger so it persists across both |
| **C** SEED              |    7 ADA | `02-mint-and-lock.sh` (consumed by `one_shot_mint`)                                          |
| **D** FUNDING (stage 3) |   55 ADA | `03-fund-fee-contract.sh` (10 shards × 5 ADA + fee)                                          |
|                         | + change | leftover, sits at the wallet for next time                                                   |

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

```sh
cp infra/bootstrap/.env.example infra/bootstrap/.env
$EDITOR infra/bootstrap/.env        # set NETWORK + TESTNET_MAGIC + CARDANO_NODE_SOCKET_PATH

./infra/bootstrap/init-wallet.sh    # one-time keypair + per-network addrs
cat infra/bootstrap/wallets/payment.preprod.addr   # paste into the faucet
./infra/bootstrap/balance.sh        # confirm the faucet drop arrived

./infra/bootstrap/prep-utxos.sh     # splits faucet drop into A/B/C/D and prints
                                    # the four `export` lines you need next.

# Wait for the prep tx to confirm. balance.sh now labels the four UTxOs
# (FUNDING_STAGE1 / COLLATERAL / SEED / FUNDING_STAGE3) so you can verify
# the split landed.
./infra/bootstrap/balance.sh

# Paste the four export lines from prep-utxos's output (or balance.sh —
# they're identical), then run the stages in order:

# Each stage reads the canonical names directly — no renaming on the call site.
./infra/bootstrap/00-build-reference.sh

./infra/bootstrap/01a-publish.sh                # 3 chained publish txs (build-raw)
# wait for confirmation (./balance.sh)

./infra/bootstrap/01b-register.sh               # stake-cred registration (transaction build)
# wait for confirmation

./infra/bootstrap/02-mint-and-lock.sh
# wait for confirmation — this is the IRREVERSIBLE step

./infra/bootstrap/03-fund-fee-contract.sh
# wait for confirmation
```

Then propagate the new addresses to the UI and commit:

```sh
# Backend reads artifacts/<network>/addresses.json directly via
# ADDRESSES_PATH (defaulting to ./artifacts/<network>/addresses.json),
# so just restart the backend and it picks up the new state.

# The UI fetches a static asset under ui/public/. Sync it after every
# bootstrap (and after every max-n-calibration run that updates max_n
# in config/network.<network>.json):
make sync-ui-addresses NETWORK=preprod    # or NETWORK=preview, etc.

git add artifacts/preprod/addresses.json ui/public/addresses.preprod.json
git commit -m "bootstrap(preprod): mint NFT <policy>, ref UTxO <txid>#<idx>"
```

`make sync-ui-addresses` copies `artifacts/<network>/addresses.json` into
`ui/public/addresses.<network>.json` and stamps `protocol.max_n` from
`config/network.<network>.json` so the UI's MixWidthSlider clamps to the
deployed cap. Re-run it any time the calibration sweep changes `max_n`.

`addresses.json` is the source of truth for what has already been done — its
`referenceScriptUtxos`, `referenceUtxoRef`, and `feeShardUtxos` fields get
populated as the corresponding stages confirm. If a stage fails partway,
re-run only the stages whose fields aren't populated yet.

### Tweaking pre-bootstrap parameters

The bootstrap reads two values out of `artifacts/<network>/addresses.json`'s
`protocol` block when it constructs the inline `ReferenceDatum` (in
`02-mint-and-lock.sh`):

- `denom_lovelace` — the canonical mix-box denomination (10 ADA on Preprod).
- `max_fee_per_mix_lovelace` — the upper bound the on-chain `fee_contract`
  enforces for every Mix tx's fee.

If you need to change either, edit `artifacts/<network>/addresses.json` AND
`config/network.<network>.json` (the SDK reads the latter at runtime to gate
submissions client-side) BEFORE running `02-mint-and-lock.sh`. The mint is
irreversible, so the value baked here is permanent for this deployment.

### How the chain in 01a works

`01a-publish.sh` uses `cardano-cli conway transaction txid --tx-file
<signed-tx>` to derive each tx's id offline (no node call), then references
that id as the input of the next tx. Submission is sequential — the local
node accepts each tx because the chain is internally consistent (each input
is the previous tx's known-shape change output). On Preprod that means 01a
takes one block window (~20 s) end to end.

`01b-register.sh` is the opposite shape: it runs _after_ 01a confirms, so
`transaction build` (which resolves on-ledger UTxOs and computes fee + change

- Plutus exec budget automatically) works directly. It picks up the chain's
  final change UTxO from `addresses.json`'s `stage1ChangeUtxo` field.

## What can go wrong

- **Seed UTxO consumed by the wrong tx.** The `one_shot_mint(seed)` policy
  fires only if `seed` is in the inputs of the mint tx. If 02 fails for any
  reason and the seed got spent in a different tx, you have to start over
  with a different seed. Re-run `00-build-reference.sh` with the new seed
  before retrying.
- **Inline-datum decode error at the reference UTxO.** Validators that read
  `ProtocolParams` will hard-fail if the datum doesn't decode. After 02
  confirms, sanity-check the inline datum (`cardano-cli query utxo`
  `--address <reference_holder_addr> --output-json`). Audit L-01 / L-02
  (issue #130) closed the worst version of this — the `one_shot_mint`
  policy now asserts on chain that the NFT lands at `reference_holder` and
  that the inline datum decodes as `ReferenceDatum` with `denom > 0`,
  `max_fee > 0`, `max_fee < denom`. The mint tx will bounce instead of
  bricking the protocol with a permanent malformed reference UTxO.
- **01a chain breaks mid-flight.** If tx 2 or 3 of 01a fails to confirm,
  re-run with a fresh `FUNDING_STAGE1` — the already-published ref scripts
  from the failed run cost only their funding (no protocol meaning until
  stage 2's reference UTxO exists). `addresses.json` will be overwritten on
  the re-run; the old ref-script UTxOs become orphan.
- **01b fails after 01a confirmed.** Just re-run `01b-register.sh`. It reads
  `stage1ChangeUtxo` from `addresses.json`, so as long as that UTxO is still
  on-chain the cert tx rebuilds against the same funding.
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

See [CLAUDE.md](../../CLAUDE.md) for the architectural pillars this ceremony anchors.
