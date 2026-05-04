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
  datum: MixDatum; // {a: hex, b: hex}
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
  shards: FeeShard[]; // unordered
  totalLovelace: bigint;
  estimatedMixesAvailable: number; // floor(totalLovelace / maxFeePerMix)
};

type ReferenceState = {
  utxoRef: TxOutRef;
  params: ProtocolParams;
  lastSeenSlot: number; // ensures we noticed the reference UTxO; if it disappears, alarm
};
```

Memory: tens of MB at most for a 100k-box pool. Trivial.

### `generation` tracking

When a Mix tx is observed (2 inputs at mix → 2 outputs at mix), set both outputs' `generation = max(input0.generation, input1.generation) + 1`. UI metric only.

### Rollback handling

ogmios `RollBackward` events; we keep last 2k blocks of pool + fee diffs. Deeper rollbacks (or an `intersection: "origin"` past the indexer's tip) trigger an in-process reprime from db-sync (issue #87) when `DBSYNC_URL` is set; otherwise the runtime goes fatal and the supervisor restarts the container.

### Cold-start prime

A fresh backend prime-loads the live pool, fee shards, and reference-NFT location from db-sync at db-sync's latest stable block, then resumes chainsync from that point. Cold-start latency is bounded by pool size (tens of MB), independent of chain length. The same prime path runs on `DeepRollbackError` recovery, so deep reorgs no longer escalate to a supervisor restart.

Configured via `INDEXER_COLD_START`:

- `prime` (default): bulk-load from db-sync, fall back to the legacy `bootstrapStartPoint` replay if `DBSYNC_URL` is unset or the prime query fails.
- `replay`: skip the prime entirely and walk forward from `bootstrapStartPoint` (legacy path; useful for debugging the chainsync loop in isolation).

Trade-offs:

- Per-box `generation` resets to 0 on prime — generation is a UI privacy-budget metric only and isn't persisted by db-sync; the indexer recomputes it on subsequent forward Mix txs.
- A primed entry's rollback buffer is empty until forward chainsync repopulates it, so any rollback to a slot before the prime tip surfaces as `DeepRollbackError` and triggers a fresh reprime.
- `bootstrapStartPoint` remains as a fallback so deploys without `DBSYNC_URL` (or with a degraded db-sync) still come up.

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
{
  "ok": true,
  "tip": { "slot": 12345, "blockHash": "..." },
  "chainTip": { "slot": 12350, "blockHash": "...", "height": 100 },
  "lagSeconds": 5,
  "referenceUtxoOk": true,
  "runtimeRunning": true,
  "runtimeError": null,
  "chainsyncReconnect": { "inProgress": false, "attempts": 0, "lastErrorAt": 0, "lastErrorMessage": "" },
  "mempoolReconnect": { ... },
  "indexerOrigin": { "source": "primed", "reprimeCount": 1, "lastAt": 1700000000000, "lastErrorMessage": "" }
}
```

UI banners on `lagSeconds > 60` or `referenceUtxoOk == false`. Operators read `indexerOrigin.source` to confirm cold-start prime engaged on deploy (`primed` for the fast path, `replayed` for the legacy chainsync walk).

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

- **Cold-start prime + deep-rollback reprime** (issue #87): one bulk query at startup loads live mix-box UTxOs, fee shards, and the reference-NFT location at db-sync's latest stable block; chainsync resumes from that point. Same query is reused as the runtime's `reprime` callback so `DeepRollbackError` recovers in-process.
- Tx-hash exact-match lookups: `GET /tx/:hash` (confirmation summary) and `GET /tx/:hash/utxos` (resolves SDK `getUtxoByRef`).

Address-scoped queries (`/utxos/:address`) used to forward to db-sync; they're now allowlisted to the two protocol-managed addresses and served from in-memory state (issue #89). Address history (`/history/:address`) was removed alongside it (issue #88).

## Operations notes

- ogmios + db-sync + cardano-node maintained outside this repo, on Preprod for v1.
- Local dev: connect directly to a reachable Preprod ogmios and db-sync via env vars.
- Production target: same Preprod first, then mainnet after audit. Host plan deferred (OQ-K).
