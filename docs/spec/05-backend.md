# 05 — Backend

## What the backend does

1. **Indexes** the mix-box pool: in-memory snapshot of all unspent UTxOs at `mixScriptAddr`.
2. **Indexes the fee contract shards**: tracks each of the ~10 fee UTxOs separately so the SDK can pick one with sufficient balance.
3. **Caches the reference UTxO** so clients can fetch protocol params without hitting db-sync each time.
4. **Serves all of the above** via a small REST API.
5. **Tracks mix history per box** for the UI's generation indicator (public chain data only).

There is no mixer-bot in v1. Every user mixes from the UI; see [06-ui.md](06-ui.md). Mixer-bot is M8+.

## Components

```
backend/
  package.json
  src/
    index.ts                     # entrypoint, wires everything
    config.ts                    # env vars: ogmios URL, dbsync DSN, network, addresses path
    indexer/
      ogmios.ts                  # chainsync subscription
      pool.ts                    # mix-box pool model
      fee.ts                     # fee shard model (10 UTxOs)
      reference.ts               # reference UTxO + cached params
      reorg.ts                   # rollback handling
    db/
      dbsync.ts                  # raw SQL queries against db-sync
    api/
      server.ts                  # Fastify
      routes/
        pool.ts                  # GET /pool
        box.ts                   # GET /box/:txhash/:idx
        fee.ts                   # GET /fee
        history.ts               # GET /history/:address
        params.ts                # GET /params
        health.ts
  test/
    indexer.spec.ts
    api.spec.ts
```

## Environment / config

`.env`:
```
OGMIOS_URL=ws://localhost:1337
DBSYNC_URL=postgres://...
NETWORK=preprod
ADDRESSES_PATH=./artifacts/preprod/addresses.json
PORT=3001
```

`addresses.json` is the canonical handoff from the contract bootstrap step. Backend, SDK, and UI all consume it. Includes:
- Reference NFT policy + asset name
- Reference UTxO ref
- mix_box and fee_contract script addresses + hashes

We assume ogmios and db-sync are externally provisioned and reachable.

## Indexer

### Chainsync via ogmios

Subscribe to `chainSync` at the configured ogmios URL. For each block:

1. Filter txs touching `mixScriptAddr` or `feeScriptAddr`.
2. For consumed inputs at `mixScriptAddr`: remove from `pool`.
3. For new outputs at `mixScriptAddr`: parse inline datum, validate shape, add to `pool`.
4. For consumed inputs at `feeScriptAddr`: locate the shard in `feeShards` by UTxO ref, mark replaced.
5. For new outputs at `feeScriptAddr`: add to `feeShards` (this also covers Replenish-replaced shards reappearing under a new UTxO id).
6. On rollback: replay diffs from the last 2k-block checkpoint.

### Models

```ts
type PoolEntry = {
  txHash: string;
  outputIndex: number;
  datum: MixDatum;       // {a: hex, b: hex}
  slot: number;
  generation: number;
};
type Pool = Map<utxoId, PoolEntry>;

type FeeShard = {
  txHash: string;
  outputIndex: number;
  lovelace: bigint;
  slot: number;
};
type FeeState = {
  shards: FeeShard[];        // unordered
  totalLovelace: bigint;
  estimatedMixesAvailable: number;   // floor(totalLovelace / maxFeePerMix)
};

type ReferenceState = {
  utxoRef: TxOutRef;
  params: ProtocolParams;
  lastSeenSlot: number;       // ensures we noticed the reference UTxO; if it disappears, alarm
};
```

Memory: tens of MB at most for a 100k-box pool. Trivial.

### `generation` tracking

When a Mix tx is observed (2 inputs at mix → 2 outputs at mix), set both outputs' `generation = max(input0.generation, input1.generation) + 1`. UI metric only.

### Rollback handling

ogmios `RollBackward` events; we keep last 2k blocks of pool + fee diffs. Deeper rollbacks restart from the last safe checkpoint.

### Reference-UTxO sanity

The reference UTxO should never be spent (validator is False). If we ever observe its UTxO id disappearing without a corresponding rollback, the indexer raises a P0 alarm and refuses to serve `/params`. This indicates either a chain anomaly or a spec-violating tx (which would also fail validation).

## REST API

All endpoints return JSON. No auth. Fastify rate limit per IP.

### `GET /pool`

```json
{
  "tip": { "slot": 12345, "blockHash": "..." },
  "size": 1234,
  "boxes": [{
    "txHash": "...", "outputIndex": 0,
    "a": "0x...", "b": "0x...",
    "generation": 12, "createdSlot": 12300
  }, ...]
}
```

Paginated for pools > 1000 (`?cursor=...&limit=500`).

### `GET /pool/light`
Just `{txHash, outputIndex, a, b}[]` — minimal payload for browser-side ownership scanning.

### `GET /box/:txhash/:idx`
Detail view + lineage.

### `GET /fee`

```json
{
  "totalLovelace": "12300000",
  "shardCount": 10,
  "shards": [
    { "txHash": "...", "outputIndex": 0, "lovelace": "1500000" },
    ...
  ],
  "maxFeePerMix": "800000",
  "estimatedMixesAvailable": 15
}
```

The SDK uses the `shards` array for shard selection. UI uses `totalLovelace` and `estimatedMixesAvailable`.

### `GET /history/:address?limit=50`
For a destination address, recent withdrawal txs.

### `GET /health`
```json
{ "ok": true, "tip": {...}, "lagSeconds": 3, "referenceUtxoOk": true }
```

UI banners on `lagSeconds > 60` or `referenceUtxoOk == false`.

### `GET /params`

```json
{
  "network": "preprod",
  "denomLovelace": "10000000",
  "maxFeePerMix": "800000",
  "defaultMixRounds": 30,
  "minMixRounds": 5,
  "feeShardTarget": 10,
  "mixScriptAddress": "addr1...",
  "feeScriptAddress": "addr1...",
  "referenceUtxo": { "txHash": "...", "outputIndex": 0 },
  "referenceNft": { "policyId": "...", "assetName": "..." }
}
```

Pulled from the cached reference UTxO datum + addresses.json. UI consumes on load.

## db-sync usage

ogmios is primary for live state. db-sync supplements:

- Initial sync: bulk SQL load instead of replaying chainsync from genesis.
- Address history queries (`GET /history/:address`).
- Box detail by ID.

Sample queries: `backend/src/db/queries.sql`.

## Operations notes

- ogmios + db-sync + cardano-node maintained outside this repo, on Preprod for v1.
- Local dev: connect directly to a reachable Preprod ogmios and db-sync via env vars.
- Production target: same Preprod first, then mainnet after audit. Host plan deferred (OQ-K).
