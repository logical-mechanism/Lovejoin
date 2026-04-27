# lovejoin

A Cardano implementation of the **Sigmajoin** privacy mixer ([papers/sigmajoin.pdf](papers/sigmajoin.pdf)), an outsourceable variant of **Zerojoin** ([papers/zerojoin.pdf](papers/zerojoin.pdf)).

A hyperstructure: the on-chain protocol is permissionless and immutable. Anyone can run a UI or backend.

Three things the protocol does:

1. **Deposit** — send a fixed-denomination ADA UTxO into the pool, replenishing one of ~10 fee-contract shards with `N_rounds · MAX_FEE_PER_MIX` lovelace to fund future mix rounds.
2. **Mix** — any user re-randomizes **N pooled UTxOs** at once (`2 ≤ N ≤ max_n`) into N new indistinguishable ones. The tx fee is paid out of a fee-contract shard; collateral comes from a collateral provider service. **No submitter wallet input or signature required** — the Mix tx is fully wallet-anonymous.
3. **Withdraw** — the original depositor pulls funds out of the pool by Schnorr proof (no signer key required for the box; Seedelf-style). Pair with [Seedelf](https://github.com/logical-mechanism/Seedelf-Wallet) for full wallet-layer destination anonymity.

Privacy comes from chaining many mixes: an outsider's chance of mapping deposit to withdrawal is `(1/N)^k` after k rounds at width N. Higher N reaches the same anonymity in fewer txs.

## Stack

- Contracts: **Aiken 1.1.21** (Plutus V3, BLS12-381 G1 builtins). Three validators + one minting policy:
  - `reference_holder` — always-False, locks the protocol NFT and `ProtocolParams` datum (the hyperstructure anchor).
  - `one_shot_mint` — minting policy parameterized by a seed UTxO; mints exactly one NFT exactly once.
  - `mix_box` — pool box validator. Owner via Schnorr proof; mix via **N-way sigma-OR proof** for variable N.
  - `fee_contract` — shared fee pool sharded across ~10 UTxOs. Two redeemer paths: `PayMixFee`, `Replenish`.
- Off-chain: **TypeScript** + **mesh** + **@noble/curves** (with RFC 6979 deterministic nonces) + collateral-provider client (default: [giveme.my](https://giveme.my/)).
- Backend: **ogmios** chainsync + **db-sync** queries (assumed always-on).
- UI: **React** + **Tailwind**, CIP-30 wallets, **react-i18next** from day one. N-width slider on the Pool screen.
- Network: **Preprod** for v1; bootstrap via **cardano-cli** + **cardano-node**.

Denomination, max fee per mix, `max_n`, and other parameters are read from `config/network.json` and locked into the on-chain reference UTxO at bootstrap.

## Spec

The full design lives in [docs/spec/](docs/spec/):

- [00-overview.md](docs/spec/00-overview.md) — system overview, goals, architecture
- [01-protocol.md](docs/spec/01-protocol.md) — Sigmajoin on Cardano (variable N, collateral provider)
- [02-cryptography.md](docs/spec/02-cryptography.md) — BLS12-381, Schnorr, DH-tuple, N-way Sigma-OR, RFC 6979
- [03-contracts.md](docs/spec/03-contracts.md) — Aiken validators (reference + mix-box + fee contract)
- [04-offchain.md](docs/spec/04-offchain.md) — TS library, prover, tx builder, collateral provider client
- [05-backend.md](docs/spec/05-backend.md) — indexer, API
- [06-ui.md](docs/spec/06-ui.md) — React frontend (user-as-mixer + N-slider + i18n)
- [07-testing.md](docs/spec/07-testing.md) — Preprod, integration, fuzz, max_n calibration
- [08-threat-model.md](docs/spec/08-threat-model.md) — adversaries, attacks, mitigations
- [09-milestones.md](docs/spec/09-milestones.md) — realistic build plan, M0–M7
- [10-glossary.md](docs/spec/10-glossary.md) — terms
- [11-open-questions.md](docs/spec/11-open-questions.md) — most resolved; deferred items
- [12-build-guide.md](docs/spec/12-build-guide.md) — practical execution plan: order of attack, risk management, common pitfalls

## Status

Pre-alpha. Foundations and tooling (M0) landed; cryptography (M1) is next. See [milestones.json](milestones.json).

## Develop

Requirements:

- **node ≥ 20** (nvm recommended — see node-binary note below)
- **pnpm 10**
- **aiken 1.1.21** (pinned in [contracts/aiken.toml](contracts/aiken.toml))

One-time install of workspace deps:

```sh
make install        # pnpm install across offchain/, backend/, ui/
```

Day-to-day:

```sh
make build          # aiken check + tsc + vite build
make test           # aiken check + vitest in offchain, backend, ui
make contracts      # just `aiken check`
make ui-dev         # vite dev server on http://localhost:5173
make backend-dev    # fastify backend in watch mode
make clean          # remove dist/, build/, target/
```

`make help` lists everything.

**Node-binary note (Linux + VSCode).** pnpm 10 errors out with `ERR_PNPM_INVALID_NODE_VERSION` when `node` resolves to the snap shim — VSCode sets `ELECTRON_RUN_AS_NODE=1`, which silently swallows `node --version`. Fix: put a real node binary first on PATH, e.g. via nvm:

```sh
export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"
```

CI uses `actions/setup-node`, so this is only a local-shell concern.

## Building it

Milestones live in [milestones.json](milestones.json). Inside Claude Code:

- `/milestones` — list remaining milestones and pick one
- `/work <id>` — work on a milestone end-to-end (reads spec, implements, writes tests, verifies exit criteria, marks done)

Both commands read/update milestones.json directly. No external CLI. State transitions: `pending` → `in-progress` → `done`. The slash commands enforce that exit criteria pass before a milestone can be marked done.

## Bootstrap (one-shot, per network)

The protocol is a hyperstructure: parameters are minted into an inline datum on a permanent UTxO at the always-False `reference_holder` script, identified by a one-of-one NFT. Once that UTxO exists, the protocol is live and immutable.

Four stages under [`infra/bootstrap/`](infra/bootstrap/) — one operator command each:

1. **`00-build-reference.sh`** — offline. Parameterizes the validators in dependency order (`one_shot_mint(seed) → mix_logic(NFT) → mix_box(mix_logic) → fee_contract(NFT)`) and writes resolved hashes into `artifacts/<network>/addresses.json`.
2. **`01-publish-and-register.sh`** — recursive tx chain (4 txs internally): publishes `mix_box`, `mix_logic`, `fee_contract` as CIP-33 reference scripts (one tx per script, so every tx stays under the 16 KiB max-tx-size as the validators grow), then registers the `mix_logic` stake credential by referencing the script published in tx 2 via `--certificate-tx-in-reference`. Each tx spends the previous tx's change output as funding — operator only supplies one funding UTxO and one collateral UTxO.
3. **`02-mint-and-lock.sh`** — **irreversible.** Spends `SEED_UTXO`, mints the one-of-one NFT, locks at `reference_holder` with the inline `ProtocolParams` datum.
4. **`03-fund-fee-contract.sh`** — seeds 10 shards at `fee_contract`.

Recommended path is one command:

```sh
./infra/bootstrap/init-wallet.sh                         # one-time keypair + per-network addrs
# fund infra/bootstrap/wallets/payment.preprod.addr from the Preprod faucet
./infra/bootstrap/run.sh                                 # split → 0 → 1 → 2 → 3, with waits
```

`run.sh` orchestrates the whole bootstrap with confirmation polling between stages, so you can walk away while it runs. It calls these helpers, all of which work standalone for debugging or recovery:

- **`init-wallet.sh`** — generates one payment keypair under `infra/bootstrap/wallets/` (gitignored) and derives a per-network address file (preprod + preview by default; mainnet via `--include-mainnet`). Idempotent.
- **`balance.sh`** — pretty-prints the wallet's UTxOs and total ADA.
- **`prep-utxos.sh`** — splits the faucet drop into the four UTxO shapes the stages need (FUNDING_STAGE1, COLLATERAL, SEED, FUNDING_STAGE3) and prints copy-pasteable `export` lines + per-stage commands. Idempotent.

You'll need ~150 ADA on the [Preprod faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/) and a synced cardano-node socket.

Full operator playbook (env-var setup, UTxO-layout table, chained-submit details, recovery from common failures): [`infra/bootstrap/README.md`](infra/bootstrap/README.md).

After a clean run, commit `artifacts/preprod/addresses.json` — that's the canonical address book for the network.
