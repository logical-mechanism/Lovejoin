// Determinism + KAT tests for the wallet-derived seed flow.
//
// Spec: M6.5 vault rework. The whole point of wallet-derived owner secrets
// is that the *same* (wallet, stake-addr, payload) input always produces
// the *same* per-deposit `x_i`. We pin that property at four layers:
//
//   1. `deriveSeedFromSignatureBytes` — the raw blake2b helper. Pure
//      hash; deterministic; rejects empty input.
//   2. `deriveVaultSeed` — the production seed derivation. Same as
//      blake2b but with `SEED_DOMAIN_TAG_V1 || stake_addr_utf8` prefixed
//      onto the signature bytes. Different stake addresses yield
//      different seeds even with byte-identical signatures.
//   3. `deriveOwnerSecret` — same seed + same index → byte-identical
//      scalar; distinct indices → distinct scalars.
//   4. `deriveSeedFromWalletSignature` — end-to-end stub-wallet pin.
//
// We also assert the failure modes spelled out in the implementation:
// empty signature, out-of-range index, wrong-length seed, non-stake
// signing addresses.

import { describe, expect, it } from "vitest";

import {
  SCALAR_ORDER,
  scalarToBytes,
} from "../../src/crypto/bls.js";
import {
  SEED_DOMAIN_TAG_V1,
  SIGN_DATA_PAYLOAD_V1,
  deriveOwnerSecret,
  deriveSeedFromSignatureBytes,
  deriveSeedFromSignatureHex,
  deriveSeedFromWalletSignature,
  deriveVaultSeed,
  isStakeAddressBech32,
  type SignDataCapableWallet,
} from "../../src/wallet/seed.js";

// A fake CIP-8 envelope hex — meaningful only as a stable input to the
// hash. Real envelopes are 100+ bytes; this is short for test legibility.
const FIXED_SIG_HEX =
  "84a4012704581d61bb176a7604f3e062a7ed315780801495ed0ffb0191c6f8e7d88362e2" +
  "8000a166686173686564f4581b6c6f76656a6f696e2f6f776e65722f7631";

// Bech32-shaped stake addresses for the preprod / mainnet sides. They
// don't have to be real addresses — the seed derivation only uses the
// UTF-8 bytes — but they must pass the HRP check.
const PREPROD_STAKE = "stake_test1uqv8x3lwf03qfphydz4xkfm9k7eet8j2hyzpf6c8wahuqgcsgg6vp";
const MAINNET_STAKE = "stake1uxv8x3lwf03qfphydz4xkfm9k7eet8j2hyzpf6c8wahuqgcsdkftj";

describe("deriveSeedFromSignatureBytes", () => {
  it("produces a 32-byte seed from non-empty signature bytes", () => {
    const seed = deriveSeedFromSignatureBytes(new Uint8Array([1, 2, 3, 4]));
    expect(seed).toBeInstanceOf(Uint8Array);
    expect(seed.length).toBe(32);
  });

  it("is deterministic across repeated calls with the same input", () => {
    const sig = new Uint8Array([0xab, 0xcd, 0xef]);
    const a = deriveSeedFromSignatureBytes(sig);
    const b = deriveSeedFromSignatureBytes(sig);
    expect(a).toEqual(b);
  });

  it("changes when even one byte of the signature changes", () => {
    const a = deriveSeedFromSignatureBytes(new Uint8Array([1, 2, 3]));
    const b = deriveSeedFromSignatureBytes(new Uint8Array([1, 2, 4]));
    expect(a).not.toEqual(b);
  });

  it("rejects an empty signature", () => {
    expect(() => deriveSeedFromSignatureBytes(new Uint8Array(0))).toThrow(
      /non-empty/,
    );
  });
});

describe("deriveSeedFromSignatureHex", () => {
  it("matches deriveSeedFromSignatureBytes on the same hex round-trip", () => {
    const hex = "deadbeef0001";
    const fromHex = deriveSeedFromSignatureHex(hex);
    const fromBytes = deriveSeedFromSignatureBytes(
      Uint8Array.from(Buffer.from(hex, "hex")),
    );
    expect(fromHex).toEqual(fromBytes);
  });

  it("accepts a 0x-prefixed hex string the same as the bare form", () => {
    const a = deriveSeedFromSignatureHex(FIXED_SIG_HEX);
    const b = deriveSeedFromSignatureHex(`0x${FIXED_SIG_HEX}`);
    expect(a).toEqual(b);
  });
});

