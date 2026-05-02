// Ogmios mempool client — submit + evaluate transactions over a
// dedicated WebSocket separate from the chainsync client.
//
// Why a separate client: the chainsync `OgmiosClient` enforces a single
// in-flight request and is parked on `nextBlock` waiting for the next
// block almost continuously. Submitting or evaluating a tx on the same
// socket would either steal that slot or block on the chainsync wait.
// Two sockets is the simplest fix and also matches how every other
// Cardano indexer / wallet backend does it.
//
// JSON-RPC method shapes (Ogmios v6):
//   submitTransaction { transaction: { cbor } }
//     → { transaction: { id } }
//   evaluateTransaction { transaction: { cbor } }
//     → [ { validator: { purpose, index }, budget: { memory, cpu } }, … ]
//
// Eval result is passed through to clients verbatim — the SDK already
// knows how to translate v6 purpose strings into mesh redeemer tags
// (see offchain/src/tx/mesh-bridge.ts), so the backend stays a thin
// passthrough.

// Pull WebSocket from `ws` rather than the global. Node 22 ships a
// global WebSocket, but the backend deliberately uses `ws` (the same
// dep the chainsync client uses; see indexer/ogmios.ts) so the runtime
// is consistent across Node versions and so tests can swap a fake.
import WebSocket from "ws";

export interface OgmiosTxClientConfig {
  url: string;
  socketFactory?: (url: string) => OgmiosTxSocket;
  onOpen?: (url: string) => void;
}

export interface OgmiosTxSocket {
  send(data: string): void;
  close(): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: string | Buffer) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

export interface RedeemerBudget {
  validator: { purpose: string; index: number };
  budget: { memory: number; cpu: number };
}

/**
 * Subset of the ogmios v6 transaction shape that we read for mempool
 * acquisition. Ogmios returns much more (datums, redeemers, signatures,
 * outputs, etc.) but the only field we care about is `inputs`.
 */
export interface MempoolTransaction {
  id: string;
  inputs: Array<{
    transaction: { id: string };
    index: number;
  }>;
}

export class OgmiosTxClient {
  private socket: OgmiosTxSocket | null = null;
  private connected: Promise<void> | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private fatalError: Error | null = null;
  private closedFlag = false;

  constructor(private readonly config: OgmiosTxClientConfig) {}

