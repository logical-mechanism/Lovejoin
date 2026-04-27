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

Four stages, one operator command each. Stage 1 internally chains four txs.

| # | script | what it does | tx count |
|---|--------|--------------|---------:|
| 0 | `00-build-reference.sh`           | offline. Parameterizes the validators in dependency order (`one_shot_mint(seed) → mix_logic(NFT) → mix_box(mix_logic) → fee_contract(NFT)`), writes resolved hashes to `addresses.json`. | 0 |
| 1 | `01-publish-and-register.sh`      | recursive tx chain: publishes `mix_box`, `mix_logic`, `fee_contract` as CIP-33 reference scripts (one tx per script — keeps every tx well under the 16 KiB limit as validators grow), then registers the `mix_logic` stake credential, attaching the script via `--certificate-tx-in-reference` against tx 2's output. Each tx after the first spends the previous tx's change output as funding, so the operator only supplies one funding UTxO + one collateral UTxO. | 4 |
| 2 | `02-mint-and-lock.sh`             | **irreversible.** Spends `SEED_UTXO`, mints the one-of-one NFT, locks at `reference_holder` with the inline `ProtocolParams` datum. | 1 |
| 3 | `03-fund-fee-contract.sh`         | seeds 10 shards at `fee_contract`. | 1 |

The single-script-per-tx convention inside stage 1 isolates failures (a publish
that fails costs only its own funding + fee, not the whole infrastructure
setup) and matches the recursive ref-input pattern the production txs will
use.

## Wallet

Bootstrap wallets go under `infra/bootstrap/wallets/<network>/`. That path is
gitignored, so signing keys never end up in git. Convention:

```
infra/bootstrap/wallets/preprod/
├── payment.skey      # signing key (NEVER commit)
├── payment.vkey      # verification key
└── payment.addr      # bech32 address (BOOTSTRAP_ADDR)
```

Generate one with cardano-cli:

```sh
mkdir -p infra/bootstrap/wallets/preprod && cd infra/bootstrap/wallets/preprod
cardano-cli address key-gen \
  --verification-key-file payment.vkey \
  --signing-key-file payment.skey
cardano-cli address build \
  --payment-verification-key-file payment.vkey \
  --testnet-magic 1 \
  --out-file payment.addr
cat payment.addr   # paste into the Preprod faucet
```

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

## Running it

```sh
export NETWORK=preprod
export TESTNET_MAGIC=1
export CARDANO_NODE_SOCKET_PATH=/path/to/preprod-node.socket
export BOOTSTRAP_ADDR=$(cat infra/bootstrap/wallets/preprod/payment.addr)
export PAYMENT_SKEY=infra/bootstrap/wallets/preprod/payment.skey

# Stage 0 — offline. Pick a SEED_UTXO from the wallet first; it'll be consumed
# by 02-mint-and-lock.
./contracts/build.sh config/network.preprod.json
SEED_UTXO=<txid>#<idx>           # an unspent UTxO at BOOTSTRAP_ADDR
NETWORK=$NETWORK SEED_UTXO=$SEED_UTXO ./infra/bootstrap/00-build-reference.sh

# Stage 1 — chains 4 txs (publish mix_box, mix_logic, fee_contract; register
# mix_logic). Operator provides one FUNDING_UTXO and one COLLATERAL_UTXO.
FUNDING_UTXO=<txid>#<idx> COLLATERAL_UTXO=<txid>#<idx> \
  ./infra/bootstrap/01-publish-and-register.sh

# Wait for stage 1 to confirm before continuing — addresses.json now has
# referenceScriptUtxos populated.

# Stage 2 — IRREVERSIBLE. Spends SEED_UTXO from stage 0; collateral separate.
SEED_UTXO=$SEED_UTXO COLLATERAL_UTXO=<txid>#<idx> \
  ./infra/bootstrap/02-mint-and-lock.sh
# wait for confirmation

# Stage 3 — seed 10 fee shards.
FUNDING_UTXO=<txid>#<idx> ./infra/bootstrap/03-fund-fee-contract.sh
```

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
