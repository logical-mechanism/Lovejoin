// OgmiosTxClient — bounded reconnect with backoff + circuit breaker.
//
// Mirrors the runtime.test.ts scripted-FakeSocket harness so we can
// drive the request-driven OgmiosTxClient against a sequence of
// reconnect outcomes without a live ogmios. The fake fires only the
// `error` event on a failed open; production `ws` follows error with
// close, but our error handler clears `connected` defensively so a
// single fired event is enough to drive the next iteration.

import { describe, expect, it } from "vitest";

import { OgmiosTxClient, type OgmiosTxSocket } from "../src/indexer/ogmios-tx.js";

interface ScriptedSession {
  /** Fail the open event with this error. Mutually exclusive with handlers. */
  failOpen?: Error;
  /** Map of method → response builder; called once per matching request. */
  handlers?: Record<string, (id: number) => unknown>;
}

interface SessionState {
  script: ScriptedSession;
  socket: FakeSocket | null;
  requestCount: number;
}

class FakeSocket implements OgmiosTxSocket {
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

function scriptedFactory(sessions: ScriptedSession[]): {
  factory: (url: string) => OgmiosTxSocket;
  sessions: SessionState[];
  cursor: () => number;
} {
  const states: SessionState[] = sessions.map((script) => ({
    script,
    socket: null,
    requestCount: 0,
  }));
  let cursor = 0;
  const factory = (_url: string): OgmiosTxSocket => {
    const state = states[cursor];
    cursor += 1;
    if (!state) {
      throw new Error(
        `scriptedFactory: client asked for session ${cursor} but only ${states.length} were scripted`,
      );
    }
    const sock = new FakeSocket(state, (s, payload) => {
      const handler = state.script.handlers?.[payload.method];
      if (!handler) return;
      const response = handler(payload.id);
      if (response !== undefined) {
        s.emit(JSON.stringify(response));
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
  return { factory, sessions: states, cursor: () => cursor };
}

describe("OgmiosTxClient: bounded reconnect", () => {
  it("does not attempt more than maxReconnectAttempts reconnects in the face of a hard upstream failure", async () => {
    // First open succeeds; the next 5 opens fail. With max=3, the
    // first /submit triggers up to 3 reconnect attempts and then trips
    // the circuit. We script 4 failing sessions to prove the client
    // never asks for a 5th — i.e. it stops on the cap, not on running
    // out of script.
    const okSubmit = (id: number): unknown => ({
      jsonrpc: "2.0",
      id,
      result: { transaction: { id: "ab".repeat(32) } },
    });
    const session0: ScriptedSession = {
      handlers: { submitTransaction: okSubmit },
    };
    const failing = (msg: string): ScriptedSession => ({ failOpen: new Error(msg) });

    const { factory, cursor } = scriptedFactory([
      session0,
      failing("ECONNREFUSED 127.0.0.1:1337"),
      failing("ECONNREFUSED 127.0.0.1:1337"),
      failing("ECONNREFUSED 127.0.0.1:1337"),
      failing("ECONNREFUSED 127.0.0.1:1337"),
    ]);

    const client = new OgmiosTxClient({
      url: "ws://test",
      socketFactory: factory,
      maxReconnectAttempts: 3,
      sleepMs: () => Promise.resolve(),
      random: () => 0.5,
    });

    // First call succeeds — primes the live socket.
    const first = await client.submitTransaction("aa");
    expect(first).toBe("ab".repeat(32));
    expect(cursor()).toBe(1);

    // Kill the live socket so the next request must reconnect.
    const session0Sock = (client as unknown as { socket: FakeSocket | null }).socket;
    expect(session0Sock).not.toBeNull();
    session0Sock!.close();

    // Next /submit drives the bounded reconnect cycle. Every retry
    // fails, so the client should hit the cap and trip the circuit.
    await expect(client.submitTransaction("aa")).rejects.toThrow(/upstream unavailable/);

    expect(client.reconnecting().exhausted).toBe(true);
    expect(client.reconnecting().attempts).toBe(3);
    // The factory was asked for exactly 1 (initial) + 3 (reconnect cap) = 4 sockets.
    // Crucially, NOT 5 — the cap held even though the script had a 5th available.
    expect(cursor()).toBe(4);
    expect(client.reconnecting().lastErrorMessage).toMatch(/ECONNREFUSED/);

    client.close();
  });

  it("returns submit_unavailable shape on the next request after exhaustion (no queue, no further reconnects)", async () => {
    const session0: ScriptedSession = {
      handlers: {
        submitTransaction: (id) => ({
          jsonrpc: "2.0",
          id,
          result: { transaction: { id: "cc".repeat(32) } },
        }),
      },
    };
    const failing = (): ScriptedSession => ({ failOpen: new Error("ECONNREFUSED") });

    const { factory, cursor } = scriptedFactory([session0, failing(), failing()]);
    const client = new OgmiosTxClient({
      url: "ws://test",
      socketFactory: factory,
      maxReconnectAttempts: 2,
      sleepMs: () => Promise.resolve(),
      random: () => 0.5,
    });

    // Prime the socket then close it so the next request reconnects.
    await client.submitTransaction("aa");
    (client as unknown as { socket: FakeSocket | null }).socket?.close();

    // First post-drop request exhausts the reconnect cycle.
    await expect(client.submitTransaction("aa")).rejects.toThrow();
    expect(client.reconnecting().exhausted).toBe(true);
    const cursorAfterExhaustion = cursor();

    // Second post-drop request must NOT trigger any further reconnect
    // attempts — the factory cursor should be unchanged. The error
    // message carries the "upstream unavailable" shape that the route
    // translates into a 503 / submit_unavailable.
    await expect(client.submitTransaction("aa")).rejects.toThrow(/upstream unavailable/);
    expect(cursor()).toBe(cursorAfterExhaustion);

    client.close();
  });

  it("resets the attempt counter after a successful reconnect", async () => {
    const okSubmit = (id: number): unknown => ({
      jsonrpc: "2.0",
      id,
      result: { transaction: { id: "dd".repeat(32) } },
    });
    // Initial connect, then 2 failures, then success on the 4th open.
    // Subsequent close + reconnect should start counting from 0 again.
    const session0: ScriptedSession = { handlers: { submitTransaction: okSubmit } };
    const failing = (): ScriptedSession => ({ failOpen: new Error("ECONNREFUSED") });
    const session3: ScriptedSession = { handlers: { submitTransaction: okSubmit } };
    const session4: ScriptedSession = { handlers: { submitTransaction: okSubmit } };

    const { factory } = scriptedFactory([session0, failing(), failing(), session3, session4]);
    const client = new OgmiosTxClient({
      url: "ws://test",
      socketFactory: factory,
      maxReconnectAttempts: 5,
      sleepMs: () => Promise.resolve(),
      random: () => 0.5,
    });

    // Prime + drop.
    await client.submitTransaction("aa");
    (client as unknown as { socket: FakeSocket | null }).socket?.close();

    // Bounded reconnect: 2 fails, 1 success. Should produce a successful
    // submit and reset the attempt counter to 0.
    const second = await client.submitTransaction("aa");
    expect(second).toBe("dd".repeat(32));
    expect(client.reconnecting().exhausted).toBe(false);
    expect(client.reconnecting().attempts).toBe(0);
    expect(client.reconnecting().inProgress).toBe(false);

    // Drop again — the next reconnect cycle must start counting from 0,
    // not from 2 (the prior cycle's attempt count).
    (client as unknown as { socket: FakeSocket | null }).socket?.close();
    const third = await client.submitTransaction("aa");
    expect(third).toBe("dd".repeat(32));
    expect(client.reconnecting().attempts).toBe(0);

    client.close();
  });
});
