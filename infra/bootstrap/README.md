# Bootstrap

One-shot ceremony per network. Takes the protocol from compiled code to live,
immutable on-chain state.

After bootstrap finishes:

- A one-of-one NFT (the **reference NFT**) lives forever at the always-False
  `reference_holder` script address, with an inline `ProtocolParams` datum.
- The `mix_logic` stake credential is registered (so withdraw-zero spends are
  valid going forward).
- `mix_box`, `mix_logic`, and `fee_contract` are published as CIP-33 reference
  scripts so future Mix txs cite them via `--tx-in-reference` instead of
  inlining ~5 KiB of script per tx.
- 10 fee-contract shards are seeded at `fee_contract`.
- `artifacts/<network>/addresses.json` holds the canonical address book — it
  gets committed to git after a clean run.

## Stages

Six stages, one tx per stage. Single-script-per-tx isolates failures (a stage
that fails costs only its own funding + fee, not the whole infrastructure
setup), keeps per-tx size predictable as the validators grow, and matches the
recursive ref-input pattern the production txs use.

| # | script | what it does |
|---|--------|--------------|
| 0 | `00-build-reference.sh`         | offline. Parameterizes the validators in dependency order (`one_shot_mint(seed) → mix_logic(NFT) → mix_box(mix_logic) → fee_contract(NFT)`), writes resolved hashes to `addresses.json`. |
| 1 | `01-publish-mix-box.sh`         | publishes `mix_box.plutus` as a CIP-33 reference script. |
| 2 | `02-publish-mix-logic.sh`       | publishes `mix_logic.plutus` as a CIP-33 reference script. |
| 3 | `03-publish-fee-contract.sh`    | publishes `fee_contract.plutus` as a CIP-33 reference script. |
| 4 | `04-register-mix-logic.sh`      | registers the `mix_logic` stake credential. The cert references the script via `--certificate-tx-in-reference` (UTxO from stage 2), so we exercise the same recursive-chain shape the production Mix txs will use. |
| 5 | `05-mint-and-lock.sh`           | **irreversible.** Spends the seed UTxO, mints the one-of-one NFT, locks at `reference_holder` with the inline `ProtocolParams` datum. |
| 6 | `06-fund-fee-contract.sh`       | seeds 10 shards at `fee_contract`. |

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
cat payment.addr   # paste this into the Preprod faucet
```

Fund it from the [Preprod faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/).
Budget for a clean Preprod bootstrap (defaults assumed):

| stage | what                              | ≈ ADA |
|-------|-----------------------------------|------:|
| 1–3   | three ref-script outputs          | 75    |
| 4     | cert deposit                      |  2    |
| 5     | reference UTxO @ reference_holder |  5    |
| 6     | 10 fee shards × `max_fee × 5`     | 40    |
|       | per-tx fees + collateral float    | 10    |
| **total** |                               | **≈ 132** |

Round up to ~150 ADA so you don't have to top up mid-bootstrap.

## Running it

Typical sequential flow — submit each stage and wait for it to confirm before
running the next. `cardano-cli query utxo --address $(cat
infra/bootstrap/wallets/preprod/payment.addr) --testnet-magic 1` shows the
wallet state and lets you pick the next stage's `FUNDING_UTXO`.

```sh
export NETWORK=preprod
export TESTNET_MAGIC=1
export CARDANO_NODE_SOCKET_PATH=/path/to/preprod-node.socket
export BOOTSTRAP_ADDR=$(cat infra/bootstrap/wallets/preprod/payment.addr)
export PAYMENT_SKEY=infra/bootstrap/wallets/preprod/payment.skey

# Stage 0 — offline. Pick a SEED_UTXO from the wallet first; it'll be consumed
# by 05-mint-and-lock.
./contracts/build.sh config/network.preprod.json
SEED_UTXO=<txid>#<idx>           # an unspent UTxO at BOOTSTRAP_ADDR
NETWORK=$NETWORK SEED_UTXO=$SEED_UTXO ./infra/bootstrap/00-build-reference.sh

