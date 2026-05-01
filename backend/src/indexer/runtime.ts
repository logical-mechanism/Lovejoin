// Indexer runtime — owns the chainsync loop and feeds events into the
// in-memory IndexerState. Pulls these two together so the API server
// can just hold a state pointer.
//
// Lifecycle:
//   1. start(): connect to ogmios + find intersection.
//   2. The loop pulls one event at a time and applies it to state.
//   3. stop(): close the socket, await the loop to exit.
//
// Connection resilience:
//   The chainsync WebSocket can drop transiently — e.g., when the
//   container tunnels to ogmios via Cloudflare Access and a tunnel
//   session cycles. The loop catches the read error, rebuilds the
//   OgmiosClient, and resumes from `state.tip` with exponential backoff.
//   Only after `maxReconnectAttempts` consecutive failures does the
//   runtime go fatal and let the supervisor (DO App Platform) restart
//   the container. While reconnecting, the rest of the API keeps
//   serving from cached in-memory state — `/health` stays 200.
//
// Errors during apply are logged but don't kill the runtime — except
// `DeepRollbackError`, which is intentionally fatal: we can't safely
// continue if the indexer's reverse buffer can't reach the rollback
// target. Same goes for an `intersection: "origin"` response on a
// reconnect resume — the upstream node has rolled past our tip and a
// fresh container needs to walk forward from the bootstrap point.

import { DeepRollbackError, type AddressFilter, type IndexerState } from "./state.js";
import {
  OgmiosClient,
  type ChainSyncEvent,
  type OgmiosPoint,
  type OgmiosSocket,
} from "./ogmios.js";

/** A logging surface — Fastify's logger fits the shape. */
export interface RuntimeLogger {
  info(msg: string, ctx?: unknown): void;
  warn(msg: string, ctx?: unknown): void;
  error(msg: string, ctx?: unknown): void;
}

export interface RuntimeConfig {
  ogmiosUrl: string;
  filter: AddressFilter;
  /**
   * Optional starting points. Defaults to `["origin"]` — the indexer
   * replays from genesis. Production deployments should pass a recent
   * intersection (e.g. backed by a snapshot).
   */
  startPoints?: ("origin" | OgmiosPoint)[];
  logger: RuntimeLogger;
  /**
   * Optional socket factory threaded through to every `OgmiosClient`
   * the runtime constructs (start + each reconnect). Tests inject a
   * fake; production uses the default `ws` WebSocket.
   */
  socketFactory?: (url: string) => OgmiosSocket;
  /**
   * Max consecutive reconnect attempts before giving up and going
   * fatal. Default 30 — with the 10 s backoff cap that's ~5 min of
   * wall clock, enough to ride out cloudflared / network blips
   * without papering over a real outage.
   */
  maxReconnectAttempts?: number;
  /**
   * Sleep override for tests so they don't actually wait the backoff.
   * Production uses a `setTimeout`-backed sleep.
   */
  sleepMs?: (ms: number) => Promise<void>;
  /** Random source for jitter; tests pin it to keep delays deterministic. */
  random?: () => number;
}