describe("isStakeAddressBech32", () => {
  it("accepts mainnet + preprod stake-HRP addresses", () => {
    expect(isStakeAddressBech32(MAINNET_STAKE)).toBe(true);
    expect(isStakeAddressBech32(PREPROD_STAKE)).toBe(true);
  });

  it("rejects payment / enterprise / DRep / empty addresses", () => {
    expect(isStakeAddressBech32("addr_test1qrpapegfgqcaqjlk2ksqcgfwhxqdwexlpwdvphmkr8slpmcwf6cf6")).toBe(false);
    expect(isStakeAddressBech32("addr1q9zhwcs7yp78x80")).toBe(false);
    expect(isStakeAddressBech32("drep1ywaynjxd0eq2zr2vwkly0lnqxck6q08m32d5ej0eu5xpwgq77atjk")).toBe(false);
    expect(isStakeAddressBech32("")).toBe(false);
    expect(isStakeAddressBech32("not-an-address")).toBe(false);
  });
});

describe("deriveVaultSeed", () => {
  const sigBytes = Uint8Array.from(Buffer.from(FIXED_SIG_HEX, "hex"));

  it("returns a 32-byte seed", () => {
    const seed = deriveVaultSeed({ signatureBytes: sigBytes, stakeAddrBech32: PREPROD_STAKE });
    expect(seed.length).toBe(32);
  });

  it("is deterministic on the same (sig, address)", () => {
    const a = deriveVaultSeed({ signatureBytes: sigBytes, stakeAddrBech32: PREPROD_STAKE });
    const b = deriveVaultSeed({ signatureBytes: sigBytes, stakeAddrBech32: PREPROD_STAKE });
    expect(a).toEqual(b);
  });

  it("differs when the stake address differs (binding test)", () => {
    const onPreprod = deriveVaultSeed({ signatureBytes: sigBytes, stakeAddrBech32: PREPROD_STAKE });
    const onMainnet = deriveVaultSeed({ signatureBytes: sigBytes, stakeAddrBech32: MAINNET_STAKE });
    expect(onPreprod).not.toEqual(onMainnet);
  });

  it("differs from the bare blake2b hash of the signature", () => {
    const bound = deriveVaultSeed({ signatureBytes: sigBytes, stakeAddrBech32: PREPROD_STAKE });
    const bare = deriveSeedFromSignatureBytes(sigBytes);
    expect(bound).not.toEqual(bare);
  });

  it("refuses non-stake addresses", () => {
    expect(() =>
      deriveVaultSeed({
        signatureBytes: sigBytes,
        stakeAddrBech32: "addr_test1qrpapegfgqcaqjlk2ksqcgfwhxqdwexlpwdvphmkr8slpmcwf6cf6",
      }),
    ).toThrow(/non-stake/);
  });

  it("refuses an empty signature", () => {
    expect(() =>
      deriveVaultSeed({ signatureBytes: new Uint8Array(0), stakeAddrBech32: PREPROD_STAKE }),
    ).toThrow(/non-empty/);
  });

  it("uses the SEED_DOMAIN_TAG_V1 prefix (regression net)", () => {
    // If a future refactor accidentally drops the domain tag, the result
    // would equal blake2b(addr_utf8 || sig). Pin against that mistake.
    const expected = deriveVaultSeed({ signatureBytes: sigBytes, stakeAddrBech32: PREPROD_STAKE });
    const taglessLikeImitation = deriveSeedFromSignatureBytes(
      concat(
        new TextEncoder().encode(PREPROD_STAKE),
        sigBytes,
      ),
    );
    expect(expected).not.toEqual(taglessLikeImitation);
    // Sanity: SEED_DOMAIN_TAG_V1 is the v1 tag we documented.
    expect(SEED_DOMAIN_TAG_V1).toBe("lovejoin/owner-seed/v1");
  });
});

