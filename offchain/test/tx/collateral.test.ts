// Unit tests for tx/collateral.ts.
//
// We exercise both providers under a synthetic wallet / fetch. The shapes
// here mirror what mesh's BrowserWallet / a giveme.my-style HTTP service
// actually emit; if either upstream changes its surface, these tests fail
// loudly so we catch the drift instead of submitting a malformed tx.

import { describe, expect, it } from "vitest";

import {
  GivemeMyProvider,
  WalletProvider,
  type CollateralProvider,
  type CollateralFetchFn,
} from "../../src/tx/collateral.js";
import type { LovejoinWallet } from "../../src/wallet/cip30.js";

function utxoEntry(opts: { lovelace: bigint; idx?: number; address?: string }) {
  return {
    input: { txHash: "a".repeat(64), outputIndex: opts.idx ?? 0 },
    output: {
      address: opts.address ?? "addr_test1qsomething",
      amount: [{ unit: "lovelace", quantity: opts.lovelace.toString() }],
    },
  };
}

const ZERO_DIGEST = new Uint8Array(32);

describe("tx/collateral — WalletProvider", () => {
  function fakeWallet(opts: {
    collateral?: ReturnType<typeof utxoEntry>[] | undefined;
    changeAddr?: string;
  }): LovejoinWallet {
    return {
      getUsedAddresses: async () => ["addr_test1qchange"],
      getChangeAddress: async () => opts.changeAddr ?? "addr_test1qchange",
      getUtxos: async () => [],
      getCollateral: async () => opts.collateral,
      signTx: async () => "deadbeef",
      submitTx: async () => "deadbeef",
    };
  }

  it("returns wallet UTxOs as collateral with a null external witness", async () => {
    const wallet = fakeWallet({ collateral: [utxoEntry({ lovelace: 5_000_000n })] });
    const p = new WalletProvider(wallet);
    const provision = await p.requestCollateral({ txBodyDigest: ZERO_DIGEST, collateralAmountLovelace: 4_000_000n });
    expect(provision.inputs).toHaveLength(1);
    expect(provision.inputs[0]!.lovelace).toBe(5_000_000n);
    expect(provision.totalLovelace).toBe(5_000_000n);
    expect(provision.externalWitness).toBeNull();
    expect(provision.returnAddress).toBe("addr_test1qchange");
  });

  it("aggregates lovelace across multiple collateral UTxOs", async () => {
    const wallet = fakeWallet({
      collateral: [
        utxoEntry({ lovelace: 2_000_000n, idx: 0 }),
        utxoEntry({ lovelace: 3_500_000n, idx: 1 }),
      ],
    });
    const p = new WalletProvider(wallet);
    const provision = await p.requestCollateral({ txBodyDigest: ZERO_DIGEST, collateralAmountLovelace: 5_000_000n });
    expect(provision.inputs).toHaveLength(2);
    expect(provision.totalLovelace).toBe(5_500_000n);
  });

  it("throws when wallet exposes no collateral", async () => {
    const cases: Array<LovejoinWallet> = [fakeWallet({ collateral: [] }), fakeWallet({ collateral: undefined })];
    for (const wallet of cases) {
      const p = new WalletProvider(wallet);
      await expect(
        p.requestCollateral({ txBodyDigest: ZERO_DIGEST, collateralAmountLovelace: 1n }),
      ).rejects.toThrow(/no collateral/);
    }
  });

  it("throws when wallet collateral is below the requested amount", async () => {
    const wallet = fakeWallet({ collateral: [utxoEntry({ lovelace: 1_000_000n })] });
    const p = new WalletProvider(wallet);
    await expect(
      p.requestCollateral({ txBodyDigest: ZERO_DIGEST, collateralAmountLovelace: 5_000_000n }),
    ).rejects.toThrow(/Top up/);
  });

  it("rejects CBOR-hex collateral with an actionable error", async () => {
    const wallet: LovejoinWallet = {
      getUsedAddresses: async () => ["addr_test1qchange"],
      getChangeAddress: async () => "addr_test1qchange",
      getUtxos: async () => [],
      getCollateral: async () => ["abcd1234"],
      signTx: async () => "",
      submitTx: async () => "",
    };
    const p = new WalletProvider(wallet);
    await expect(
      p.requestCollateral({ txBodyDigest: ZERO_DIGEST, collateralAmountLovelace: 1n }),
    ).rejects.toThrow(/CBOR-hex/);
  });

  it("uses an explicit changeAddress when provided", async () => {
    const wallet = fakeWallet({ collateral: [utxoEntry({ lovelace: 5_000_000n })] });
    const p = new WalletProvider(wallet, { changeAddress: "addr_test1qoverride" });
    const provision = await p.requestCollateral({ txBodyDigest: ZERO_DIGEST, collateralAmountLovelace: 1n });
    expect(provision.returnAddress).toBe("addr_test1qoverride");
  });
});

