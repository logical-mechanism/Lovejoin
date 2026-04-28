// EntropyVault round-trip tests.
//
// Spec: docs/spec/06-ui.md M6.5 — the IndexedDB vault stores ONE encrypted
// blob (the BIP-39 entropy hex), gated by an Argon2id-derived AES-GCM-256
// key. We pin the round-trip + wrong-passphrase + destroy + rotate flows
// against a fake IndexedDB so the suite stays under a few seconds per test
// even at the OWASP-recommended 64 MiB / 3-iteration parameters.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EntropyVault,
  __resetForTests,
} from "../src/storage/secrets.js";

const ENTROPY_A = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
const ENTROPY_B = "f0e0d0c0b0a090807060504030201000fffffffffffffffffffffffffffffffe";

beforeEach(async () => {
  globalThis.indexedDB = new (await import("fake-indexeddb")).IDBFactory();
  __resetForTests();
});

afterEach(async () => {
  __resetForTests();
});

describe("EntropyVault", () => {
  it("auto-creates the vault on first unlock with a fresh salt", async () => {
    expect(await EntropyVault.exists()).toBe(false);
    await EntropyVault.unlock("hunter2");
    expect(await EntropyVault.exists()).toBe(true);
  });

  it("round-trips the entropy across lock/unlock", async () => {
    const v1 = await EntropyVault.unlock("hunter2");
    await v1.putEntropyHex(ENTROPY_A);
    const v2 = await EntropyVault.unlock("hunter2");
    expect(await v2.getEntropyHex()).toBe(ENTROPY_A);
  });

  it("returns null for a freshly-created vault with no entropy yet", async () => {
    const v = await EntropyVault.unlock("hunter2");
    expect(await v.getEntropyHex()).toBeNull();
  });

  it("rejects a wrong passphrase with a clean error", async () => {
    await EntropyVault.unlock("hunter2");
    await expect(EntropyVault.unlock("wrong")).rejects.toThrow(
      /passphrase incorrect/i,
    );
  });

  it("rejects a non-32-byte entropy hex", async () => {
    const v = await EntropyVault.unlock("hunter2");
    await expect(v.putEntropyHex("aa".repeat(31))).rejects.toThrow(
      /BIP-39 entropy/,
    );
    await expect(v.putEntropyHex("not-hex" + "a".repeat(57))).rejects.toThrow(
      /BIP-39 entropy/,
    );
  });

  it("destroy() wipes meta + entropy so a fresh passphrase works", async () => {
    const v = await EntropyVault.unlock("hunter2");
    await v.putEntropyHex(ENTROPY_A);
    await EntropyVault.destroy();
    expect(await EntropyVault.exists()).toBe(false);
    const v2 = await EntropyVault.unlock("brand-new");
    expect(await v2.getEntropyHex()).toBeNull();
  });

  it("rotatePassphrase moves the entropy onto a new key", async () => {
    const v1 = await EntropyVault.unlock("hunter2");
    await v1.putEntropyHex(ENTROPY_A);
    const v2 = await v1.rotatePassphrase("new-secret");
    expect(await v2.getEntropyHex()).toBe(ENTROPY_A);
    await expect(EntropyVault.unlock("hunter2")).rejects.toThrow(
      /passphrase incorrect/i,
    );
    const v3 = await EntropyVault.unlock("new-secret");
    expect(await v3.getEntropyHex()).toBe(ENTROPY_A);
  });

  it("overwrites a previously stored entropy when putEntropyHex is called twice", async () => {
    const v = await EntropyVault.unlock("hunter2");
    await v.putEntropyHex(ENTROPY_A);
    await v.putEntropyHex(ENTROPY_B);
    expect(await v.getEntropyHex()).toBe(ENTROPY_B);
  });

  it("rejects an empty passphrase", async () => {
    await expect(EntropyVault.unlock("")).rejects.toThrow(/non-empty/);
  });
}, 60_000);
