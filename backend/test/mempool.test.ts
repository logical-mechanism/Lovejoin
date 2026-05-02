// Unit tests for MempoolPoller. Drives a fake Ogmios tx client so we
// can assert the snapshot semantics without a live cardano-node.

import { afterEach, describe, expect, it } from "vitest";

import { MempoolPoller, inputRefKey, type InputRefKey } from "../src/indexer/mempool.js";
import type { OgmiosTxClient, MempoolTransaction } from "../src/indexer/ogmios-tx.js";

function makeFakeClient(scripts: MempoolTransaction[][]): {
  client: OgmiosTxClient;
  acquireCount: () => number;
} {
  let scriptIdx = 0;
  let acquireCount = 0;
  const fake = {
    async acquireMempool(): Promise<number> {
      acquireCount += 1;
      return scriptIdx + 1; // toy slot
    },
    async nextMempoolTransaction(): Promise<MempoolTransaction | null> {
      const txs = scripts[scriptIdx] ?? [];
      const tx = txs.shift() ?? null;
      if (tx === null) {
        scriptIdx += 1;
      }
      return tx;
    },
    async releaseMempool(): Promise<void> {
      // no-op
    },
  };
  return {
    client: fake as unknown as OgmiosTxClient,
    acquireCount: () => acquireCount,
  };
}

const silentLogger = {
  info: () => {},
  warn: () => {},
};

function ref(seed: number): { txId: string; outputIndex: number } {
  return { txId: seed.toString(16).padStart(64, "0"), outputIndex: 0 };
}

function tx(id: string, ...inputs: ReturnType<typeof ref>[]): MempoolTransaction {
  return {
    id,
    inputs: inputs.map((r) => ({
      transaction: { id: r.txId },
      index: r.outputIndex,
    })),
  };
}

afterEach(() => {
  // Each test creates its own poller; nothing global to reset.
});

describe("MempoolPoller", () => {
  it("captures every mempool input ref when no filter is set", async () => {
    const a = ref(1);
    const b = ref(2);
    const { client } = makeFakeClient([[tx("aa", a, b)]]);
    const poller = new MempoolPoller({
      client,
      intervalMs: 10,
      logger: silentLogger,
    });
    poller.start();
    await waitFor(() => poller.snapshot().acquiredAtMs > 0);
    await poller.stop();

    const snap = poller.snapshot();
    expect(snap.txCount).toBe(1);
    expect(snap.inputs.size).toBe(2);
    expect(snap.inputs.has(inputRefKey(a.txId, a.outputIndex))).toBe(true);
    expect(snap.inputs.has(inputRefKey(b.txId, b.outputIndex))).toBe(true);
  });

  it("drops inputs not in the relevance filter", async () => {
    const wantedKey = inputRefKey(ref(7).txId, 0);
    const noise = ref(99);
    const { client } = makeFakeClient([[tx("bb", ref(7), noise, ref(101))]]);
    const poller = new MempoolPoller({
      client,
      intervalMs: 10,
      relevantRefs: () => new Set<InputRefKey>([wantedKey]),
      logger: silentLogger,
    });
    poller.start();
    await waitFor(() => poller.snapshot().acquiredAtMs > 0);
    await poller.stop();

    const snap = poller.snapshot();
    expect(snap.txCount).toBe(1);
    expect(snap.inputs.size).toBe(1);
    expect(snap.inputs.has(wantedKey)).toBe(true);
    expect(snap.inputs.has(inputRefKey(noise.txId, 0))).toBe(false);
  });

  it("re-evaluates the filter on every poll", async () => {
    const a = ref(10);
    const b = ref(11);
    let allowed: Set<InputRefKey> = new Set([inputRefKey(a.txId, 0)]);
    const { client } = makeFakeClient([[tx("c1", a, b)], [tx("c2", a, b)]]);
    const poller = new MempoolPoller({
      client,
      intervalMs: 10,
      relevantRefs: () => allowed,
      logger: silentLogger,
    });
    poller.start();
    await waitFor(() => poller.snapshot().acquiredAtMs > 0);
    // Snapshot 1 saw only `a`.
    expect(poller.snapshot().inputs.size).toBe(1);

    // Flip the filter so `b` becomes allowed; wait for the next poll.
    allowed = new Set([inputRefKey(b.txId, 0)]);
    const firstAcquiredAt = poller.snapshot().acquiredAtMs;
    await waitFor(() => poller.snapshot().acquiredAtMs > firstAcquiredAt);
    await poller.stop();

    const snap = poller.snapshot();
    expect(snap.inputs.has(inputRefKey(b.txId, 0))).toBe(true);
    expect(snap.inputs.has(inputRefKey(a.txId, 0))).toBe(false);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: timed out");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