# Stage 1 — publish mix_box ref script. (~30 ADA from FUNDING_UTXO.)
FUNDING_UTXO=<txid>#<idx> ./infra/bootstrap/01-publish-mix-box.sh

# Stage 2 — publish mix_logic ref script.
FUNDING_UTXO=<txid>#<idx> ./infra/bootstrap/02-publish-mix-logic.sh

# Stage 3 — publish fee_contract ref script.
FUNDING_UTXO=<txid>#<idx> ./infra/bootstrap/03-publish-fee-contract.sh

# Stage 4 — register mix_logic stake credential. Uses mix_logic ref script
# (from stage 2) as ref input. Needs collateral.
FUNDING_UTXO=<txid>#<idx> COLLATERAL_UTXO=<txid>#<idx> \
  ./infra/bootstrap/04-register-mix-logic.sh

# Stage 5 — IRREVERSIBLE. Spends SEED_UTXO from stage 0; collateral separate.
SEED_UTXO=$SEED_UTXO COLLATERAL_UTXO=<txid>#<idx> \
  ./infra/bootstrap/05-mint-and-lock.sh

# Stage 6 — seed 10 fee shards.
FUNDING_UTXO=<txid>#<idx> ./infra/bootstrap/06-fund-fee-contract.sh
```

Then commit:

```sh
git add artifacts/preprod/addresses.json
git commit -m "bootstrap(preprod): mint NFT <policy>, ref UTxO <txid>#<idx>"
```

### Tx-chaining (optional, for a one-block bootstrap)

You can shorten the wall-clock time by **chaining** the publish + register
stages: each subsequent tx spends the previous tx's change output, all 4 are
built before any are submitted, then submitted in order. Cardano accepts the
chain because the inputs are valid as soon as the predecessor settles —
they all confirm together in the same block window.

The current scripts don't auto-chain (they call `cardano-cli transaction
build` per-stage, which queries the node for the input UTxO and would fail
on a not-yet-on-chain change output). To chain manually:

1. Run stage 1 with `--out-file` only (don't submit). Note the txid + change
   index.
2. For stage 2's `FUNDING_UTXO`, pass `<stage1_txid>#<change_idx>`. Run
   stage 2 with `--out-file` only.
3. Repeat for stages 3 and 4.
4. Submit all 4 raw txs in order.

The mint-and-lock (stage 5) and fee-contract funding (stage 6) are
independent and can stay sequential. We may add a `01-04-publish-chain.sh`
wrapper later that does this end-to-end.

## What can go wrong

- **Seed UTxO consumed by the wrong tx.** The `one_shot_mint(seed)` policy
  fires only if `seed` is in the inputs of the mint tx. If 05 fails for any
  reason and the seed got spent in a different tx, you have to start over
  with a different seed. Re-run `00-build-reference.sh` with the new seed
  before retrying the rest.
- **Inline-datum decode error at the reference UTxO.** Validators that read
  `ProtocolParams` will hard-fail if the datum doesn't decode. After 05
  confirms, sanity-check the inline datum (`cardano-cli query utxo`
  `--address <reference_holder_addr> --output-json`) before doing anything
  else.
- **Stake registration cert deposit refund.** If you ever needed to recover
  the ~2 ADA cert deposit, you'd have to deregister the credential.
  `mix_logic.publish` rejects deregistration (Rule 2 hyperstructure stance),
  so you're not getting that ADA back. Treat it as a one-time donation to
  the protocol.
- **Stage 4 fails because stage 2 hasn't confirmed.** `--certificate-tx-in-
  reference` resolves at build time against the node's known UTxO set. If
  you run stage 4 too quickly after stage 2, the ref input doesn't exist
  yet. Wait for stage 2 to confirm (or chain manually as described above).
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
