// Ogmios chainsync client.
//
// Spec: docs/spec/05-backend.md §"Indexer / Chainsync via ogmios".
//
// Protocol: ogmios v6 speaks JSON-RPC 2.0 over WebSocket. The
// chainsync mini-protocol exposes two methods we need:
//
//   - findIntersection(points)  — set the start point.
//   - nextBlock()               — pull the next forward / backward event.
//
// Everywhere a "Point" is used it's `{ slot, id }` ('id' is the block
// hash, lowercase hex). 'origin' is a sentinel meaning "before genesis".
//
// We keep the client deliberately small + decoupled from the indexer
// state. It exposes an event-stream-shaped iterator (`run`) that yields
// already-filtered `ChainSyncEvent` values: forward block diffs and
// rollback notifications. Address filtering happens here so the
// downstream state model never has to think about which address an
// output came from.
//
// The class stays test-friendly: the WebSocket layer is injected
// through a constructor parameter so tests can drive it with an
// in-memory fake (test/ogmios.test.ts).

import WebSocket from "ws";

import type { Hex32 } from "../config.js";
import type {
  AddressFilter,
} from "./state.js";
import type {
  BlockDiff,
  ChainTip,
  ProducedUtxo,
  UtxoRef,
} from "./types.js";

/** Ogmios "Point" — chain identity at a slot. */
export interface OgmiosPoint {
  slot: number;
  id: Hex32;
}

/** A forward roll-forward event from chainsync. */
export interface ChainSyncForward {
  kind: "forward";
  block: BlockDiff;
  tip: ChainTip;
}

/** A rollback event — re-positioned to `point`. */
export interface ChainSyncRollback {
  kind: "rollback";
  point: OgmiosPoint | "origin";
  tip: ChainTip | null;
}

export type ChainSyncEvent = ChainSyncForward | ChainSyncRollback;

/**
 * Minimum WebSocket interface the client depends on. `ws` matches it
 * out of the box; the test fake implements it.
 */
export interface OgmiosSocket {
  send(data: string): void;
  close(): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: string | Buffer) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

export interface OgmiosClientConfig {
  url: string;
  filter: AddressFilter;
  /** Custom socket factory — defaults to `ws` against `url`. */
  socketFactory?: (url: string) => OgmiosSocket;
  /**
   * Called when the connection opens. Most callers just `console.log`
   * the URL — the test harness uses it to confirm connection.
   */
  onOpen?: (url: string) => void;
}

/**
 * The ogmios chainsync client. Use `connect()` to open the WebSocket,
 * then `findIntersection(points)` to set the starting point, then loop
 * over `next()` to consume the stream. `close()` tears the socket down.
 *
 * The implementation maintains a single in-flight request at a time —
 * ogmios's chainsync mini-protocol is request-reply, no pipelining.
 */
export class OgmiosClient {
  private socket: OgmiosSocket | null = null;
  private connectedResolver: (() => void) | null = null;
  private connectedPromise: Promise<void>;
  private nextRequestId = 1;
  private inflight: PendingRequest | null = null;
  private readonly closed = { value: false };
  private fatalError: Error | null = null;

  constructor(private readonly config: OgmiosClientConfig) {
    this.connectedPromise = new Promise((resolve) => {
      this.connectedResolver = resolve;
    });
  }

  /** Open the WebSocket; resolves when the `open` event fires. */
  async connect(): Promise<void> {
    if (this.socket) return this.connectedPromise;
    const factory =
      this.config.socketFactory ??
      ((url: string) => new WebSocket(url) as unknown as OgmiosSocket);
    const sock = factory(this.config.url);
    this.socket = sock;
    sock.on("message", (data) => this.onMessage(data));
    sock.on("close", () => {
      this.fatalError ??= new Error("ogmios websocket closed");
      this.failInflight(this.fatalError);
    });
    sock.on("error", (err) => {
      this.fatalError = err;
      this.failInflight(err);
    });
    sock.on("open", () => {
      this.config.onOpen?.(this.config.url);
      this.connectedResolver?.();
      this.connectedResolver = null;
    });
    return this.connectedPromise;
  }

