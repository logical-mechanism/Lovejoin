// IndexerRuntime — chainsync loop + in-process reconnect.
//
// We drive the runtime against an in-memory `FakeSocket` factory that
// hands out a configurable sequence of sockets, one per
// `OgmiosClient` the runtime constructs. That lets us script the
// happy-path reconnect (close → fresh socket → resume from state.tip)
// and the give-up path (every fresh socket rejects).
//
// The IndexerState we feed in is the real one (not stubbed) so the
// "resume from state.tip" assertion exercises the actual interaction.

import { describe, expect, it } from "vitest";

import { IndexerRuntime } from "../src/indexer/runtime.js";
import { IndexerState, type AddressFilter } from "../src/indexer/state.js";
import type { OgmiosSocket } from "../src/indexer/ogmios.js";
import type { LovejoinAddresses } from "../src/config.js";

// ------------------------------------------------------------------
// Test fixtures
// ------------------------------------------------------------------

const MIX_ADDR = "addr_test1mix";
const FEE_ADDR = "addr_test1fee";
const REF_POLICY = "deadbeef".repeat(7);
const REF_ASSET = "6c6f76656a6f696e";

const FILTER: AddressFilter = {
  mixBoxAddress: MIX_ADDR,
  feeContractAddress: FEE_ADDR,
  referenceNftUnit: REF_POLICY + REF_ASSET,
};

const ADDRESSES = {
  network: "preprod",
  referenceNftPolicy: REF_POLICY,
  referenceNftAssetName: REF_ASSET,
  referenceUtxoRef: "ab".repeat(32) + "#0",
  protocol: { denom_lovelace: "10000000", max_fee_per_mix_lovelace: "800000" },
} as unknown as LovejoinAddresses;

const SILENT_LOGGER = {
  info: (_: string) => {},
  warn: (_: string) => {},
  error: (_: string) => {},
};

// A scripted forward block; the runtime applies it, state.tip advances.
function forwardBlock(slot: number, blockHashByte: string): unknown {
  return {
    direction: "forward",
    block: {
      slot,
      id: blockHashByte.repeat(32),
      height: slot,
      // Empty txs → diff is empty → nothing to write to the pool, but
      // state.tip still advances. That's all this test needs.
      transactions: [],
    },
    tip: { slot: slot + 10, id: "ff".repeat(32), height: slot + 10 },
  };
}

// ------------------------------------------------------------------
// FakeSocket — controllable per-instance ogmios responder.
// ------------------------------------------------------------------

interface ScriptedSession {
  /** Fail the open event with this error. Mutually exclusive with handlers. */
  failOpen?: Error;
  /** Map of method → response builder; called once per matching request. */
  handlers?: Record<string, (id: number) => unknown>;
  /**
   * After how many handled requests should the socket close itself?
   * Used to simulate a mid-flight drop: 1 = close after the first
   * nextBlock response.
   */
  closeAfterRequests?: number;
}

interface SessionState {
  script: ScriptedSession;
  socket: FakeSocket | null;
  requestCount: number;
}

