// Encrypted-vault round-trip tests.
//
// These exercise the real Argon2id KDF (via hash-wasm) + Web Crypto AES-GCM
// against a fake IndexedDB. We pin a low passphrase + small payload so the
// suite stays under a few seconds per test even at the OWASP-recommended
// 64 MiB / 3-iteration parameters.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  Vault,
  __resetForTests,
  type StoredBox,
} from "../src/storage/secrets.js";

function freshBox(idx = 0): StoredBox {
  return {
    txId: "a".repeat(64),
    outputIndex: idx,
    ownerSecretHex: "01".repeat(32),
    aHex: "02".repeat(48),
    bHex: "03".repeat(48),
    label: "deadbeefcafe",
    rounds: 30,
    createdAt: 1_700_000_000_000,
  };
}

beforeEach(async () => {
  // fake-indexeddb's @auto loader replaces global indexedDB on import. We
  // wipe it between tests so each test starts from a clean DB; otherwise
  // the vault meta from one test would leak into the next.
  globalThis.indexedDB = new (await import("fake-indexeddb")).IDBFactory();
  __resetForTests();
});

afterEach(async () => {
  __resetForTests();
});

describe("Vault", () => {
  it("auto-creates the vault on first unlock with a fresh salt", async () => {
    expect(await Vault.exists()).toBe(false);
    await Vault.unlock("hunter2");
    expect(await Vault.exists()).toBe(true);
  });

  it("round-trips a stored box across lock/unlock", async () => {
    const v1 = await Vault.unlock("hunter2");
    await v1.putBox(freshBox(0));
    const v2 = await Vault.unlock("hunter2");
    const all = await v2.listBoxes();
    expect(all).toHaveLength(1);
    expect(all[0]!.ownerSecretHex).toBe("01".repeat(32));
  });

  it("rejects a wrong passphrase with a clean error", async () => {
    await Vault.unlock("hunter2");
    await expect(Vault.unlock("wrong")).rejects.toThrow(
      /passphrase incorrect/i,
    );
  });

  it("getBox returns null for a missing ref", async () => {
    const v = await Vault.unlock("hunter2");
    expect(await v.getBox("0".repeat(64), 0)).toBeNull();
  });

  it("deletes a stored box", async () => {
    const v = await Vault.unlock("hunter2");
    await v.putBox(freshBox(0));
    await v.deleteBox(freshBox(0).txId, 0);
    expect(await v.listBoxes()).toHaveLength(0);
  });

  it("listBoxes orders newest-first by createdAt", async () => {
    const v = await Vault.unlock("hunter2");
    await v.putBox({ ...freshBox(0), createdAt: 1 });
    await v.putBox({ ...freshBox(1), createdAt: 100 });
    await v.putBox({ ...freshBox(2), createdAt: 50 });
    const list = await v.listBoxes();
    expect(list.map((b) => b.outputIndex)).toEqual([1, 2, 0]);
  });

  it("destroy() wipes meta + boxes so a fresh passphrase works", async () => {
    const v = await Vault.unlock("hunter2");
    await v.putBox(freshBox(0));
    await Vault.destroy();
    expect(await Vault.exists()).toBe(false);
    const v2 = await Vault.unlock("brand-new");
    expect(await v2.listBoxes()).toHaveLength(0);
  });

  it("rotatePassphrase moves every box onto a new key", async () => {
    const v1 = await Vault.unlock("hunter2");
    await v1.putBox(freshBox(0));
    await v1.putBox(freshBox(1));
    const v2 = await v1.rotatePassphrase("new-secret");
    const list = await v2.listBoxes();
    expect(list).toHaveLength(2);
    // The old passphrase no longer unlocks.
    await expect(Vault.unlock("hunter2")).rejects.toThrow(/passphrase incorrect/i);
    const v3 = await Vault.unlock("new-secret");
    expect(await v3.listBoxes()).toHaveLength(2);
  });

  it("rejects an empty passphrase", async () => {
    await expect(Vault.unlock("")).rejects.toThrow(/non-empty/);
  });
}, 60_000);
