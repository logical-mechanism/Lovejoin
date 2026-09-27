# Bootstrap

One-shot ceremony per network. Takes the protocol from compiled code to live,
immutable on-chain state.

Switching between preprod / preview / mainnet / private-testnet is a single
`NETWORK=` line in `.env`. Every script sources `_lib/network.sh`, which
derives the right `cardano-cli` flag (`--testnet-magic 1`, `--testnet-magic 2`,
`--mainnet`, or `--testnet-magic $TESTNET_MAGIC`). For `mainnet` the helper
also refuses to run unless `LOVEJOIN_MAINNET_CONFIRM=yes` is set as a tripwire
against accidental real-money runs.

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
$EDITOR infra/bootstrap/.env        # set NETWORK + CARDANO_NODE_SOCKET_PATH
                                    # (mainnet also needs LOVEJOIN_MAINNET_CONFIRM=yes)

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
- **Mainnet.** None of these scripts default to mainnet. `_lib/network.sh`
  refuses to run with `NETWORK=mainnet` unless `LOVEJOIN_MAINNET_CONFIRM=yes`
  is set, so a stale shell or typo can't burn a real seed UTxO. The actual
  mainnet posture for this protocol — no third-party audit, no bug bounty,
  same on-chain code as Preprod — is in [SECURITY.md](../../SECURITY.md);
  this guard is a procedural safety net, not a release gate.

## Automated mainnet launch through Koios

`koios-launch.py` is the mainnet-only path for a one-time wallet. It uses public
[Koios](https://www.koios.rest/guide/introduction.html) for UTxOs, current
protocol parameters, transaction submission, and confirmation. `cardano-cli`
builds and signs locally; Aiken parameterizes the same validators as the
Preprod ceremony. No node socket, Blockfrost key, or frontend change is needed.
The existing shell stages above remain the manual Preprod path.

The mainnet launch publishes three reference scripts, registers the mix-logic
stake credential, and mints and locks the reference NFT. **It never creates or
funds fee UTxOs.** There is no full-launch option. Mainnet's informational
`fee_shard_target` is zero and the address book records `feeShardUtxos: []`.
The fee-contract reference script is published at the launch wallet, alongside
the other reference scripts; this is not a fee-pool output. The manual
`03-fund-fee-contract.sh` also refuses mainnet.

Deposits can run without shards. Mixes need the existing wallet-paid fee mode;
shard-paid mixing and the Mix This Box shortcut require a funded shard pool.
Wallet-paid fan-out is limited to supported wallets. The launcher does not
activate mainnet in the frontend.

**Fund at least 105 ADA**: 85 ADA for publication and registration, 10 ADA
collateral, 7 ADA for the mint seed, and 3 ADA for preparation fees and initial
change. Three 25 ADA reference outputs, the 5 ADA NFT output, and the current
2 ADA stake deposit remain on chain (82 ADA total). The final sweep sends the
remaining wallet balance, including the unused collateral, to the return
address after deducting transaction fees. The 105 ADA requirement is the
launcher's funding plan; the ledger's minimum output amounts are checked
against current Koios parameters. Funding 110 ADA provides extra headroom.

The launch has three distinct operator actions:

```sh
# 1. When ready to receive funds, create an isolated wallet offline.
./infra/bootstrap/koios-launch.py wallet

# 2. Send at least 105 ADA to its addr1... address, then inspect the balance.
./infra/bootstrap/koios-launch.py status

# 3. Only after explicitly deciding to launch, set the return address.
LOVEJOIN_MAINNET_CONFIRM=yes ./infra/bootstrap/koios-launch.py launch \
  --return-address addr1... --confirm-mainnet-launch
```

The wallet command only creates a keypair and mainnet address. Funding it does
not submit any launch transaction. `launch` is the only command that submits.
The return address must be a different key-controlled mainnet payment address.
The launcher verifies the signing key and pins both addresses and the contract
hashes in a private resume journal. A wallet lock prevents concurrent runs.

Before spending funding, the launcher saves the signed preparation transaction,
uses its future seed output to compile and parameterize the contracts, and
checks their hashes and reference-output minimum amounts. It then waits for
two Koios confirmations between stages, rejects spent outputs, and verifies
the reference scripts, registered stake credential, NFT and inline datum,
and final refund. The three reference-script outputs remain at the launch
wallet; they must stay unspent for the published references to work. Keep the
launch signing key private because it can spend those outputs.

Signed transactions, evaluation receipts, and the resume journal stay under
gitignored `infra/bootstrap/wallets/mainnet-launch/`. If submission or
confirmation fails, rerun the **same** launch command. The journal verifies
the exact saved transaction before reusing it. Do not create a different
wallet or remove the journal midway through the ceremony. Before submitting
the stake registration and NFT mint, the launcher simulates each through
Koios's Ogmios evaluator, allocates execution budgets above measured costs,
and checks the final transaction. A saved script transaction is evaluated
again before resubmission. A failed Plutus validation can consume up to 2 ADA
of collateral; the launcher checks that amount against the current collateral
percentage and transaction fee.

After a successful run, review and commit `artifacts/mainnet/addresses.json`
and the five `artifacts/mainnet/*.plutus` files. The address book records the
seed, script hashes, reference NFT, reference-script UTxOs, an empty fee-shard
list, stage transaction IDs, script evaluation results, and the refund address
and amount. It is created during preflight and updated as stages are confirmed;
only a completed book contains `deploymentTxs.sweep`. Never commit the wallet
directory or signed transactions. Mainnet's immutable reference datum uses a
10 ADA denomination and 0.8 ADA maximum fee per mix, matching
`config/network.mainnet.json`.

### Launch validation without submission

The offline safety tests cover submission guards, spent outputs, failed
preflight, journal integrity, concurrent launches, and evaluator failures:

```sh
python3 -m unittest discover -s infra/bootstrap -p 'test_koios_launch.py'
```

An optional rehearsal uses actual Aiken and cardano-cli, current mainnet
protocol parameters, and read-only Koios evaluation. It creates temporary test
keys and fictitious inputs in an isolated copy, intercepts every submission,
and simulates an interruption after each accepted stage before resuming.
HTTP access is restricted to parameter queries and script evaluation. It
checks transaction balance, collateral, output sizes, empty fee funding, and
the final refund:

```sh
LOVEJOIN_KOIOS_REHEARSAL=1 python3 -m unittest discover -s infra/bootstrap \
  -p 'test_koios_rehearsal.py'
```

This rehearsal does not broadcast transactions or generate a real launch
wallet. Ogmios evaluation checks Plutus execution; it does not execute every
ledger rule, so the rehearsal cannot guarantee future transaction acceptance.

## Practice run

Before doing the canonical Preprod bootstrap, do at least one full run on a
private wallet and verify each artifact. The mint is one-shot per `(seed,
network)` — once you've spent the seed, you can't reuse it. On Preprod
that's fine (request more faucet ADA), but the practice helps you catch
parameter mismatches before the canonical run lands.

See [CLAUDE.md](../../CLAUDE.md) for the architectural pillars this ceremony anchors.
