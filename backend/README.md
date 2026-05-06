# backend (`@lovejoin/backend`)

Node + Fastify backend for Lovejoin. An ogmios chainsync indexer keeps an in-memory view of the live mix-box pool, fee shards, and reference UTxO; a small REST API serves it to the SDK and UI under the same `ChainProvider` shape that `BlockfrostProvider` exposes.

This README is the quickstart; [CLAUDE.md](../CLAUDE.md) carries the conventions and constraints.

## What's here

```
src/
  index.ts             Wires config + state + indexer runtime + Fastify server.
  config.ts            Env-driven config + addresses.json loader.
  address.ts           Network-scoped address helpers (mix-box, fee-contract, reference).
  indexer/
    runtime.ts         Ogmios chainsync loop driving the state.
    state.ts           In-memory pool / fee shards / reference state with reorg handling.
    ogmios.ts          Chainsync client.
    ogmios-tx.ts       Tx submission helper.
    mempool.ts         Pending-tx poller (ogmios MempoolMonitor).
    datum.ts           Inline-datum decoders (MixDatum + ProtocolParams).
    types.ts           Shared shapes.
  db/
    dbsync.ts          Postgres dbsync client (history queries).
    blockfrost-history.ts  Blockfrost fallback when DBSYNC_URL is unset.
  api/
    server.ts          Fastify routes + CORS + rate limiting.
test/                  vitest suites per module + load + reorg + mempool harnesses.
Dockerfile             Multi-stage build for production deploys.
```

## Run locally

The indexer needs a running ogmios that points at a synced cardano-node on the same network. The history endpoints need either a db-sync database or a Blockfrost project id as a fallback.

```sh
cp .env.example .env                                  # repo root
$EDITOR .env                                           # set OGMIOS_URL etc.
pnpm install                                           # once
pnpm --filter @lovejoin/backend dev                    # tsx --watch
```

From the repo root: `make backend-dev` does the same and sources `../.env` automatically.

### Required env vars

| Var                                                  | Purpose                                                                                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `OGMIOS_URL`                                         | `ws://host:port` of the ogmios server (default `ws://localhost:1337`).                                                                        |
| `NETWORK`                                            | `preprod` (default), `preview`, or `mainnet`.                                                                                                 |
| `ADDRESSES_PATH`                                     | Path to bootstrap `addresses.json`. Defaults to `artifacts/<network>/addresses.json`.                                                         |
| `DBSYNC_URL`                                         | Postgres connection string for cardano-db-sync. Optional.                                                                                     |
| `BLOCKFROST_PROJECT_ID`                              | Fallback used by `/history/*` when `DBSYNC_URL` is unset.                                                                                     |
| `BLOCKFROST_PROJECT_ID_<NET>`                        | Network-suffixed override (`_PREPROD`, `_MAINNET`).                                                                                           |
| `PORT`, `HOST`                                       | Fastify bind. Default `3000` on `0.0.0.0`.                                                                                                    |
| `CORS_ORIGINS`                                       | Comma-separated allow-list. Empty = same-origin only.                                                                                         |
| `RATE_LIMIT_PER_MIN`                                 | Per-IP rate limit. IPs are kept for rate-limit only and dropped within 24h (no logs).                                                         |
| `BOOTSTRAP_START_SLOT` + `BOOTSTRAP_START_BLOCKHASH` | Skip-ahead chainsync intersection so a fresh backend doesn't replay 3 years of preprod from genesis. Resolved from `addresses.json` if unset. |

## API surface

All routes are GET unless noted. Full schemas in .

| Route              | Returns                                                                |
| ------------------ | ---------------------------------------------------------------------- |
| `/health`          | Liveness + chainsync tip.                                              |
| `/params`          | Protocol-params summary (denomination, max-fee-per-mix, addresses).    |
| `/protocol-params` | Cardano protocol parameters for fee estimation.                        |
| `/pool`            | Live mix-boxes (full datum). Paginated.                                |
| `/pool/light`      | Live mix-boxes (UTxO ref + lovelace only). Cheap polling.              |
| `/fee`             | The 10 fee-contract shards.                                            |
| `/mempool/inputs`  | UTxO refs currently spent in mempool. Used to filter selectable boxes. |
| `/history/...`     | dbsync- or Blockfrost-backed historical lookups.                       |
| `POST /submit`     | Forwards a CBOR tx through ogmios.                                     |

The backend is the second [`ChainProvider`](../offchain/src/chain/provider.ts) implementation. Anything new the SDK needs from chain goes on that interface so both `BlockfrostProvider` and `BackendProvider` grow together.

## Day-to-day

```sh
pnpm --filter @lovejoin/backend dev          # tsx --watch
pnpm --filter @lovejoin/backend build        # tsc → dist/
pnpm --filter @lovejoin/backend test         # vitest run (no live ogmios needed)
pnpm --filter @lovejoin/backend typecheck
pnpm --filter @lovejoin/backend lint         # tsc + eslint
```

Tests use synthetic ogmios fixtures and an env-injected config; they run in CI without external services.

## Privacy posture

No analytics. No telemetry. No cookies. The only request data the backend keeps in memory is the per-IP rate-limit counter, which expires within 24h. See §"Privacy UX rules".
