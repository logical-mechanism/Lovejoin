// db-sync queries.
//
// db-sync is a Cardano indexer that mirrors the chain into Postgres.
// We use it for two narrow purposes:
//
//   1. Tx-hash exact-match lookups (`/tx/:hash`, `/tx/:hash/utxos`) —
//      the SDK's `awaitConfirmation` and `getUtxoByRef` paths.
//   2. Indexer cold-start prime (`primeProtocolState`) — bulk-load the
//      live pool, fee shards, and reference NFT location at db-sync's
//      latest stable block, so the chainsync loop can resume from there
//      instead of replaying `bootstrapStartPoint → tip` on every
//      container restart (issue #87).
//
// Address-scoped queries on the public API (`/utxos/:address`) live
// in-memory now — they used to forward to db-sync but every random
// address was a DoS surface (issue #89). The internal prime path here
// queries the two protocol-managed addresses only and is not exposed
// over HTTP.
//
// We keep the surface small + parameterised — no string concatenation
// of user input into SQL. db-sync's schema is documented at
// https://github.com/IntersectMBO/cardano-db-sync.

import pg from "pg";

const { Pool } = pg;

/**
 * A live UTxO. Mirrors Blockfrost's `/addresses/{addr}/utxos` shape so
 * the SDK can swap providers without changing call sites. `assets` keys
 * are the unit string `policy + assetNameHex` (matching mesh + the SDK
 * assets-by-unit convention).
 */
export interface DbSyncUtxo {
  txHash: string;
  outputIndex: number;
  address: string;
  lovelace: bigint;
  assets: Record<string, bigint>;
  /** Inline datum CBOR hex if this UTxO carries one. */
  inlineDatum: string | null;
  /** Datum hash (hex) for hashed datums. Null when inline / absent. */
  datumHash: string | null;
  /** Reference script hex (raw bytes, no language tag). Null if absent. */
  referenceScriptCbor: string | null;
  /** Reference script hash (hex). Null if absent. */
  referenceScriptHash: string | null;
}

/**
 * Tx confirmation summary. Used by `/tx/:hash` for the SDK's
 * `awaitConfirmation` polling — we don't need the full tx body, just
 * "is this tx in the chain yet, and at what block?"
 */
export interface DbSyncTxSummary {
  txHash: string;
  blockHeight: number;
  blockHash: string;
  slot: number;
  blockTime: string;
}

/**
 * Snapshot of the chain state needed to prime the in-memory indexer
 * from db-sync at cold start (or to recover from a deep rollback past
 * the indexer's reverse buffer). All UTxOs are live as of `tip`; the
 * tip itself is db-sync's latest stable block.
 *
 * `referenceUtxo` may be `null` if the bootstrap NFT hasn't been
 * observed yet; the orchestrator surfaces that case as a startup-time
 * warning rather than a hard fail (an empty pool plus a missing NFT
 * is a freshly-bootstrapped network, not corruption).
 */
export interface ProtocolPrimeSnapshot {
  /** db-sync's latest stable block — used as the chainsync resume point. */
  tip: { slot: number; blockHash: string; height: number };
  /** Live mix-box UTxOs at `tip`. */
  mixBoxUtxos: DbSyncUtxo[];
  /** Live fee-contract UTxOs at `tip`. */
  feeShardUtxos: DbSyncUtxo[];
  /** UTxO carrying the reference NFT, if observable. */
  referenceUtxo: DbSyncUtxo | null;
}

/**
 * Identifying parameters for the protocol's chain footprint. The
 * prime path needs the two protocol-managed addresses plus the
 * reference NFT's policy/asset name to locate the reference UTxO
 * regardless of which address it sits at.
 */
export interface ProtocolPrimeParams {
  mixBoxAddress: string;
  feeContractAddress: string;
  referenceNftPolicyHex: string;
  referenceNftAssetNameHex: string;
}

/** The db-sync surface — tx-hash exact-match lookups for the SDK. */
export interface DbSyncClient {
  /** UTxOs produced by a specific tx (any address). For getUtxoByRef. */
  txUtxos(txHash: string): Promise<DbSyncUtxo[]>;
  /** Confirmation summary for a tx, or null if not on chain yet. */
  txSummary(txHash: string): Promise<DbSyncTxSummary | null>;
  /**
   * Bulk-load live mix-box UTxOs, fee-contract UTxOs, and the
   * reference NFT location at db-sync's latest stable block. Used
   * to prime the in-memory indexer at cold start so chainsync can
   * resume from db-sync's tip instead of replaying from the
   * bootstrap point.
   */
  primeProtocolState(params: ProtocolPrimeParams): Promise<ProtocolPrimeSnapshot>;
  /** Smoke check. */
  ping(): Promise<void>;
  /** Disconnect. */
  close(): Promise<void>;
}