  /**
   * Lazily open the socket. Safe to call repeatedly; subsequent calls
   * return the same in-flight (or resolved) connect promise.
   */
  async connect(): Promise<void> {
    if (this.closedFlag) throw new Error("ogmios-tx: client closed");
    if (this.connected) return this.connected;
    this.connected = new Promise<void>((resolve, reject) => {
      try {
        const factory =
          this.config.socketFactory ??
          ((url: string) => new WebSocket(url) as unknown as OgmiosTxSocket);
        const sock = factory(this.config.url);
        this.socket = sock;
        sock.on("message", (data) => this.onMessage(data));
        sock.on("open", () => {
          this.config.onOpen?.(this.config.url);
          resolve();
        });
        sock.on("error", (err) => {
          this.fatalError = err;
          this.failAll(err);
          reject(err);
        });
        sock.on("close", () => {
          this.fatalError ??= new Error("ogmios-tx websocket closed");
          this.failAll(this.fatalError);
          // Allow the next request to attempt a fresh connect.
          this.socket = null;
          this.connected = null;
        });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    return this.connected;
  }

  close(): void {
    this.closedFlag = true;
    this.socket?.close();
    this.socket = null;
    this.connected = null;
    this.failAll(new Error("ogmios-tx: client closed"));
  }

  /**
   * Submit a CBOR-encoded transaction. Returns the resulting txid.
   * Bubbles ogmios's JSON-RPC error verbatim on rejection so the API
   * route can surface the ledger's reason without translating.
   */
  async submitTransaction(cborHex: string): Promise<string> {
    const result = (await this.request("submitTransaction", {
      transaction: { cbor: cborHex },
    })) as { transaction?: { id?: string } };
    const id = result?.transaction?.id;
    if (typeof id !== "string" || !/^[0-9a-fA-F]{64}$/.test(id)) {
      throw new Error(`ogmios-tx: submitTransaction returned no txid (${JSON.stringify(result)})`);
    }
    return id.toLowerCase();
  }

  /**
   * Evaluate ex-units for a CBOR-encoded transaction. Returns the
   * verbatim redeemer-budget array from ogmios so the SDK's existing
   * mesh-bridge translation logic keeps working unchanged.
   */
  async evaluateTransaction(cborHex: string): Promise<RedeemerBudget[]> {
    const result = await this.request("evaluateTransaction", {
      transaction: { cbor: cborHex },
    });
    if (!Array.isArray(result)) {
      throw new Error(`ogmios-tx: evaluateTransaction returned ${typeof result}, expected array`);
    }
    return result as RedeemerBudget[];
  }

  /**
   * Query the current ledger state's protocol parameters. Returns the
   * verbatim ogmios v6 object so the SDK's translation layer is the
   * single place that knows how to map ogmios names to mesh / Blockfrost
   * names. Includes cost models for every Plutus version, which is the
   * field the Conway SDK fee-estimation can't live without.
   */
  async protocolParameters(): Promise<unknown> {
    return this.request("queryLedgerState/protocolParameters", {});
  }

  // ---------------------------------------------------------------
  // Mempool acquisition (Ogmios v6 mempool protocol).
  //
  // Pattern: acquireMempool → loop nextTransaction → releaseMempool.
  // The acquired snapshot is pinned to a slot and won't shift mid-walk
  // even if new txs arrive. We pass `fields: "all"` so the response
  // includes input refs (otherwise nextTransaction returns just a txid).
  //
  // Mempool visibility is the cardano-node's view: every tx propagated
  // through the network's mempool gossip, regardless of which submission
  // endpoint produced it. So a Blockfrost user's tx that consumes a fee
  // shard shows up here too with sub-second propagation lag in practice.
  //
  // We piggyback on the existing tx WebSocket; it's idle between submits
  // and mempool acquisition is mutually exclusive with submitTransaction
  // anyway (one in-flight ogmios request at a time).

  /** Acquire a mempool snapshot. Returns the slot of the snapshot. */
  async acquireMempool(): Promise<number> {
    const result = (await this.request("acquireMempool", {})) as {
      slot?: number;
    };
    return typeof result?.slot === "number" ? result.slot : 0;
  }

  /**
   * Pull the next transaction in the acquired snapshot. Returns the raw
   * ogmios `transaction` object (with `inputs: [{transaction:{id},index}]`)
   * or `null` when the snapshot is exhausted.
   */
  async nextMempoolTransaction(): Promise<MempoolTransaction | null> {
    const result = (await this.request("nextTransaction", {
      fields: "all",
    })) as { transaction?: MempoolTransaction | null };
    return result?.transaction ?? null;
  }

  /** Release the acquired snapshot. Best-effort; ogmios doesn't fail. */
  async releaseMempool(): Promise<void> {
    await this.request("releaseMempool", {});
  }

  // ---------------------------------------------------------------

  private async request(method: string, params: unknown): Promise<unknown> {
    if (this.fatalError && !this.closedFlag) {
      // Drop the cached error and try a reconnect on the next call.
      this.fatalError = null;
    }
    if (this.closedFlag) throw new Error("ogmios-tx: client closed");
    await this.connect();
    if (!this.socket) throw new Error("ogmios-tx: not connected");
    const id = this.nextRequestId++;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
      id,
    });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket!.send(payload);
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private onMessage(data: string | Buffer): void {
    let parsed: { id?: number; result?: unknown; error?: { code: number; message: string } };
    try {
      const text = typeof data === "string" ? data : data.toString("utf8");
      parsed = JSON.parse(text);
    } catch {
      // Ignore malformed frames — ogmios should never emit them, and
      // failing one in-flight request on a parse error would punish
      // every other request that was about to receive a clean reply.
      return;
    }
    if (typeof parsed.id !== "number") return;
    const handler = this.pending.get(parsed.id);
    if (!handler) return;
    this.pending.delete(parsed.id);
    if (parsed.error) {
      handler.reject(
        new Error(`ogmios JSON-RPC error ${parsed.error.code}: ${parsed.error.message}`),
      );
      return;
    }
    handler.resolve(parsed.result);
  }

  private failAll(err: Error): void {
    for (const handler of this.pending.values()) handler.reject(err);
    this.pending.clear();
  }
}

/**
 * Translate a ws:// chainsync URL into the same ogmios endpoint for tx
 * submission. They're the same WebSocket service; this exists so
 * callers can pass `ogmiosUrl` once instead of two env vars.
 */
export function ogmiosTxUrlFromChainsyncUrl(url: string): string {
  return url;
}
