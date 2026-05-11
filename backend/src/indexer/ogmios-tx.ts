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
  /**
   * Max consecutive reconnect attempts before tripping the circuit and
   * fail-fasting subsequent requests with a 503-shaped error. Default
   * matches `IndexerRuntime`'s 30 — with the 10 s backoff cap that's
   * ~5 min of wall clock, enough to ride out cloudflared / network blips
   * without papering over a real upstream outage and amplifying it
   * across every `/submit` or `/evaluate` call (security review v1, M7).
   */
  maxReconnectAttempts?: number;
  /** Sleep override for tests so they don't actually wait the backoff. */
  sleepMs?: (ms: number) => Promise<void>;
  /** Random source for jitter; tests pin it to keep delays deterministic. */
  random?: () => number;
}

/** Snapshot of the client's in-flight reconnect state, exposed to /health. */
export interface OgmiosTxReconnectStatus {
  /** True while a reconnect cycle is currently retrying. */
  inProgress: boolean;
  /** Number of attempts in the current cycle (0 when idle or after success). */
  attempts: number;
  /** Epoch ms of the most recent reconnect-relevant error; 0 when never. */
  lastErrorAt: number;
  /** Message from the most recent reconnect-relevant error; empty when none. */
  lastErrorMessage: string;
  /**
   * True once `attempts` hit `maxReconnectAttempts` without a successful
   * reconnect in between. The circuit stays open until the process is
   * restarted (mirrors the runtime's fatal-after-exhaustion model).
   */
  exhausted: boolean;
}

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 30;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

  // Reconnect bookkeeping. `attempts` counts the *current* cycle and
  // resets to 0 after a successful connect. `lastError*` persist across
  // cycles so /health can surface the most recent upstream trouble.
  // `exhausted` latches once the cycle blew through `maxReconnectAttempts`
  // — subsequent requests fail-fast until the process restarts, mirroring
  // the runtime's fatal-after-exhaustion model.
  private reconnectInProgress = false;
  private reconnectAttempts = 0;
  private lastReconnectErrorAt = 0;
  private lastReconnectErrorMessage = "";
  private exhausted = false;
  private reconnectCycle: Promise<void> | null = null;

  constructor(private readonly config: OgmiosTxClientConfig) {}

  /** Snapshot of the reconnect state — surfaced via `/health`. */
  reconnecting(): OgmiosTxReconnectStatus {
    return {
      inProgress: this.reconnectInProgress,
      attempts: this.reconnectAttempts,
      lastErrorAt: this.lastReconnectErrorAt,
      lastErrorMessage: this.lastReconnectErrorMessage,
      exhausted: this.exhausted,
    };
  }

  /**
   * Lazily open the socket. Safe to call repeatedly; subsequent calls
   * return the same in-flight (or resolved) connect promise.
   *
   * On a transient connect failure the client retries up to
   * `maxReconnectAttempts` times with exponential backoff + jitter. Once
   * exhausted, the circuit latches open and every subsequent call
   * rejects immediately with the cached upstream error rather than
   * piling on more reconnect traffic.
   */
  async connect(): Promise<void> {
    if (this.closedFlag) throw new Error("ogmios-tx: client closed");
    if (this.exhausted) throw this.unavailableError();
    if (this.connected) return this.connected;
    if (this.reconnectCycle) return this.reconnectCycle;
    return this.openSocketOnce();
  }

  private openSocketOnce(): Promise<void> {
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
          // Successful connect resets the reconnect cycle bookkeeping.
          this.reconnectAttempts = 0;
          this.reconnectInProgress = false;
          resolve();
        });
        sock.on("error", (err) => {
          this.fatalError = err;
          this.failAll(err);
          // Clear the cached promises so the next attempt opens a
          // fresh socket. `ws` follows error with close in production
          // (which also clears these), but tests may fire only one.
          this.socket = null;
          this.connected = null;
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
   *
   * `additionalUtxo` (optional) is forwarded verbatim to ogmios' v6
   * `evaluateTransaction.additionalUtxo` mechanism: a list of
   * `[txin, txout]` pairs spliced into the chain state for the
   * evaluation. Use this when the tx references the unconfirmed outputs
   * of an in-flight parent (chained Mix, Deposit → Mix, Replenish → Mix).
   * Omitted from the wire request when empty/undefined, matching ogmios'
   * "missing means no extras" default.
   */
  async evaluateTransaction(
    cborHex: string,
    additionalUtxo?: ReadonlyArray<unknown>,
  ): Promise<RedeemerBudget[]> {
    const params: Record<string, unknown> = {
      transaction: { cbor: cborHex },
    };
    if (additionalUtxo && additionalUtxo.length > 0) {
      params.additionalUtxo = additionalUtxo;
    }
    const result = await this.request("evaluateTransaction", params);
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
    if (this.closedFlag) throw new Error("ogmios-tx: client closed");
    if (this.exhausted) throw this.unavailableError();
    if (this.fatalError) {
      // The previous socket died; clear the cached error and drive a
      // bounded reconnect cycle on this request. Subsequent requests
      // arriving during the cycle await the same in-flight promise.
      this.fatalError = null;
      await this.runReconnectCycle();
    } else {
      await this.connect();
    }
    if (this.exhausted) throw this.unavailableError();
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

  /**
   * Drive a bounded reconnect cycle: try `connect()` up to
   * `maxReconnectAttempts` times, sleeping with exponential backoff +
   * jitter between attempts. On success, the attempt counter resets and
   * the next request's `await this.connect()` returns the live socket.
   * On exhaustion, sets `exhausted = true` so future requests fail-fast
   * with the cached upstream error rather than driving more attempts.
   *
   * Concurrent requests during a cycle share the same promise — see
   * `connect()` returning `reconnectCycle` — so a flood of /submit
   * traffic doesn't multiply reconnect attempts.
   */
  private runReconnectCycle(): Promise<void> {
    if (this.reconnectCycle) return this.reconnectCycle;
    const maxAttempts = this.config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    const sleep = this.config.sleepMs ?? defaultSleep;
    this.reconnectInProgress = true;
    this.reconnectAttempts = 0;
    this.reconnectCycle = (async () => {
      try {
        while (!this.closedFlag) {
          this.reconnectAttempts += 1;
          try {
            await this.openSocketOnce();
            this.reconnectInProgress = false;
            this.reconnectAttempts = 0;
            return;
          } catch (err) {
            this.recordReconnectError(err);
            if (this.reconnectAttempts >= maxAttempts) {
              this.exhausted = true;
              this.reconnectInProgress = false;
              return;
            }
            await sleep(this.backoffMs(this.reconnectAttempts));
          }
        }
        this.reconnectInProgress = false;
      } finally {
        this.reconnectCycle = null;
      }
    })();
    return this.reconnectCycle;
  }

  private recordReconnectError(err: unknown): void {
    this.lastReconnectErrorMessage = err instanceof Error ? err.message : String(err);
    this.lastReconnectErrorAt = Date.now();
  }

  private backoffMs(attempt: number): number {
    // 1s, 2s, 4s, 8s, then capped at 10s; ±20% jitter so a herd of
    // reconnecting instances doesn't synchronise.
    const base = Math.min(10_000, 1000 * Math.pow(2, attempt - 1));
    const random = (this.config.random ?? Math.random)();
    const jitter = 0.8 + 0.4 * random;
    return Math.floor(base * jitter);
  }

  private unavailableError(): Error {
    const reason = this.lastReconnectErrorMessage || "ogmios upstream unavailable";
    return new Error(
      `ogmios-tx: upstream unavailable after ${this.reconnectAttempts} attempts: ${reason}`,
    );
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