describe("tx/collateral — GivemeMyProvider", () => {
  const sampleResponse = {
    input: {
      tx_id: "B".repeat(64),
      output_index: 0,
      address: "addr_test1q_giveme_my",
      lovelace: "5000000",
      assets: {},
    },
    return_address: "addr_test1q_giveme_my_return",
    witness: {
      vkey: "0".repeat(64),
      signature: "1".repeat(128),
    },
  };

  function fakeFetch(handler: (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => { status: number; body: unknown }): CollateralFetchFn {
    return async (input, init) => {
      const r = handler(input, init);
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        statusText: "",
        text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
        json: async () => r.body,
      };
    };
  }

  function makeProvider(handler: Parameters<typeof fakeFetch>[0]): CollateralProvider {
    return new GivemeMyProvider({
      endpoint: "https://giveme.my",
      network: "preprod",
      fetchFn: fakeFetch(handler),
    });
  }

  it("posts to /collateral with the digest + amount", async () => {
    let captured: { url: string; body: string } | null = null;
    const provider = makeProvider((url, init) => {
      captured = { url, body: init?.body ?? "" };
      return { status: 200, body: sampleResponse };
    });
    await provider.requestCollateral({ txBodyDigest: new Uint8Array([0xde, 0xad]), collateralAmountLovelace: 7_500_000n });
    expect(captured).toMatchObject({ url: "https://giveme.my/collateral" });
    const body = JSON.parse(captured!.body);
    expect(body.network).toBe("preprod");
    expect(body.tx_body_digest).toBe("dead");
    expect(body.amount_lovelace).toBe("7500000");
  });

  it("returns the parsed CollateralProvision with an external witness", async () => {
    const provider = makeProvider(() => ({ status: 200, body: sampleResponse }));
    const provision = await provider.requestCollateral({ txBodyDigest: ZERO_DIGEST, collateralAmountLovelace: 5_000_000n });
    expect(provision.inputs).toHaveLength(1);
    expect(provision.inputs[0]!.ref.txId).toBe("b".repeat(64));
    expect(provision.totalLovelace).toBe(5_000_000n);
    expect(provision.returnAddress).toBe("addr_test1q_giveme_my_return");
    expect(provision.externalWitness).toEqual({
      vkeyHex: "0".repeat(64),
      signatureHex: "1".repeat(128),
    });
  });

  it("throws on non-2xx HTTP responses", async () => {
    const provider = makeProvider(() => ({ status: 503, body: "service down" }));
    await expect(
      provider.requestCollateral({ txBodyDigest: ZERO_DIGEST, collateralAmountLovelace: 1n }),
    ).rejects.toThrow(/503/);
  });

  it("throws when the response body is malformed", async () => {
    const provider = makeProvider(() => ({ status: 200, body: { input: "not an object" } }));
    await expect(
      provider.requestCollateral({ txBodyDigest: ZERO_DIGEST, collateralAmountLovelace: 1n }),
    ).rejects.toThrow();
  });

  it("rejects witnesses with the wrong byte length", async () => {
    const provider = makeProvider(() => ({
      status: 200,
      body: {
        ...sampleResponse,
        witness: { vkey: "0".repeat(32), signature: "1".repeat(128) }, // vkey too short
      },
    }));
    await expect(
      provider.requestCollateral({ txBodyDigest: ZERO_DIGEST, collateralAmountLovelace: 1n }),
    ).rejects.toThrow(/32-byte hex/);
  });

  it("attaches Authorization header when an apiKey is set", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const provider = new GivemeMyProvider({
      endpoint: "https://giveme.my",
      network: "preprod",
      apiKey: "abc-secret",
      fetchFn: fakeFetch((_, init) => {
        capturedHeaders = init?.headers;
        return { status: 200, body: sampleResponse };
      }),
    });
    await provider.requestCollateral({ txBodyDigest: ZERO_DIGEST, collateralAmountLovelace: 1n });
    expect(capturedHeaders?.["Authorization"]).toBe("Bearer abc-secret");
  });
});