  /**
   * Set the chainsync start point. `points` is an ordered list of
   * candidate intersections; ogmios picks the most recent it knows.
   *
   * Returns the `intersection` it agreed to (which the caller can use
   * to confirm we're starting from where we expected) along with the
   * current tip.
   */
  async findIntersection(
    points: ("origin" | OgmiosPoint)[],
  ): Promise<{ intersection: "origin" | OgmiosPoint; tip: ChainTip }> {
    const result = (await this.request("findIntersection", { points })) as {
      intersection: "origin" | OgmiosPoint;
      tip: OgmiosTip;
    };
    return { intersection: result.intersection, tip: tipFromOgmios(result.tip) };
  }

  /**
   * Pull the next chainsync event. Blocks until ogmios responds — it
   * may delay if there's nothing new at the tip ("Must AwaitReply").
   * The client transparently retries that case so callers see only
   * forward / rollback events.
   */
  async next(): Promise<ChainSyncEvent> {
    while (!this.closed.value) {
      const raw = await this.request("nextBlock", {});
      const result = raw as OgmiosNextBlockResult;
      if (result.direction === "forward") {
        const block = result.block;
        const tip = tipFromOgmios(result.tip);
        const diff = blockToDiff(block, this.config.filter);
        return { kind: "forward", block: diff, tip };
      }
      if (result.direction === "backward") {
        if (!result.point) {
          throw new Error("ogmios: rollback missing point");
        }
        return {
          kind: "rollback",
          point: result.point === "origin" ? "origin" : result.point,
          tip: result.tip ? tipFromOgmios(result.tip) : null,
        };
      }
      // Shouldn't happen — JSON-RPC method should map to one of the
      // two branches.
      throw new Error(`unexpected ogmios direction: ${JSON.stringify(result)}`);
    }
    throw new Error("ogmios client closed");
  }

  close(): void {
    this.closed.value = true;
    this.socket?.close();
    this.failInflight(new Error("ogmios client closed"));
  }

  // -----------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------

  private async request(method: string, params: unknown): Promise<unknown> {
    if (this.fatalError) throw this.fatalError;
    if (this.closed.value) throw new Error("ogmios client closed");
    if (!this.socket) throw new Error("ogmios: connect() not called");
    if (this.inflight) throw new Error("ogmios: a request is already in flight");
    const id = this.nextRequestId++;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
      id,
    });
    return new Promise((resolve, reject) => {
      this.inflight = { id, resolve, reject };
      this.socket!.send(payload);
    });
  }

  private onMessage(data: string | Buffer): void {
    let parsed: JsonRpcResponse;
    try {
      const text = typeof data === "string" ? data : data.toString("utf8");
      parsed = JSON.parse(text) as JsonRpcResponse;
    } catch (err) {
      this.failInflight(err instanceof Error ? err : new Error("ogmios: bad JSON"));
      return;
    }
    const inflight = this.inflight;
    if (!inflight) return;
    if (parsed.id !== inflight.id) return;
    this.inflight = null;
    if (parsed.error) {
      inflight.reject(
        new Error(
          `ogmios JSON-RPC error ${parsed.error.code}: ${parsed.error.message}`,
        ),
      );
      return;
    }
    inflight.resolve(parsed.result);
  }

  private failInflight(err: Error): void {
    const inflight = this.inflight;
    if (!inflight) return;
    this.inflight = null;
    inflight.reject(err);
  }
}

