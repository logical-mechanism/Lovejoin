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

/** Minimal DB interface — the smallest surface routes need. */
export interface DbSyncClient {
  /** Recent txs that paid `address`. Newest first. */
  addressHistory(address: string, limit: number): Promise<AddressTxHistoryEntry[]>;
  /** Smoke check — fail-fast if the connection / schema isn't ready. */
  ping(): Promise<void>;
  /** Disconnect. */
  close(): Promise<void>;
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
  ) {}
  async addressHistory(address: string, limit: number): Promise<AddressTxHistoryEntry[]> {
    return (this.history[address] ?? []).slice(0, limit);
  }
  async ping(): Promise<void> {
    /* noop */
  }
  async close(): Promise<void> {
    /* noop */
  }
}