/** Snapshot of the runtime's in-flight reconnect state, exposed to /health. */
export interface ReconnectStatus {
  /** True while a reconnect cycle is currently retrying. */
  inProgress: boolean;
  /** Number of attempts in the current cycle (0 when idle). */
  attempts: number;
  /** Epoch ms of the most recent reconnect-relevant error; 0 when never. */
  lastErrorAt: number;
  /** Message from the most recent reconnect-relevant error; empty when none. */
  lastErrorMessage: string;
}

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 30;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class IndexerRuntime {
  private client: OgmiosClient | null = null;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private fatal: Error | null = null;
  /**
   * The most recent tip ogmios has told us about (separate from the
   * indexer's own applied tip). Used by `/health` to compute lag as
   * the slot difference between chain-tip and indexer-tip.
   */
  private chainTip_: { slot: number; blockHash: string; height: number } | null = null;

  // Reconnect bookkeeping. `attempts` counts the *current* cycle and
  // resets to 0 on a successful reconnect (or when no reconnect is
  // in progress). `lastError*` persist across cycles so /health can
  // surface what most recently caused trouble.
  private reconnectInProgress = false;
  private reconnectAttempts = 0;
  private lastReconnectErrorAt = 0;
  private lastReconnectErrorMessage = "";

  constructor(
    private readonly state: IndexerState,
    private readonly config: RuntimeConfig,
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  fatalError(): Error | null {
    return this.fatal;
  }

  chainTip(): { slot: number; blockHash: string; height: number } | null {
    return this.chainTip_;
  }

  reconnecting(): ReconnectStatus {
    return {
      inProgress: this.reconnectInProgress,
      attempts: this.reconnectAttempts,
      lastErrorAt: this.lastReconnectErrorAt,
      lastErrorMessage: this.lastReconnectErrorMessage,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.client = this.buildClient();
    await this.client.connect();
    const points = this.config.startPoints ?? ["origin"];
    const inter = await this.client.findIntersection(points);
    this.config.logger.info(
      `chainsync intersection found at ${
        inter.intersection === "origin" ? "origin" : `slot ${inter.intersection.slot}`
      }; tip slot ${inter.tip.slot}`,
    );
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.client?.close();
    if (this.loopPromise) {
      try {
        await this.loopPromise;
      } catch {
        // we're shutting down — ignore loop errors
      }
    }
  }

  private buildClient(): OgmiosClient {
    // Spread the optional socketFactory so we don't materialise an
    // explicit `undefined` property — exactOptionalPropertyTypes
    // distinguishes "field absent" from "field present and undefined".
    return new OgmiosClient({
      url: this.config.ogmiosUrl,
      filter: this.config.filter,
      onOpen: (url) => this.config.logger.info(`ogmios connected at ${url}`),
      ...(this.config.socketFactory ? { socketFactory: this.config.socketFactory } : {}),
    });
  }

  private async loop(): Promise<void> {
    while (this.running && this.client) {
      let event: ChainSyncEvent;
      try {
        event = await this.client.next();
      } catch (err) {
        if (!this.running) return;
        const recovered = await this.tryReconnect(err);
        if (!recovered) return;
        continue;
      }
      try {
        this.applyEvent(event);
      } catch (err) {
        if (err instanceof DeepRollbackError) {
          this.fatal = err;
          this.config.logger.error(
            `deep rollback past buffer: ${err.message} — runtime halting for resync`,
          );
          this.running = false;
          return;
        }
        this.config.logger.error(
          `chainsync apply failed at slot ${
            event.kind === "forward" ? event.block.slot : "rollback"
          }: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Non-fatal: keep going. The buffer is unchanged for forward
        // events that throw (apply is all-or-nothing per block).
      }
    }
  }

  /**
   * Tear down the dead chainsync client and try to bring up a fresh
   * one, resuming from the indexer's last applied tip. Returns `true`
   * once a new client is connected and ready for the loop to call
   * `.next()` on; returns `false` after `maxReconnectAttempts` tries,
   * with `this.fatal` and `this.running` set so the loop exits.
   *
   * Two conditions are *not* retried:
   *   - The runtime was stopped while a reconnect was in flight.
   *   - Ogmios returned `intersection: "origin"` for a non-empty state
   *     (deep rollback past our tip; same as the in-loop fatal at
   *     `applyEvent`'s rollback-to-origin branch).
   */
  private async tryReconnect(initialErr: unknown): Promise<boolean> {
    this.reconnectInProgress = true;
    this.reconnectAttempts = 0;
    this.recordReconnectError(initialErr);
    this.config.logger.warn(
      `chainsync read failed: ${this.lastReconnectErrorMessage}; reconnecting`,
    );

    const maxAttempts = this.config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    const sleep = this.config.sleepMs ?? defaultSleep;

    while (this.running) {
      this.reconnectAttempts += 1;
      try {
        try {
          this.client?.close();
        } catch {
          // close is best-effort; the socket may already be torn down.
        }
        this.client = null;

        const fresh = this.buildClient();
        await fresh.connect();
        const resumePoints = this.resumePoints();
        const inter = await fresh.findIntersection(resumePoints);

        if (inter.intersection === "origin" && this.state.tip !== null) {
          // Asked for our applied tip; ogmios doesn't know it. The
          // upstream node has rolled past our state — a fresh
          // container is the only safe recovery (it walks from the
          // bootstrap start point and rebuilds state).
          try {
            fresh.close();
          } catch {
            // ignore
          }
          this.fatal = new Error(
            "chainsync reconnect: ogmios rolled past indexer tip — restart required",
          );
          this.config.logger.error(this.fatal.message);
          this.running = false;
          this.reconnectInProgress = false;
          return false;
        }

        this.client = fresh;
        this.config.logger.info(
          `chainsync resumed at ${
            inter.intersection === "origin" ? "origin" : `slot ${inter.intersection.slot}`
          }; tip slot ${inter.tip.slot} (after ${this.reconnectAttempts} attempt${
            this.reconnectAttempts === 1 ? "" : "s"
          })`,
        );
        this.reconnectInProgress = false;
        this.reconnectAttempts = 0;
        return true;
      } catch (err) {
        this.recordReconnectError(err);
        this.config.logger.warn(
          `chainsync reconnect attempt ${this.reconnectAttempts} failed: ${this.lastReconnectErrorMessage}`,
        );
        if (this.reconnectAttempts >= maxAttempts) break;
        await sleep(this.backoffMs(this.reconnectAttempts));
      }
    }

    if (!this.running) {
      // stop() was called mid-reconnect. Don't set fatal — clean shutdown.
      this.reconnectInProgress = false;
      return false;
    }

    this.fatal = new Error(
      `chainsync reconnect failed after ${this.reconnectAttempts} attempts: ${this.lastReconnectErrorMessage}`,
    );
    this.config.logger.error(this.fatal.message);
    this.running = false;
    this.reconnectInProgress = false;
    return false;
  }

  private recordReconnectError(err: unknown): void {
    this.lastReconnectErrorMessage = err instanceof Error ? err.message : String(err);
    this.lastReconnectErrorAt = Date.now();
  }

  /**
   * Pick the resume intersection for a reconnect: the indexer's last
   * applied tip if we have one, otherwise the configured start points.
   * A single-point list is enough — ogmios either accepts it or
   * returns "origin", and we treat the latter as the deep-rollback
   * fatal above.
   */
  private resumePoints(): ("origin" | OgmiosPoint)[] {
    const tip = this.state.tip;
    if (tip) {
      return [{ slot: tip.slot, id: tip.blockHash }];
    }
    return this.config.startPoints ?? ["origin"];
  }

  private backoffMs(attempt: number): number {
    // 1s, 2s, 4s, 8s, then capped at 10s; ±20% jitter so a herd of
    // reconnecting instances doesn't synchronise.
    const base = Math.min(10_000, 1000 * Math.pow(2, attempt - 1));
    const random = (this.config.random ?? Math.random)();
    const jitter = 0.8 + 0.4 * random;
    return Math.floor(base * jitter);
  }

  private applyEvent(event: ChainSyncEvent): void {
    if (event.kind === "forward") {
      if (event.tip) this.chainTip_ = event.tip;
      this.state.applyForward(event.block);
      return;
    }
    if (event.tip) this.chainTip_ = event.tip;
    if (event.point === "origin") {
      // Ogmios's chainsync emits "rollback to origin" as the first
      // backward event after `findIntersection(["origin"])` — it's
      // the protocol's way of saying "your starting point is genesis,
      // begin from here." If our state is already at origin (no
      // buffered blocks), treat it as a no-op handshake. Otherwise
      // it's a deep rollback past the buffer's reach and we can't
      // recover — surface as fatal so the supervisor restarts us.
      if (this.state.bufferDepth() === 0 && this.state.tip === null) {
        return;
      }
      throw new Error("rollback to origin past indexer state — restart required");
    }
    this.state.applyRollback({
      slot: event.point.slot,
      blockHash: event.point.id,
      height: event.tip?.height ?? 0,
    });
  }
}
