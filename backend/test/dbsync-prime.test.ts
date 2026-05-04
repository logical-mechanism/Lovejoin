// PostgresDbSyncClient.primeProtocolState — column probe + dual query
// shape + per-txn statement_timeout (issue #87 follow-up).
//
// Drives the real `PostgresDbSyncClient` against an injected fake
// `pg.Pool` that records every SQL statement and returns scripted
// rows. We never touch postgres; the assertions are about which
// queries the client emits, in what order, and which path it picks
// based on the schema probe.

import { describe, expect, it } from "vitest";

import { encodeMixDatumDef } from "./helpers/datum.js";
import { PostgresDbSyncClient, type ProtocolPrimeParams } from "../src/db/dbsync.js";

const MIX_ADDR = "addr_test1mix-fake";
const FEE_ADDR = "addr_test1fee-fake";
const NFT_POLICY = "deadbeef".repeat(7);
const NFT_ASSET = "6c6f76656a6f696e";

const PARAMS: ProtocolPrimeParams = {
  mixBoxAddress: MIX_ADDR,
  feeContractAddress: FEE_ADDR,
  referenceNftPolicyHex: NFT_POLICY,
  referenceNftAssetNameHex: NFT_ASSET,
};

interface RecordedQuery {
  sql: string;
  values: unknown[] | undefined;
}

interface FakeQueryConfig {
  /** When true, the column-probe returns `{ exists: true }`. */
  consumedByPresent: boolean;
  /** Rows to return for the latest-block query. */
  latestBlock?: { slot: string; hash: string; block_no: number };
  /** Rows to return for each address scan, keyed by `address` value. */
  addressRows?: Record<string, Array<Record<string, unknown>>>;
  /** Rows to return for the reference NFT lookup. */
  referenceNftRows?: Array<Record<string, unknown>>;
}

