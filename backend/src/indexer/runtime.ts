// Indexer runtime — owns the chainsync loop and feeds events into the
// in-memory IndexerState. Pulls these two together so the API server
// can just hold a state pointer.
//
// Lifecycle:
//   1. start(): connect to ogmios + find intersection.
//   2. The loop pulls one event at a time and applies it to state.
//   3. stop(): close the socket, await the loop to exit.
//
// Errors during apply are logged but don't kill the runtime — except
// `DeepRollbackError`, which is intentionally fatal: we can't safely
// continue if the indexer's reverse buffer can't reach the rollback
// target. The runtime is expected to be supervised so its supervisor
// restarts it from a fresh snapshot.

import {
  DeepRollbackError,
  type AddressFilter,
  type IndexerState,
} from "./state.js";
import { OgmiosClient, type ChainSyncEvent, type OgmiosPoint } from "./ogmios.js";

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
}

export class IndexerRuntime {
  private client: OgmiosClient | null = null;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private fatal: Error | null = null;

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

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.client = new OgmiosClient({
      url: this.config.ogmiosUrl,
      filter: this.config.filter,
      onOpen: (url) => this.config.logger.info(`ogmios connected at ${url}`),
    });
    await this.client.connect();
    const points = this.config.startPoints ?? ["origin"];
    const inter = await this.client.findIntersection(points);
    this.config.logger.info(
      `chainsync intersection found at ${
        inter.intersection === "origin"
          ? "origin"
          : `slot ${inter.intersection.slot}`
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

  private async loop(): Promise<void> {
    while (this.running && this.client) {
      let event: ChainSyncEvent;
      try {
        event = await this.client.next();
      } catch (err) {
        if (!this.running) return;
        this.fatal = err instanceof Error ? err : new Error(String(err));
        this.config.logger.error(`chainsync read failed: ${this.fatal.message}`);
        this.running = false;
        return;
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

  private applyEvent(event: ChainSyncEvent): void {
    if (event.kind === "forward") {
      this.state.applyForward(event.block);
      return;
    }
    if (event.point === "origin") {
      // Rollback to genesis — re-init state and restart from origin.
      // We don't currently mutate state for an origin rollback; a
      // production deployment would re-create the IndexerState from
      // scratch. Surface as an error so the supervisor can reset.
      throw new Error("rollback to origin requires runtime restart");
    }
    this.state.applyRollback({
      slot: event.point.slot,
      blockHash: event.point.id,
      height: event.tip?.height ?? 0,
    });
  }
}
