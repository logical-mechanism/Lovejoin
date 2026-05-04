# lovejoin

A Cardano-native, non-custodial **privacy mixer**. Deposit a fixed amount of ADA into a shared pool, wait while the pool reshuffles, then withdraw to a fresh address. The link between your deposit and your withdrawal becomes statistically vanishing.

Lovejoin implements **Sigmajoin** ([papers/sigmajoin.pdf](papers/sigmajoin.pdf)), an outsourceable variant of **Zerojoin**, as a **hyperstructure**: the on-chain protocol is permissionless, immutable, and has no operator. Anyone can run a website. Anyone can run an indexer. Anyone can press the "mix" button.

> **Unaudited alpha · Cardano Preprod testnet only · do not use real funds.** Lovejoin has not been independently audited. Mainnet is not on the v1 release path; it is gated on a third-party audit and a bug-bounty window. Disclosure terms: [SECURITY.md](SECURITY.md).

## Who it's for

- You hold ADA on Cardano and want **on-chain financial privacy** without trusting a custodian.
- You're a developer interested in **outsourceable sigma-protocol mixing** on a UTxO chain, or in building privacy infrastructure as a hyperstructure.
- You're a researcher reviewing real-world deployments of **N-way sigma-OR proofs** on BLS12-381.

If you want destination anonymity (the address you withdraw to should also be unlinkable), pair Lovejoin with [Seedelf](https://github.com/logical-mechanism/Seedelf-Wallet). Lovejoin handles the pool side; Seedelf handles the wallet side.

## Try it

Lovejoin is in **alpha on the Cardano Preprod testnet**. No real funds are at risk. The hosted UI ships at **lovejo.in** with **preprod.lovejo.in** for staging once domain setup completes; until then, see the **Develop** section below to run the UI locally against the live Preprod deployment.

<!-- Screenshot placeholder: add docs/images/lovejoin-pool.png once captured. -->

The protocol is live, the validators are deployed, and the contracts cannot be changed. Three operations:

1. **Deposit.** Lock a fixed-denomination ADA UTxO into the pool. Each deposit also tops up a shared on-chain fee shard so future mix rounds pay for themselves.
2. **Mix.** Re-randomise N pool boxes at once into N new indistinguishable ones (`2 ≤ N`, with the practical cap calibrated empirically). Anyone can run a mix; no submitter wallet input or signature is required.
3. **Withdraw.** The original depositor pulls funds out of the pool with a Schnorr proof. No long-lived signing key for the box; the proof is the spend authorisation.

After `k` mixes at width `N`, an outsider's chance of correctly mapping your deposit to your withdrawal is `(1/N)^k`.

## What this is not

- **Not a custodian.** Your funds are protected by your wallet's signature and a proof you generate locally. We never touch your keys.
- **Not audited.** No third-party audit has been completed. The code is open; the math is in the paper. Treat the alpha as experimental.
- **Not on mainnet.** Preprod only until threat model and an external audit are signed off.
- **Not a magic wand.** Mixers raise the cost of deanonymisation; they do not make it impossible. Wallet hygiene, traffic patterns, and timing still leak signal. Treat it as one tool, not a complete privacy strategy.
- **No analytics, no telemetry, no cookies.** The backend logs IPs only for rate limiting, with sub-24-hour retention.

## Developer quickstart

The full architectural overview is in [ARCHITECTURE.md](ARCHITECTURE.md). The contributor guide is in [CONTRIBUTING.md](CONTRIBUTING.md). The conventions baked into the codebase are in [CLAUDE.md](CLAUDE.md).

Stack:

- **Contracts:** Aiken 1.1.21, Plutus V3, BLS12-381 G1.
- **Off-chain SDK:** TypeScript + mesh + `@noble/curves` (with RFC 6979 deterministic nonces).
- **Backend indexer:** Node + Fastify + ogmios chainsync (+ optional db-sync for history).
- **UI:** React 19 + Vite + Tailwind v4 + react-i18next (20 locales).
- **Reference impl:** Rust + `blst`, used to generate cross-language KAT vectors.

Requirements: **node ≥ 20** (nvm recommended; see node-binary note below), **pnpm 10**, **aiken 1.1.21**.

```sh
make install        # pnpm install across offchain/, backend/, ui/
make build          # aiken check + tsc + vite build
make test           # aiken check + vitest in offchain, backend, ui
make lint           # tsc --noEmit + eslint + prettier --check + aiken fmt --check
make ui-dev         # vite dev server on http://localhost:5173
make backend-dev    # fastify backend in watch mode
```

`make help` lists every target.

A husky `pre-commit` hook runs `lint-staged` (prettier + eslint --fix on staged files). Fix locally rather than reaching for `--no-verify`.

**Node-binary note (Linux + VSCode).** pnpm 10 errors out with `ERR_PNPM_INVALID_NODE_VERSION` when `node` resolves to the snap shim. VSCode sets `ELECTRON_RUN_AS_NODE=1`, which silently swallows `node --version`. Fix: put a real node binary first on PATH, e.g. via nvm:

```sh
export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"
```

CI uses `actions/setup-node`, so this is only a local-shell concern.

### Backend env vars

The backend (`backend/`) is the second [`ChainProvider`](offchain/src/chain/provider.ts) implementation: an ogmios chainsync indexer + db-sync history queries, exposing the same shapes the SDK consumes. Required when running the indexer / API:

```sh
NETWORK=preprod                              # preprod | mainnet | preview
PORT=3001
HOST=0.0.0.0
OGMIOS_URL=ws://localhost:1337               # WebSocket, ogmios v6
DBSYNC_URL=postgres://USER:PASS@HOST/dbname  # optional; required for /history
ADDRESSES_PATH=./artifacts/preprod/addresses.json
CORS_ORIGINS=*                               # comma-separated origins, or *
RATE_LIMIT_PER_MIN=600
```

`ADDRESSES_PATH` points at the bootstrap-produced `artifacts/<network>/addresses.json`. Without it the indexer won't know which on-chain script addresses to filter to. ogmios + db-sync run outside this repo. For Docker:

```sh
docker build -f backend/Dockerfile -t lovejoin-backend .
docker run --env-file backend/.env -p 3001:3001 -v $(pwd)/artifacts:/app/artifacts lovejoin-backend
```

## Bootstrap (one-shot, per network)

The protocol is a hyperstructure: parameters are minted into an inline datum on a permanent UTxO at the always-False `reference_holder` script, identified by a one-of-one NFT. Once that UTxO exists, the protocol is live and immutable.

Five stages under [`infra/bootstrap/`](infra/bootstrap/), one operator command each (1a + 1b are split so each half can be inspected on-chain before the next runs):

1. **`00-build-reference.sh`**: offline. Parameterises the validators in dependency order (`one_shot_mint(seed) → mix_logic(NFT) → mix_box(mix_logic) → fee_contract(NFT)`) and writes resolved hashes into `artifacts/<network>/addresses.json`.
2. **`01a-publish.sh`**: builds and signs three publish txs offline (`mix_box`, `mix_logic`, `fee_contract`) using `build-raw`, chained via change outputs, and submits them in order. Writes `referenceScriptUtxos` and `stage1ChangeUtxo` to `addresses.json`.
3. **`01b-register.sh`**: registers the `mix_logic` stake credential. Run after `01a` confirms; uses `transaction build` (auto fee + change) and references `mix_logic`'s publish output via `--certificate-tx-in-reference`.
4. **`02-mint-and-lock.sh`**: **irreversible.** Spends `SEED`, mints the one-of-one NFT, locks at `reference_holder` with the inline `ProtocolParams` datum.
5. **`03-fund-fee-contract.sh`**: seeds 10 shards at `fee_contract`.

Configure once, then run the stages:

```sh
cp infra/bootstrap/.env.example infra/bootstrap/.env     # set NETWORK + node socket
./infra/bootstrap/init-wallet.sh                         # one-time keypair + per-network addrs
# fund infra/bootstrap/wallets/payment.preprod.addr from the Preprod faucet
./infra/bootstrap/balance.sh                             # confirm the drop arrived
./infra/bootstrap/prep-utxos.sh                          # split into A/B/C/D, copy the `export` lines it prints

# After exporting FUNDING_STAGE1 / COLLATERAL / SEED / FUNDING_STAGE3, the
# stages read those env vars directly, no renaming at the call site:
./infra/bootstrap/00-build-reference.sh
./infra/bootstrap/01a-publish.sh                # 3 chained publish txs (build-raw)
# wait for confirmation
./infra/bootstrap/01b-register.sh               # register mix_logic stake cred (transaction build)
./infra/bootstrap/02-mint-and-lock.sh           # wait. IRREVERSIBLE
./infra/bootstrap/03-fund-fee-contract.sh
```

`.env` is gitignored. Every bootstrap script auto-sources it, so no `export` per shell beyond the per-stage UTxO refs.

You'll need ~150 ADA on the [Preprod faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/) and a synced cardano-node socket.

Full operator playbook (env-var setup, UTxO-layout table, chained-submit details, recovery from common failures): [`infra/bootstrap/README.md`](infra/bootstrap/README.md).

After a clean run, commit `artifacts/preprod/addresses.json`. That's the canonical address book for the network.

## Reporting issues

- **Bugs and feature requests:** [github.com/logical-mechanism/Lovejoin/issues](https://github.com/logical-mechanism/Lovejoin/issues).
- **Security disclosures:** see [SECURITY.md](SECURITY.md). Do **not** open a public issue.

## License

[MIT](LICENSE).