function fakePool(config: FakeQueryConfig): {
  pool: import("pg").Pool;
  recorded: RecordedQuery[];
  /** Number of `connect()` invocations — should equal prime calls. */
  connects: () => number;
} {
  const recorded: RecordedQuery[] = [];
  let connectCount = 0;

  const handleQuery = async (
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> => {
    recorded.push({ sql: text, values });
    const sql = text.trim();
    if (sql.startsWith("BEGIN") || sql.startsWith("COMMIT") || sql.startsWith("ROLLBACK")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SET LOCAL statement_timeout")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("information_schema.columns")) {
      return { rows: [{ exists: config.consumedByPresent }], rowCount: 1 };
    }
    if (sql.includes("FROM block")) {
      return { rows: config.latestBlock ? [config.latestBlock] : [], rowCount: 1 };
    }
    if (sql.includes("FROM ma_tx_out mto")) {
      // Asset-batch lookup for live UTxOs — we don't bother seeding
      // assets in these tests; an empty result is fine.
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("ma_tx_out") && sql.includes("multi_asset")) {
      // Reference-NFT lookup (joins tx_out / ma_tx_out / multi_asset
      // and selects tx_out columns).
      const rows = config.referenceNftRows ?? [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM tx_out")) {
      // Address scan.
      const address = values?.[0] as string;
      const rows = config.addressRows?.[address] ?? [];
      return { rows, rowCount: rows.length };
    }
    throw new Error(`fakePool: unhandled SQL: ${sql.slice(0, 120)}`);
  };

  const fakeClient = {
    query: handleQuery,
    release: () => {},
  };
  const pool = {
    connect: async () => {
      connectCount += 1;
      return fakeClient;
    },
    query: handleQuery,
    end: async () => {},
  } as unknown as import("pg").Pool;
  return { pool, recorded, connects: () => connectCount };
}

function dbsyncRow(
  txHashHex: string,
  outputIndex: number,
  address: string,
  lovelace: bigint,
  inlineDatum: string | null,
): Record<string, unknown> {
  return {
    tx_hash: txHashHex,
    output_index: outputIndex,
    address,
    lovelace: lovelace.toString(),
    datum_hash: null,
    inline_datum: inlineDatum,
    ref_script_hash: null,
    ref_script_cbor: null,
  };
}

function bytes48(seed: number): Uint8Array {
  const out = new Uint8Array(48);
  for (let i = 0; i < 48; i++) out[i] = (seed * 11 + i) & 0xff;
  return out;
}

describe("PostgresDbSyncClient.primeProtocolState — schema probe + dual path", () => {
  it("uses the consumed_by_tx_id fast path when the column is present", async () => {
    const { pool, recorded } = fakePool({
      consumedByPresent: true,
      latestBlock: { slot: "12345", hash: "ab".repeat(32), block_no: 678 },
      addressRows: {
        [MIX_ADDR]: [
          dbsyncRow(
            "aa".repeat(32),
            0,
            MIX_ADDR,
            10_000_000n,
            encodeMixDatumDef(bytes48(1), bytes48(2)),
          ),
        ],
        [FEE_ADDR]: [dbsyncRow("bb".repeat(32), 0, FEE_ADDR, 5_000_000n, "d87980")],
      },
      referenceNftRows: [dbsyncRow("cc".repeat(32), 0, "addr_test1ref", 5_000_000n, null)],
    });

    const client = new PostgresDbSyncClient("postgres://unused", { pool });
    const snapshot = await client.primeProtocolState(PARAMS);

    expect(snapshot.tip).toEqual({ slot: 12345, blockHash: "ab".repeat(32), height: 678 });
    expect(snapshot.mixBoxUtxos).toHaveLength(1);
    expect(snapshot.feeShardUtxos).toHaveLength(1);
    expect(snapshot.referenceUtxo?.txHash).toBe("cc".repeat(32));

    // Probe ran exactly once and the address scans took the fast path.
    const probeCalls = recorded.filter((r) => r.sql.includes("information_schema.columns"));
    expect(probeCalls).toHaveLength(1);
    const addressScans = recorded.filter(
      (r) => r.sql.includes("FROM tx_out") && !r.sql.includes("ma_tx_out"),
    );
    expect(addressScans.length).toBeGreaterThanOrEqual(2);
    for (const q of addressScans) {
      expect(q.sql).toContain("tx_out.consumed_by_tx_id IS NULL");
      expect(q.sql).not.toContain("NOT EXISTS");
    }

    // Statement timeout was lifted inside the prime txn.
    expect(recorded.some((r) => r.sql.startsWith("SET LOCAL statement_timeout"))).toBe(true);
  });

  it("falls back to NOT EXISTS when the consumed_by_tx_id column is absent", async () => {
    const { pool, recorded } = fakePool({
      consumedByPresent: false,
      latestBlock: { slot: "1", hash: "00".repeat(32), block_no: 1 },
      addressRows: {},
      referenceNftRows: [],
    });

    const client = new PostgresDbSyncClient("postgres://unused", { pool });
    await client.primeProtocolState(PARAMS);

    const addressScans = recorded.filter(
      (r) => r.sql.includes("FROM tx_out") && !r.sql.includes("ma_tx_out"),
    );
    for (const q of addressScans) {
      expect(q.sql).toContain("NOT EXISTS");
      expect(q.sql).not.toContain("consumed_by_tx_id");
    }
  });

  it("caches the column probe across reprime calls", async () => {
    const { pool, recorded } = fakePool({
      consumedByPresent: true,
      latestBlock: { slot: "1", hash: "00".repeat(32), block_no: 1 },
      addressRows: {},
      referenceNftRows: [],
    });

    const client = new PostgresDbSyncClient("postgres://unused", { pool });
    await client.primeProtocolState(PARAMS);
    await client.primeProtocolState(PARAMS);
    await client.primeProtocolState(PARAMS);

    const probeCalls = recorded.filter((r) => r.sql.includes("information_schema.columns"));
    expect(probeCalls).toHaveLength(1);
  });

  it("applies the configured prime statement_timeout via SET LOCAL", async () => {
    const { pool, recorded } = fakePool({
      consumedByPresent: false,
      latestBlock: { slot: "1", hash: "00".repeat(32), block_no: 1 },
      addressRows: {},
      referenceNftRows: [],
    });

    const client = new PostgresDbSyncClient("postgres://unused", {
      pool,
      primeStatementTimeoutMs: 90_000,
    });
    await client.primeProtocolState(PARAMS);

    const setCalls = recorded.filter((r) => r.sql.startsWith("SET LOCAL statement_timeout"));
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]!.sql).toContain("90000");
  });
});