class FakeSocket implements OgmiosSocket {
  private messageHandlers: ((data: string | Buffer) => void)[] = [];
  private openHandlers: (() => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  private errorHandlers: ((err: Error) => void)[] = [];
  closed = false;

  constructor(
    private readonly state: SessionState,
    private readonly factoryOnSend: (
      sock: FakeSocket,
      payload: { method: string; id: number },
    ) => void,
  ) {}

  send(data: string): void {
    queueMicrotask(() => {
      const parsed = JSON.parse(data) as { method: string; id: number };
      this.state.requestCount += 1;
      this.factoryOnSend(this, parsed);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.closeHandlers) h();
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    if (event === "open") this.openHandlers.push(listener as () => void);
    else if (event === "message") this.messageHandlers.push(listener as (d: string) => void);
    else if (event === "close") this.closeHandlers.push(listener as () => void);
    else if (event === "error") this.errorHandlers.push(listener as (e: Error) => void);
  }

  emit(payload: string): void {
    for (const h of this.messageHandlers) h(payload);
  }

  fireOpen(): void {
    for (const h of this.openHandlers) h();
  }

  fireError(err: Error): void {
    for (const h of this.errorHandlers) h(err);
  }
}

/**
 * Build a socketFactory that walks through a scripted sequence of
 * sessions. The `i`-th `OgmiosClient` constructed by the runtime gets
 * the `i`-th session. If the runtime asks for more sessions than
 * scripted, the factory throws — which surfaces test bugs early.
 */
function scriptedFactory(sessions: ScriptedSession[]): {
  factory: (url: string) => OgmiosSocket;
  sessions: SessionState[];
} {
  const states: SessionState[] = sessions.map((script) => ({
    script,
    socket: null,
    requestCount: 0,
  }));
  let cursor = 0;
  const factory = (_url: string): OgmiosSocket => {
    const state = states[cursor];
    cursor += 1;
    if (!state) {
      throw new Error(
        `scriptedFactory: runtime asked for session ${cursor} but only ${states.length} were scripted`,
      );
    }
    const sock = new FakeSocket(state, (s, payload) => {
      const handler = state.script.handlers?.[payload.method];
      if (!handler) {
        // Unscripted method during a "fail to connect" session — drop.
        return;
      }
      const response = handler(payload.id);
      if (response !== undefined) {
        s.emit(JSON.stringify(response));
      }
      if (
        state.script.closeAfterRequests !== undefined &&
        state.requestCount >= state.script.closeAfterRequests
      ) {
        // Defer to next microtask so the in-flight resolve() runs first.
        queueMicrotask(() => s.close());
      }
    });
    state.socket = sock;
    if (state.script.failOpen) {
      const err = state.script.failOpen;
      queueMicrotask(() => sock.fireError(err));
    } else {
      queueMicrotask(() => sock.fireOpen());
    }
    return sock;
  };
  return { factory, sessions: states };
}

// Wait until `predicate()` returns true, polling on microtask boundaries.
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: timeout");
    await new Promise((r) => setImmediate(r));
  }
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe("IndexerRuntime: chainsync reconnect", () => {
  it("rebuilds the OgmiosClient after a transient drop and resumes from state.tip", async () => {
    const intersection = (id: number) => ({
      jsonrpc: "2.0",
      id,
      result: {
        intersection: "origin",
        tip: { slot: 10, id: "00".repeat(32), height: 10 },
      },
    });

    // Session 1: handshake, deliver block at slot 100, then drop.
    // Session 2: handshake, resume from slot-100 intersection, deliver
    // block at slot 200, then go silent so the runtime loop parks on
    // its next request (instead of a hot-loop that would starve the
    // test's setImmediate-based waitFor).
    const findIntersectionCalls: Array<unknown> = [];
    let session1NextBlockServed = 0;
    let session2NextBlockServed = 0;
    const session1: ScriptedSession = {
      handlers: {
        findIntersection: (id) => intersection(id),
        nextBlock: (id) => {
          session1NextBlockServed += 1;
          if (session1NextBlockServed > 1) return undefined;
          return { jsonrpc: "2.0", id, result: forwardBlock(100, "aa") };
        },
      },
      closeAfterRequests: 2, // findIntersection + nextBlock, then drop
    };
    const session2: ScriptedSession = {
      handlers: {
        findIntersection: (id) => ({
          jsonrpc: "2.0",
          id,
          result: {
            intersection: { slot: 100, id: "aa".repeat(32) },
            tip: { slot: 220, id: "ff".repeat(32), height: 220 },
          },
        }),
        nextBlock: (id) => {
          session2NextBlockServed += 1;
          if (session2NextBlockServed > 1) return undefined;
          return { jsonrpc: "2.0", id, result: forwardBlock(200, "bb") };
        },
      },
    };

    const { factory, sessions } = scriptedFactory([session1, session2]);

    // Capture findIntersection request payloads so we can assert the
    // resume-point on the second session.
    const wrappedFactory = (url: string): OgmiosSocket => {
      const sock = factory(url);
      const origSend = sock.send.bind(sock);
      sock.send = (data: string) => {
        const parsed = JSON.parse(data) as { method: string; params: unknown };
        if (parsed.method === "findIntersection") {
          findIntersectionCalls.push(parsed.params);
        }
        origSend(data);
      };
      return sock;
    };

    const state = new IndexerState(ADDRESSES, FILTER, 800_000n);
    const runtime = new IndexerRuntime(state, {
      ogmiosUrl: "ws://test",
      filter: FILTER,
      logger: SILENT_LOGGER,
      socketFactory: wrappedFactory,
      sleepMs: () => Promise.resolve(),
      random: () => 0.5,
    });

    await runtime.start();
    // Wait until the second block has been applied.
    await waitFor(() => state.tip?.slot === 200);
    await runtime.stop();

    expect(state.tip).not.toBeNull();
    expect(state.tip?.slot).toBe(200);
    expect(runtime.fatalError()).toBeNull();
    expect(runtime.reconnecting().inProgress).toBe(false);
    // Reconnect counter resets to 0 after a successful resume.
    expect(runtime.reconnecting().attempts).toBe(0);
    // First findIntersection asked for "origin" (default startPoints);
    // second asked for the slot-100 tip we'd just applied.
    expect(findIntersectionCalls).toHaveLength(2);
    expect(findIntersectionCalls[0]).toEqual({ points: ["origin"] });
    expect(findIntersectionCalls[1]).toEqual({
      points: [{ slot: 100, id: "aa".repeat(32) }],
    });
    // Both sessions were used.
    expect(sessions[0]?.socket?.closed).toBe(true);
    expect(sessions[1]?.socket?.closed).toBe(true);
  });

  it("goes fatal after maxReconnectAttempts when reconnect keeps failing", async () => {
    // Session 1: deliver one block, then drop. Sessions 2 + 3: every
    // open fires an error (connect rejects). With max=2, the second
    // failure trips the give-up path.
    const session1: ScriptedSession = {
      handlers: {
        findIntersection: (id) => ({
          jsonrpc: "2.0",
          id,
          result: {
            intersection: "origin",
            tip: { slot: 10, id: "00".repeat(32), height: 10 },
          },
        }),
        nextBlock: (id) => ({
          jsonrpc: "2.0",
          id,
          result: forwardBlock(50, "11"),
        }),
      },
      closeAfterRequests: 2,
    };
    const failingSession = (msg: string): ScriptedSession => ({
      failOpen: new Error(msg),
    });

    const { factory } = scriptedFactory([
      session1,
      failingSession("ECONNREFUSED 127.0.0.1:1337"),
      failingSession("ECONNREFUSED 127.0.0.1:1337"),
    ]);

    const state = new IndexerState(ADDRESSES, FILTER, 800_000n);
    const runtime = new IndexerRuntime(state, {
      ogmiosUrl: "ws://test",
      filter: FILTER,
      logger: SILENT_LOGGER,
      socketFactory: factory,
      maxReconnectAttempts: 2,
      sleepMs: () => Promise.resolve(),
      random: () => 0.5,
    });

    await runtime.start();
    await waitFor(() => runtime.fatalError() !== null);

    expect(runtime.isRunning()).toBe(false);
    expect(runtime.fatalError()?.message).toMatch(/chainsync reconnect failed after 2 attempts/);
    expect(runtime.reconnecting().inProgress).toBe(false);
    expect(runtime.reconnecting().lastErrorMessage).toMatch(/ECONNREFUSED/);

    await runtime.stop();
  });

  it("treats intersection: 'origin' on resume as a deep-rollback fatal (no further retries)", async () => {
    // Session 1: deliver a block at slot 50, then drop.
    // Session 2: findIntersection returns intersection: "origin" even
    // though we asked for our applied tip — upstream node has rolled
    // past us. Runtime must go fatal immediately, not retry.
    const session1: ScriptedSession = {
      handlers: {
        findIntersection: (id) => ({
          jsonrpc: "2.0",
          id,
          result: {
            intersection: "origin",
            tip: { slot: 10, id: "00".repeat(32), height: 10 },
          },
        }),
        nextBlock: (id) => ({
          jsonrpc: "2.0",
          id,
          result: forwardBlock(50, "33"),
        }),
      },
      closeAfterRequests: 2,
    };
    const session2: ScriptedSession = {
      handlers: {
        findIntersection: (id) => ({
          jsonrpc: "2.0",
          id,
          result: {
            intersection: "origin",
            tip: { slot: 9999, id: "ff".repeat(32), height: 9999 },
          },
        }),
      },
    };

    const { factory } = scriptedFactory([session1, session2]);
    const state = new IndexerState(ADDRESSES, FILTER, 800_000n);
    const runtime = new IndexerRuntime(state, {
      ogmiosUrl: "ws://test",
      filter: FILTER,
      logger: SILENT_LOGGER,
      socketFactory: factory,
      maxReconnectAttempts: 10, // we expect fatal *before* exhausting attempts
      sleepMs: () => Promise.resolve(),
    });

    await runtime.start();
    await waitFor(() => runtime.fatalError() !== null);

    expect(runtime.fatalError()?.message).toMatch(/rolled past indexer tip/);
    // Should have gone fatal on the *first* reconnect attempt, not waited
    // for the maxReconnectAttempts cap.
    expect(runtime.reconnecting().attempts).toBeLessThanOrEqual(1);

    await runtime.stop();
  });
});