interface PendingRequest {
  id: number;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Ogmios's tip shape — `{slot, id, height}`. 'origin' is also possible. */
type OgmiosTip = { slot: number; id: string; height?: number } | "origin";

function tipFromOgmios(t: OgmiosTip): ChainTip {
  if (t === "origin") return { slot: 0, blockHash: "00".repeat(32), height: 0 };
  return { slot: t.slot, blockHash: t.id, height: t.height ?? 0 };
}

interface OgmiosBlock {
  slot: number;
  id: string;
  height: number;
  transactions?: OgmiosTransaction[];
}

interface OgmiosTransaction {
  inputs?: { transaction: { id: string }; index: number }[];
  outputs?: OgmiosOutput[];
}

interface OgmiosOutput {
  address: string;
  value: { ada?: { lovelace: number | string }; [policy: string]: unknown };
  datum?: string;
  datumHash?: string;
}

interface OgmiosNextBlockResult {
  direction: "forward" | "backward";
  block: OgmiosBlock;
  tip: OgmiosTip;
  point?: OgmiosPoint | "origin";
}

/**
 * Translate an ogmios block into our `BlockDiff`. Filtering by address
 * happens here — outputs at irrelevant addresses are discarded so the
 * indexer state never sees them.
 */
export function blockToDiff(block: OgmiosBlock, filter: AddressFilter): BlockDiff {
  const diff: BlockDiff = {
    slot: block.slot,
    blockHash: block.id,
    height: block.height,
    consumed: [],
    produced: [],
  };
  const txs = block.transactions ?? [];
  for (const tx of txs) {
    for (const input of tx.inputs ?? []) {
      const ref: UtxoRef = {
        txId: input.transaction.id.toLowerCase(),
        outputIndex: input.index,
      };
      diff.consumed.push(ref);
    }
    const outputs = tx.outputs ?? [];
    for (let i = 0; i < outputs.length; i++) {
      const out = outputs[i]!;
      const produced = parseOutput(out, txIdOfTx(tx, block, i), i);
      if (!produced) continue;
      const isMixBox = produced.address === filter.mixBoxAddress;
      const isFee = produced.address === filter.feeContractAddress;
      const isReference = produced.assets[filter.referenceNftUnit] === 1n;
      if (!isMixBox && !isFee && !isReference) continue;
      diff.produced.push(produced);
    }
  }
  return diff;
}

/**
 * Ogmios doesn't expose tx ids on every output entry — it puts them on
 * the parent transaction. This indirection just papers over that.
 */
function txIdOfTx(tx: OgmiosTransaction, block: OgmiosBlock, _outputIndex: number): string {
  // ogmios v6 emits the tx id at `tx.id`; older shapes had it as `tx.hash`.
  // Both are 64 hex chars.
  const id = (tx as { id?: string; hash?: string }).id ?? (tx as { hash?: string }).hash;
  if (typeof id === "string") return id.toLowerCase();
  // Fallback — shouldn't trigger in practice; surfaces obvious crash so
  // we notice schema drift.
  throw new Error(
    `ogmios block ${block.id} missing tx id on transaction ${JSON.stringify(tx).slice(0, 200)}`,
  );
}

function parseOutput(out: OgmiosOutput, txId: string, index: number): ProducedUtxo | null {
  if (typeof out.address !== "string") return null;
  const lovelace = parseLovelace(out.value);
  const assets = parseAssets(out.value);
  return {
    ref: { txId, outputIndex: index },
    address: out.address,
    lovelace,
    inlineDatumHex: typeof out.datum === "string" ? out.datum : null,
    assets,
  };
}

function parseLovelace(value: OgmiosOutput["value"]): bigint {
  const ada = value?.ada;
  if (ada && ada.lovelace !== undefined) {
    return BigInt(ada.lovelace as number | string);
  }
  return 0n;
}

function parseAssets(value: OgmiosOutput["value"]): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const [policyId, assetMap] of Object.entries(value)) {
    if (policyId === "ada") continue;
    if (assetMap === null || typeof assetMap !== "object") continue;
    for (const [name, qty] of Object.entries(assetMap as Record<string, unknown>)) {
      const unit = `${policyId}${name}`;
      out[unit] = BigInt(qty as number | string);
    }
  }
  return out;
}