/**
 * Options that tune the long-running prime path. Overridable from
 * `INDEXER_PRIME_TIMEOUT_MS` at the entrypoint level. The default
 * (60 s) is well above the public-API per-query cap (10 s) because
 * the prime can legitimately scan a busy address's full tx_out
 * history when the operator hasn't enabled the
 * `consumed_by_tx_id` fast path.
 */
export interface PostgresDbSyncOptions {
  /**
   * Per-query timeout for prime statements only, in milliseconds.
   * Applied via `SET LOCAL statement_timeout` inside the prime
   * transaction so it doesn't bleed into other pool clients. The
   * pool's `query_timeout` still caps the legacy public-API queries
   * at 10 s (security review v1, finding M5).
   */
  primeStatementTimeoutMs?: number;
  /**
   * Pre-built pg pool. Production passes nothing and the constructor
   * builds its own bounded pool from `connectionString`. Tests pass
   * a fake pool that records `connect()` calls and returns scripted
   * `query` results so the prime path can be exercised without a
   * live postgres.
   */
  pool?: pg.Pool;
}

const DEFAULT_PRIME_STATEMENT_TIMEOUT_MS = 60_000;

export class PostgresDbSyncClient implements DbSyncClient {
  private pool: pg.Pool;
  private readonly primeStatementTimeoutMs: number;
  /**
   * Cached result of probing whether db-sync's `tx_out` carries a
   * `consumed_by_tx_id` column. `null` until the first prime call
   * runs the probe; thereafter `true` (use the fast `IS NULL` path)
   * or `false` (fall back to the legacy `NOT EXISTS` subquery).
   *
   * Cached for the lifetime of the client because the column's
   * presence is a deploy-time choice on the operator's side; it
   * doesn't flip while the backend is running.
   */
  private consumedByColumnPresent: boolean | null = null;
  /** Process-wide log gate so the path message prints once per backend lifetime. */
  private primePathLogged = false;

  constructor(connectionString: string, options: PostgresDbSyncOptions = {}) {
    // Bounded pool with explicit timeouts. Without these, a slow query
    // can pin a connection forever; five slow callers stall every other
    // history/utxo request behind the pool's `max: 5` cap (security
    // review v1, finding M5). `query_timeout` is a client-side cap so
    // a stuck query gets cancelled even if the server doesn't honour
    // `statement_timeout`; `connectionTimeoutMillis` makes a dead db
    // surface as an error fast instead of hanging the request.
    this.pool =
      options.pool ??
      new Pool({
        connectionString,
        max: 5,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        query_timeout: 10_000,
        statement_timeout: 10_000,
      });
    this.primeStatementTimeoutMs =
      options.primeStatementTimeoutMs ?? DEFAULT_PRIME_STATEMENT_TIMEOUT_MS;
  }

