// db-sync queries.
//
// db-sync is a Cardano indexer that mirrors the chain into Postgres.
// We use it for two narrow purposes:
//
//   1. /history/:address — recent withdrawal txs at a destination.
//      ogmios chainsync is forward-only (and we don't index history
//      ourselves to keep the indexer lean), so we delegate to
//      db-sync's existing tx_out / tx tables.
//
//   2. Initial sync (future) — bulk-load the current pool snapshot in
//      one SQL query instead of replaying chainsync from genesis. Not
//      wired up yet; the M5 spec calls it out as an optional speedup.
//
// We keep the surface small + parameterised — no string concatenation
// of user input into SQL. db-sync's schema is documented at
// https://github.com/IntersectMBO/cardano-db-sync.

import pg from "pg";

const { Pool } = pg;

/** A withdrawal-side tx for an address. */
export interface AddressTxHistoryEntry {
  txHash: string;
  blockHeight: number;
  blockTime: string; // ISO 8601
  /**
   * Lovelace received at the address in this tx. Doesn't account for
   * native asset arrivals — withdrawals are ADA-only by Lovejoin's spec.
   */
  lovelaceReceived: bigint;
}

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
 * History-only client surface — the cheap subset that the Blockfrost
 * fallback can satisfy without N+1 calls per query category. Used by
 * `/history/:address` which is the only route that needs a fallback at
 * all. UTxO + tx-summary queries below stay on the wider DbSyncClient
 * because Blockfrost's address-utxo / tx endpoints have a different
 * shape and we don't want to translate them at this layer.
 */
export interface HistoryClient {
  /** Recent txs that paid `address`. Newest first. */
  addressHistory(address: string, limit: number): Promise<AddressTxHistoryEntry[]>;
  /** Smoke check. */
  ping(): Promise<void>;
  /** Disconnect. */
  close(): Promise<void>;
}

/** The full db-sync surface — history plus UTxOs plus tx summaries. */
export interface DbSyncClient extends HistoryClient {
  /** Live UTxOs at `address`. Includes assets + inline datums + ref scripts. */
  addressUtxos(address: string): Promise<DbSyncUtxo[]>;
  /** UTxOs produced by a specific tx (any address). For getUtxoByRef. */
  txUtxos(txHash: string): Promise<DbSyncUtxo[]>;
  /** Confirmation summary for a tx, or null if not on chain yet. */
  txSummary(txHash: string): Promise<DbSyncTxSummary | null>;
}

export class PostgresDbSyncClient implements DbSyncClient {
  private pool: pg.Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 5 });
  }

  async addressHistory(address: string, limit: number): Promise<AddressTxHistoryEntry[]> {
    if (!Number.isFinite(limit) || limit <= 0 || limit > 500) {
      throw new Error(`addressHistory: limit must be 1..500, got ${limit}`);
    }
    // Query: txs paying ADA to `address`, newest first. We use the
    // canonical db-sync schema:
    //   tx_out.address (text)
    //   tx_out.value (lovelace, NUMERIC)
    //   tx_out.tx_id (FK → tx.id)
    //   tx.hash (bytea), tx.block_id (FK → block.id)
    //   block.block_no (integer), block.time (timestamp)
    //
    // We sum tx_out.value per (tx, address) so a tx paying multiple
    // outputs to the same destination shows once with the total
    // received.
    const sql = `
      SELECT
        ENCODE(tx.hash, 'hex')        AS tx_hash,
        block.block_no                 AS block_no,
        block.time                     AS block_time,
        SUM(tx_out.value)::NUMERIC     AS lovelace_received
      FROM tx_out
      JOIN tx     ON tx_out.tx_id = tx.id
      JOIN block  ON tx.block_id = block.id
      WHERE tx_out.address = $1
      GROUP BY tx.id, block.block_no, block.time
      ORDER BY block.block_no DESC, tx.id DESC
      LIMIT $2
    `;
    const result = await this.pool.query<{
      tx_hash: string;
      block_no: number;
      block_time: Date;
      lovelace_received: string;
    }>(sql, [address, limit]);
    return result.rows.map((r) => ({
      txHash: r.tx_hash,
      blockHeight: r.block_no,
      blockTime: r.block_time.toISOString(),
      lovelaceReceived: BigInt(r.lovelace_received),
    }));
  }

  async addressUtxos(address: string): Promise<DbSyncUtxo[]> {
    if (typeof address !== "string" || address.length < 4 || address.length > 200) {
      throw new Error(`addressUtxos: address malformed (got ${JSON.stringify(address)})`);
    }
    // Live UTxOs = tx_out rows with no matching tx_in consuming them.
    // Schema notes (db-sync 13.x):
    //   tx_out.{tx_id, index, address, value, data_hash, inline_datum_id, reference_script_id}
    //   tx_in.{tx_in_id, tx_out_id, tx_out_index}  — the consumer side
    //   datum.bytes (bytea, raw CBOR)              — for inline datums
    //   script.{hash, bytes, type}                 — for reference scripts
    //   ma_tx_out.{ident, quantity}                — multi-asset side
    //   multi_asset.{policy, name}                 — joined via ma_tx_out.ident
    // The `NOT EXISTS` consumed-input clause is the canonical
    // "give me UTxOs at this address" pattern; index assumes the
    // tx_in (tx_out_id, tx_out_index) composite index exists, which
    // is the default in db-sync.
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
        AND NOT EXISTS (
          SELECT 1 FROM tx_in
          WHERE tx_in.tx_out_id    = tx_out.tx_id
            AND tx_in.tx_out_index = tx_out.index
        )
      ORDER BY tx_out.tx_id, tx_out.index
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
    }>(sql, [address]);
    if (result.rows.length === 0) return [];
    // Pull the multi-asset side in one round-trip per page rather than
    // per-row. We key by (tx_hash, output_index).
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

  /**
   * Pull native-asset rows for a batch of UTxOs in one query. Returns a
   * map keyed by `${txHash}:${outputIndex}` to a `unit → quantity` map.
   * Empty for refs with no native assets.
   */
  private async assetsForUtxos(refs: string[]): Promise<Map<string, Record<string, bigint>>> {
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
    const result = await this.pool.query<{
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
    private readonly history: Record<string, AddressTxHistoryEntry[]> = {},
    private readonly utxos: Record<string, DbSyncUtxo[]> = {},
    private readonly txMap: Record<string, DbSyncTxSummary> = {},
  ) {}
  async addressHistory(address: string, limit: number): Promise<AddressTxHistoryEntry[]> {
    return (this.history[address] ?? []).slice(0, limit);
  }
  async addressUtxos(address: string): Promise<DbSyncUtxo[]> {
    return this.utxos[address] ?? [];
  }
  async txUtxos(txHash: string): Promise<DbSyncUtxo[]> {
    const norm = txHash.toLowerCase();
    return Object.values(this.utxos)
      .flat()
      .filter((u) => u.txHash.toLowerCase() === norm);
  }
  async txSummary(txHash: string): Promise<DbSyncTxSummary | null> {
    return this.txMap[txHash.toLowerCase()] ?? null;
  }
  async ping(): Promise<void> {
    /* noop */
  }
  async close(): Promise<void> {
    /* noop */
  }
}