describe("deriveOwnerSecret", () => {
  // Use the bare blake2b helper for the seed input here so the KAT
  // doesn't depend on `deriveVaultSeed`'s framing — this test isolates
  // the HKDF expansion + mod-r reduction.
  const seed = deriveSeedFromSignatureHex(FIXED_SIG_HEX);

  it("returns a non-zero scalar strictly less than r", () => {
    const x = deriveOwnerSecret(seed, 0);
    expect(x).toBeGreaterThan(0n);
    expect(x).toBeLessThan(SCALAR_ORDER);
  });

  it("is deterministic across repeated calls with the same (seed, index)", () => {
    const a = deriveOwnerSecret(seed, 7);
    const b = deriveOwnerSecret(seed, 7);
    expect(scalarToBytes(a)).toEqual(scalarToBytes(b));
  });

  it("returns distinct secrets for distinct indices (sampled)", () => {
    const xs = [0, 1, 2, 3, 7, 100, 65535, 0xfffffffe].map((i) =>
      scalarToBytes(deriveOwnerSecret(seed, i)),
    );
    const set = new Set(xs.map((b) => Buffer.from(b).toString("hex")));
    expect(set.size).toBe(xs.length);
  });

  it("rejects a wrong-length seed", () => {
    expect(() =>
      deriveOwnerSecret(new Uint8Array(31), 0),
    ).toThrow(/32 bytes/);
    expect(() =>
      deriveOwnerSecret(new Uint8Array(33), 0),
    ).toThrow(/32 bytes/);
  });

  it("rejects negative or non-uint32 indices", () => {
    expect(() => deriveOwnerSecret(seed, -1)).toThrow(/uint32/);
    expect(() => deriveOwnerSecret(seed, 1.5)).toThrow(/uint32/);
    expect(() => deriveOwnerSecret(seed, 0x1_0000_0000)).toThrow(/uint32/);
  });

  it("pins a known answer at index 0 for the fixture seed (KAT)", () => {
    // Pinned against the implementation. A future refactor that changes
    // OWNER_HKDF_TAG_V1 / counter encoding / mod-r logic fails loudly
    // instead of silently invalidating every existing user's deposits.
    const x = deriveOwnerSecret(seed, 0);
    const hex = Buffer.from(scalarToBytes(x)).toString("hex");
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hex).toBe(
      "35045fcfd4a128dee2a054463c39a90dad1e9393336ba311da6b1f53bb3ee867",
    );
  });
});

describe("deriveSeedFromWalletSignature", () => {
  // Mesh's BrowserWallet.signData(payload, address) — payload first,
  // address second, plain UTF-8 payload (mesh hex-encodes internally).
  // The fakeWallet mirrors that contract exactly.
  function fakeWallet(
    handler: (payload: string, address?: string) => Promise<{ signature: string; key: string }>,
    rewardAddrs: string[] = [PREPROD_STAKE],
  ): SignDataCapableWallet {
    return {
      signData: handler,
      getRewardAddresses: async () => rewardAddrs,
    };
  }

  it("calls signData with the v1 payload + first reward address by default", async () => {
    let lastAddr = "";
    let lastPayload = "";
    const wallet = fakeWallet(async (payload, address) => {
      lastAddr = address ?? "";
      lastPayload = payload;
      return { signature: FIXED_SIG_HEX, key: "00" };
    });
    const out = await deriveSeedFromWalletSignature({ wallet });
    expect(lastAddr).toBe(PREPROD_STAKE);
    expect(lastPayload).toBe(SIGN_DATA_PAYLOAD_V1);
    expect(out.signatureHex).toBe(FIXED_SIG_HEX);
    expect(out.address).toBe(PREPROD_STAKE);
  });

  it("returns a seed identical to deriveVaultSeed on the same (sig, address)", async () => {
    const wallet = fakeWallet(async () => ({ signature: FIXED_SIG_HEX, key: "00" }));
    const direct = deriveVaultSeed({
      signatureBytes: Uint8Array.from(Buffer.from(FIXED_SIG_HEX, "hex")),
      stakeAddrBech32: PREPROD_STAKE,
    });
    const indirect = await deriveSeedFromWalletSignature({ wallet });
    expect(indirect.seed).toEqual(direct);
  });

  it("uses a caller-supplied stake address override", async () => {
    let seenAddr = "";
    const wallet = fakeWallet(async (_payload, address) => {
      seenAddr = address ?? "";
      return { signature: FIXED_SIG_HEX, key: "00" };
    });
    await deriveSeedFromWalletSignature({
      wallet,
      stakeAddrBech32: MAINNET_STAKE,
    });
    expect(seenAddr).toBe(MAINNET_STAKE);
  });

  it("throws clearly when the wallet exposes no reward address", async () => {
    const wallet = fakeWallet(
      async () => ({ signature: FIXED_SIG_HEX, key: "00" }),
      [],
    );
    await expect(deriveSeedFromWalletSignature({ wallet })).rejects.toThrow(
      /reward .*addresses/i,
    );
  });

  it("refuses to sign with a non-stake address", async () => {
    let signDataCalled = false;
    const wallet = fakeWallet(
      async () => {
        signDataCalled = true;
        return { signature: FIXED_SIG_HEX, key: "00" };
      },
      // Wallet returns a payment address by mistake.
      ["addr_test1qrpapegfgqcaqjlk2ksqcgfwhxqdwexlpwdvphmkr8slpmcwf6cf6"],
    );
    await expect(deriveSeedFromWalletSignature({ wallet })).rejects.toThrow(
      /non-stake/,
    );
    expect(signDataCalled).toBe(false);
  });
});

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