  async txUtxos(txHash: string): Promise<DbSyncUtxo[]> {
    if (!/^[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new Error(`txUtxos: txHash must be 64-char hex (got ${JSON.stringify(txHash)})`);
    }
    const sql = `
      SELECT
        ENCODE(tx.hash, 'hex')                AS tx_hash,
        tx_out.index                          AS output_index,
        tx_out.address                        AS address,
        tx_out.value::TEXT                    AS lovelace,
        ENCODE(tx_out.data_hash, 'hex')       AS datum_hash,
        ENCODE(d.bytes, 'hex')                AS inline_datum,
        ENCODE(s.hash, 'hex')                 AS ref_script_hash,
        ENCODE(s.bytes, 'hex')                AS ref_script_cbor
      FROM tx_out
      JOIN tx ON tx_out.tx_id = tx.id
      LEFT JOIN datum  d ON tx_out.inline_datum_id   = d.id
      LEFT JOIN script s ON tx_out.reference_script_id = s.id
      WHERE tx.hash = DECODE($1, 'hex')
      ORDER BY tx_out.index
    `;
    const result = await this.pool.query<{
      tx_hash: string;
      output_index: number;
      address: string;
      lovelace: string;
      datum_hash: string | null;
      inline_datum: string | null;
      ref_script_hash: string | null;
      ref_script_cbor: string | null;
    }>(sql, [txHash.toLowerCase()]);
    if (result.rows.length === 0) return [];
    const refs = result.rows.map((r) => `${r.tx_hash}:${r.output_index}`);
    const assets = await this.assetsForUtxos(refs);
    return result.rows.map((r) => ({
      txHash: r.tx_hash,
      outputIndex: r.output_index,
      address: r.address,
      lovelace: BigInt(r.lovelace),
      assets: assets.get(`${r.tx_hash}:${r.output_index}`) ?? {},
      inlineDatum: r.inline_datum,
      datumHash: r.datum_hash,
      referenceScriptCbor: r.ref_script_cbor,
      referenceScriptHash: r.ref_script_hash,
    }));
  }

  async txSummary(txHash: string): Promise<DbSyncTxSummary | null> {
    if (!/^[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new Error(`txSummary: txHash must be 64-char hex (got ${JSON.stringify(txHash)})`);
    }
    const sql = `
      SELECT
        ENCODE(tx.hash, 'hex')   AS tx_hash,
        block.block_no           AS block_no,
        ENCODE(block.hash, 'hex') AS block_hash,
        block.slot_no            AS slot,
        block.time               AS block_time
      FROM tx
      JOIN block ON tx.block_id = block.id
      WHERE tx.hash = DECODE($1, 'hex')
      LIMIT 1
    `;
    const result = await this.pool.query<{
      tx_hash: string;
      block_no: number;
      block_hash: string;
      slot: string | number;
      block_time: Date;
    }>(sql, [txHash.toLowerCase()]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      txHash: row.tx_hash,
      blockHeight: Number(row.block_no),
      blockHash: row.block_hash,
      slot: Number(row.slot),
      blockTime: row.block_time.toISOString(),
    };
  }

  async primeProtocolState(params: ProtocolPrimeParams): Promise<ProtocolPrimeSnapshot> {
    if (
      typeof params.mixBoxAddress !== "string" ||
      params.mixBoxAddress.length < 4 ||
      params.mixBoxAddress.length > 200
    ) {
      throw new Error(
        `primeProtocolState: mixBoxAddress malformed (got ${JSON.stringify(params.mixBoxAddress)})`,
      );
    }
    if (
      typeof params.feeContractAddress !== "string" ||
      params.feeContractAddress.length < 4 ||
      params.feeContractAddress.length > 200
    ) {
      throw new Error(
        `primeProtocolState: feeContractAddress malformed (got ${JSON.stringify(params.feeContractAddress)})`,
      );
    }
    if (!/^[0-9a-f]{56}$/.test(params.referenceNftPolicyHex)) {
      throw new Error(
        `primeProtocolState: referenceNftPolicyHex must be 56-char lowercase hex (got ${JSON.stringify(params.referenceNftPolicyHex)})`,
      );
    }
    if (!/^[0-9a-f]*$/.test(params.referenceNftAssetNameHex)) {
      throw new Error(
        `primeProtocolState: referenceNftAssetNameHex must be lowercase hex (got ${JSON.stringify(params.referenceNftAssetNameHex)})`,
      );
    }
    // We pull all queries on the same client so they observe the
    // same transactional snapshot. db-sync writes blocks atomically, so
    // wrapping in REPEATABLE READ guarantees the live UTxO sets and the
    // tip query don't straddle a chain extension. Without this a block
    // applied between the address scan and the tip query would surface
    // as either a phantom UTxO (already consumed by the new block) or
    // a missing one (newly produced but tip already advanced).
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      // Lift statement_timeout for the prime transaction only. The
      // pool's default 10 s cap protects public-API requests from a
      // pathological postgres call; it is too aggressive for the
      // prime, which can legitimately scan a busy mix-box address's
      // full tx_out history when the operator hasn't enabled the
      // consumed_by_tx_id fast path. SET LOCAL is per-transaction
      // and reverts on COMMIT/ROLLBACK, so the bump never bleeds
      // into other pool clients.
      await client.query(`SET LOCAL statement_timeout = ${this.primeStatementTimeoutMs}`);

      // Probe the schema once per process. The result is cached on
      // the client so subsequent reprime calls (deep-rollback recovery)
      // don't re-query information_schema.
      if (this.consumedByColumnPresent === null) {
        this.consumedByColumnPresent = await this.probeConsumedByColumn(client);
      }
      const useFastPath = this.consumedByColumnPresent;
      if (!this.primePathLogged) {
        // One-shot startup log so operators can confirm which path
        // engaged. Subsequent reprimes are silent.

        console.log(
          `[dbsync] prime: query path = ${useFastPath ? "consumed_by_tx_id" : "NOT EXISTS (legacy)"}`,
        );
        this.primePathLogged = true;
      }

      const tip = await this.queryLatestBlock(client);
      const mixBoxUtxos = await this.queryAddressUtxos(client, params.mixBoxAddress, useFastPath);
      const feeShardUtxos = await this.queryAddressUtxos(
        client,
        params.feeContractAddress,
        useFastPath,
      );
      const referenceUtxo = await this.queryReferenceNftUtxo(
        client,
        params.referenceNftPolicyHex,
        params.referenceNftAssetNameHex,
        useFastPath,
      );
      await client.query("COMMIT");
      return { tip, mixBoxUtxos, feeShardUtxos, referenceUtxo };
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // already broken; ignore
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Detect whether db-sync's `tx_out` table carries a
   * `consumed_by_tx_id` column. The column is populated by db-sync
   * 13.1+ when `consumed_tx_out` is enabled in `config.json`. When
   * present, the prime queries can use a single column compare
   * instead of a per-row `NOT EXISTS` subquery against `tx_in`,
   * collapsing O(historical tx_outs) to O(live UTxOs).
   *
   * **Operator note:** enabling `consumed_tx_out` mid-stream leaves
   * pre-existing spent outputs with NULL in this column (looking
   * live). db-sync ships a backfill migration for this case; the
   * documentation in docs/deploy.md §"db-sync configuration" calls
   * it out as mandatory.
   */
  private async probeConsumedByColumn(client: pg.PoolClient): Promise<boolean> {
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'tx_out' AND column_name = 'consumed_by_tx_id'
       ) AS exists`,
    );
    return result.rows[0]?.exists === true;
  }

  /**
   * Latest block in db-sync. Returned as the chainsync resume point.
   * `block` is appended monotonically; the largest `id` is the latest
   * applied block. We do NOT walk back k blocks to a "stable" point —
   * the runtime's reverse buffer plus the reprime-on-deep-rollback
   * recovery covers k-bounded rollbacks; using db-sync's tip directly
   * minimises the catch-up window after prime.
   */
  private async queryLatestBlock(
    client: pg.PoolClient,
  ): Promise<{ slot: number; blockHash: string; height: number }> {
    const result = await client.query<{ slot: string; hash: string; block_no: number }>(
      `SELECT block.slot_no::TEXT AS slot, ENCODE(block.hash, 'hex') AS hash, block.block_no
       FROM block
       ORDER BY block.id DESC
       LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("primeProtocolState: db-sync has no blocks (empty schema?)");
    }
    return {
      slot: Number(row.slot),
      blockHash: row.hash,
      height: Number(row.block_no),
    };
  }

  /**
   * Live UTxOs at `address`. Two query shapes:
   *
   *   - **Fast path** (`useFastPath = true`): when db-sync has the
   *     `consumed_by_tx_id` column populated, "live" is a single
   *     column compare. O(live UTxO count) regardless of how many
   *     historical tx_outs the address has accumulated.
   *   - **Legacy path** (`useFastPath = false`): per-row NOT EXISTS
   *     against `tx_in`. Works on any db-sync schema version but
   *     scales with historical tx_out count at the address — the
   *     concern flagged in issue #87 follow-up discussion.
   *
   * Inline datums are returned verbatim so the indexer can store
   * them without re-encoding (preserves TS↔Aiken parity for any
   * path that hashes the datum bytes).
   */
  private async queryAddressUtxos(
    client: pg.PoolClient,
    address: string,
    useFastPath: boolean,
  ): Promise<DbSyncUtxo[]> {
    const liveFilter = useFastPath
      ? "tx_out.consumed_by_tx_id IS NULL"
      : `NOT EXISTS (
          SELECT 1 FROM tx_in
          WHERE tx_in.tx_out_id    = tx_out.tx_id
            AND tx_in.tx_out_index = tx_out.index
        )`;
    const sql = `
      SELECT
        ENCODE(tx.hash, 'hex')                AS tx_hash,
        tx_out.index                          AS output_index,
        tx_out.address                        AS address,
        tx_out.value::TEXT                    AS lovelace,
        ENCODE(tx_out.data_hash, 'hex')       AS datum_hash,
        ENCODE(d.bytes, 'hex')                AS inline_datum,
        ENCODE(s.hash, 'hex')                 AS ref_script_hash,
        ENCODE(s.bytes, 'hex')                AS ref_script_cbor
      FROM tx_out
      JOIN tx ON tx_out.tx_id = tx.id
      LEFT JOIN datum  d ON tx_out.inline_datum_id   = d.id
      LEFT JOIN script s ON tx_out.reference_script_id = s.id
      WHERE tx_out.address = $1
        AND ${liveFilter}
      ORDER BY tx_out.tx_id, tx_out.index
    `;
    const result = await client.query<{
      tx_hash: string;
      output_index: number;
      address: string;
      lovelace: string;
      datum_hash: string | null;
      inline_datum: string | null;
      ref_script_hash: string | null;
      ref_script_cbor: string | null;
    }>(sql, [address]);
    if (result.rows.length === 0) return [];
    const refs = result.rows.map((r) => `${r.tx_hash}:${r.output_index}`);
    const assets = await this.assetsForUtxos(refs, client);
    return result.rows.map((r) => ({
      txHash: r.tx_hash,
      outputIndex: r.output_index,
      address: r.address,
      lovelace: BigInt(r.lovelace),
      assets: assets.get(`${r.tx_hash}:${r.output_index}`) ?? {},
      inlineDatum: r.inline_datum,
      datumHash: r.datum_hash,
      referenceScriptCbor: r.ref_script_cbor,
      referenceScriptHash: r.ref_script_hash,
    }));
  }

  /**
   * Locate the live UTxO carrying the reference NFT. The validator
   * holding the NFT is `False`-by-design so there should be exactly
   * one such UTxO once bootstrap has run; we return the most recent
   * if (somehow) more than one exists and let the caller's reference
   * UTxO sanity check decide what to do.
   *
   * Same dual-path live-filter as `queryAddressUtxos`. The selectivity
   * here is high either way (filter by exact `(policy, name)` first),
   * but using the column-compare path keeps a single SQL idiom across
   * the prime queries and avoids a redundant `tx_in` index probe.
   */
  private async queryReferenceNftUtxo(
    client: pg.PoolClient,
    policyHex: string,
    assetNameHex: string,
    useFastPath: boolean,
  ): Promise<DbSyncUtxo | null> {
    const liveFilter = useFastPath
      ? "tx_out.consumed_by_tx_id IS NULL"
      : `NOT EXISTS (
          SELECT 1 FROM tx_in
          WHERE tx_in.tx_out_id    = tx_out.tx_id
            AND tx_in.tx_out_index = tx_out.index
        )`;
    const sql = `
      SELECT
        ENCODE(tx.hash, 'hex')                AS tx_hash,
        tx_out.index                          AS output_index,
        tx_out.address                        AS address,
        tx_out.value::TEXT                    AS lovelace,
        ENCODE(tx_out.data_hash, 'hex')       AS datum_hash,
        ENCODE(d.bytes, 'hex')                AS inline_datum,
        ENCODE(s.hash, 'hex')                 AS ref_script_hash,
        ENCODE(s.bytes, 'hex')                AS ref_script_cbor
      FROM tx_out
      JOIN tx        ON tx_out.tx_id = tx.id
      JOIN ma_tx_out mto ON mto.tx_out_id = tx_out.id
      JOIN multi_asset ma ON mto.ident = ma.id
      LEFT JOIN datum  d ON tx_out.inline_datum_id   = d.id
      LEFT JOIN script s ON tx_out.reference_script_id = s.id
      WHERE ma.policy = DECODE($1, 'hex')
        AND ma.name   = DECODE($2, 'hex')
        AND mto.quantity = 1
        AND ${liveFilter}
      ORDER BY tx_out.tx_id DESC
      LIMIT 1
    `;
    const result = await client.query<{
      tx_hash: string;
      output_index: number;
      address: string;
      lovelace: string;
      datum_hash: string | null;
      inline_datum: string | null;
      ref_script_hash: string | null;
      ref_script_cbor: string | null;
    }>(sql, [policyHex, assetNameHex]);
    const row = result.rows[0];
    if (!row) return null;
    const ref = `${row.tx_hash}:${row.output_index}`;
    const assets = await this.assetsForUtxos([ref], client);
    return {
      txHash: row.tx_hash,
      outputIndex: row.output_index,
      address: row.address,
      lovelace: BigInt(row.lovelace),
      assets: assets.get(ref) ?? {},
      inlineDatum: row.inline_datum,
      datumHash: row.datum_hash,
      referenceScriptCbor: row.ref_script_cbor,
      referenceScriptHash: row.ref_script_hash,
    };
  }

  /**
   * Pull native-asset rows for a batch of UTxOs in one query. Returns a
   * map keyed by `${txHash}:${outputIndex}` to a `unit → quantity` map.
   * Empty for refs with no native assets.
   */
  private async assetsForUtxos(
    refs: string[],
    client?: pg.PoolClient,
  ): Promise<Map<string, Record<string, bigint>>> {
    if (refs.length === 0) return new Map();
    // Build (txHash, outputIndex) tuples; the SQL unnests two parallel
    // arrays so postgres planner can index-scan each tx_out row.
    const txHashes: string[] = [];
    const outputIndices: number[] = [];
    for (const ref of refs) {
      const [hash, idx] = ref.split(":");
      txHashes.push(hash!);
      outputIndices.push(Number(idx));
    }
    const sql = `
      SELECT
        ENCODE(tx.hash, 'hex')    AS tx_hash,
        tx_out.index              AS output_index,
        ENCODE(ma.policy, 'hex')  AS policy,
        ENCODE(ma.name, 'hex')    AS asset_name,
        SUM(mto.quantity)::TEXT   AS quantity
      FROM ma_tx_out mto
      JOIN multi_asset ma ON mto.ident = ma.id
      JOIN tx_out ON mto.tx_out_id = tx_out.id
      JOIN tx     ON tx_out.tx_id  = tx.id
      WHERE (ENCODE(tx.hash, 'hex'), tx_out.index)
            IN (SELECT * FROM UNNEST($1::text[], $2::int[]))
      GROUP BY tx.hash, tx_out.index, ma.policy, ma.name
    `;
    const runner = client ?? this.pool;
    const result = await runner.query<{
      tx_hash: string;
      output_index: number;
      policy: string;
      asset_name: string;
      quantity: string;
    }>(sql, [txHashes, outputIndices]);
    const out = new Map<string, Record<string, bigint>>();
    for (const r of result.rows) {
      const key = `${r.tx_hash}:${r.output_index}`;
      const unit = `${r.policy}${r.asset_name}`;
      const bag = out.get(key) ?? {};
      bag[unit] = BigInt(r.quantity);
      out.set(key, bag);
    }
    return out;
  }

  async ping(): Promise<void> {
    // Cheap smoke query — just that the schema has the `block` table.
    const result = await this.pool.query<{ count: string }>(
      "SELECT COUNT(*)::TEXT AS count FROM block LIMIT 1",
    );
    if (!result.rows[0]) {
      throw new Error("db-sync ping: empty result from block count");
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Test-friendly stub. */
export class StubDbSyncClient implements DbSyncClient {
  constructor(
    private readonly utxos: Record<string, DbSyncUtxo[]> = {},
    private readonly txMap: Record<string, DbSyncTxSummary> = {},
    /**
     * Optional canned snapshot returned by `primeProtocolState`. When
     * unset the stub raises — tests that don't exercise the prime
     * path won't notice; tests that do are forced to seed a
     * realistic snapshot rather than rely on a default.
     */
    private readonly primeSnapshot: ProtocolPrimeSnapshot | null = null,
  ) {}
  async txUtxos(txHash: string): Promise<DbSyncUtxo[]> {
    const norm = txHash.toLowerCase();
    return Object.values(this.utxos)
      .flat()
      .filter((u) => u.txHash.toLowerCase() === norm);
  }
  async txSummary(txHash: string): Promise<DbSyncTxSummary | null> {
    return this.txMap[txHash.toLowerCase()] ?? null;
  }
  async primeProtocolState(_params: ProtocolPrimeParams): Promise<ProtocolPrimeSnapshot> {
    if (!this.primeSnapshot) {
      throw new Error("StubDbSyncClient: primeProtocolState called without a seeded snapshot");
    }
    return this.primeSnapshot;
  }
  async ping(): Promise<void> {
    /* noop */
  }
  async close(): Promise<void> {
    /* noop */
  }
}
