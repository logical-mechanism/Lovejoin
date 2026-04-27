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
