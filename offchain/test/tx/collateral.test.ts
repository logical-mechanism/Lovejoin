// Unit tests for tx/collateral.ts.
//
// We exercise both providers under a synthetic wallet / fetch / chain
// provider. The shapes here mirror what mesh's BrowserWallet and a
// Collateral-Provider host (giveme.my) actually emit. If either upstream
// changes its surface, these tests fail loudly so we catch the drift
// instead of submitting a malformed tx.
//
// Witness-CBOR layout under test (matches upstream
// `api/signature.py::create_witness_cbor`):
//   cbor.dumps([0, [vkey_bytes, sig_bytes]])
//   = 0x82 0x00 0x82 0x58 0x20 <32 vkey> 0x58 0x40 <64 sig>

import { describe, expect, it } from "vitest";

import {
  GivemeMyProvider,
  WalletProvider,
  parseGivemeMyWitnessResponse,
  type CollateralFetchFn,
} from "../../src/tx/collateral.js";
import type { ChainProvider, Utxo } from "../../src/chain/provider.js";
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

/** Build the canonical witness CBOR hex from a vkey + sig. */
function witnessCborHex(vkeyHex: string, sigHex: string): string {
  if (vkeyHex.length !== 64) throw new Error("vkey must be 32 bytes hex");
  if (sigHex.length !== 128) throw new Error("sig must be 64 bytes hex");
  return `82008258${"20"}${vkeyHex}5840${sigHex}`;
}

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

  it("returns wallet UTxOs as collateral with externallySigned=false", async () => {
    const wallet = fakeWallet({ collateral: [utxoEntry({ lovelace: 5_000_000n })] });
    const p = new WalletProvider(wallet);
    const prepared = await p.prepareCollateral({ collateralAmountLovelace: 4_000_000n });
    expect(prepared.inputs).toHaveLength(1);
    expect(prepared.inputs[0]!.lovelace).toBe(5_000_000n);
    expect(prepared.totalLovelace).toBe(5_000_000n);
    expect(prepared.externallySigned).toBe(false);
    expect(prepared.requiredSignerPkhHex).toBeNull();
    expect(prepared.returnAddress).toBe("addr_test1qchange");

    expect(await p.signTxBody("84aa00")).toBeNull();
  });

  it("aggregates lovelace across multiple collateral UTxOs", async () => {
    const wallet = fakeWallet({
      collateral: [
        utxoEntry({ lovelace: 2_000_000n, idx: 0 }),
        utxoEntry({ lovelace: 3_500_000n, idx: 1 }),
      ],
    });
    const p = new WalletProvider(wallet);
    const prepared = await p.prepareCollateral({ collateralAmountLovelace: 5_000_000n });
    expect(prepared.inputs).toHaveLength(2);
    expect(prepared.totalLovelace).toBe(5_500_000n);
  });

  it("throws when wallet exposes no collateral", async () => {
    const cases: Array<LovejoinWallet> = [
      fakeWallet({ collateral: [] }),
      fakeWallet({ collateral: undefined }),
    ];
    for (const wallet of cases) {
      const p = new WalletProvider(wallet);
      await expect(p.prepareCollateral({ collateralAmountLovelace: 1n })).rejects.toThrow(
        /no collateral/,
      );
    }
  });

  it("throws when wallet collateral is below the requested amount", async () => {
    const wallet = fakeWallet({ collateral: [utxoEntry({ lovelace: 1_000_000n })] });
    const p = new WalletProvider(wallet);
    await expect(p.prepareCollateral({ collateralAmountLovelace: 5_000_000n })).rejects.toThrow(
      /Top up/,
    );
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
    await expect(p.prepareCollateral({ collateralAmountLovelace: 1n })).rejects.toThrow(/CBOR-hex/);
  });

  it("uses an explicit changeAddress when provided", async () => {
    const wallet = fakeWallet({ collateral: [utxoEntry({ lovelace: 5_000_000n })] });
    const p = new WalletProvider(wallet, { changeAddress: "addr_test1qoverride" });
    const prepared = await p.prepareCollateral({ collateralAmountLovelace: 1n });
    expect(prepared.returnAddress).toBe("addr_test1qoverride");
  });
});

describe("tx/collateral — GivemeMyProvider", () => {
  // Pinned giveme.my preprod entry — see known-collateral-hosts.ts.
  const HOST_PKH = "7c24c22d1dc252d31f6022ff22ccc838c2ab83a461172d7c2dae61f4";
  const HOST_PUBKEY = "fa2025e788fae01ce10deffff386f992f62a311758819e4e3792887396c171ba";
  const HOST_UTXO_TXID = "1d388e615da2dca607e28f704130d04e39da6f251d551d66d054b75607e0393f";
  const HOST_UTXO_IDX = 0;
  const HOST_ADDRESS = "addr_test1q_host_address";
  const HOST_UTXO_LOVELACE = 50_000_000n;

  function fakeChainProvider(): ChainProvider {
    return {
      submitTx: async () => "00",
      getUtxos: async () => [],
      getUtxoByRef: async (ref) => {
        if (ref.txId.toLowerCase() === HOST_UTXO_TXID && ref.outputIndex === HOST_UTXO_IDX) {
          const utxo: Utxo = {
            ref: { txId: HOST_UTXO_TXID, outputIndex: HOST_UTXO_IDX },
            address: HOST_ADDRESS,
            lovelace: HOST_UTXO_LOVELACE,
            assets: {},
            inlineDatum: null,
            referenceScript: null,
          };
          return utxo;
        }
        return null;
      },
      awaitConfirmation: async () => undefined,
      getReferenceUtxo: async () => {
        throw new Error("not used");
      },
      getProtocolParameters: async () => {
        throw new Error("not used");
      },
    };
  }

  function fakeFetch(
    handler: (
      input: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ) => { status: number; body: unknown },
  ): CollateralFetchFn {
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

  it("prepareCollateral fetches the pinned host UTxO via the chain provider", async () => {
    const provider = new GivemeMyProvider({
      network: "preprod",
      fetchFn: fakeFetch(() => ({ status: 200, body: {} })),
    });
    const prepared = await provider.prepareCollateral({
      provider: fakeChainProvider(),
      collateralAmountLovelace: 5_000_000n,
    });
    expect(prepared.inputs).toHaveLength(1);
    expect(prepared.inputs[0]!.ref.txId).toBe(HOST_UTXO_TXID);
    expect(prepared.inputs[0]!.ref.outputIndex).toBe(HOST_UTXO_IDX);
    expect(prepared.inputs[0]!.lovelace).toBe(HOST_UTXO_LOVELACE);
    expect(prepared.returnAddress).toBe(HOST_ADDRESS);
    expect(prepared.requiredSignerPkhHex).toBe(HOST_PKH);
    expect(prepared.externallySigned).toBe(true);
  });

  it("prepareCollateral throws when the host UTxO is gone", async () => {
    const provider = new GivemeMyProvider({
      network: "preprod",
      fetchFn: fakeFetch(() => ({ status: 200, body: {} })),
    });
    const emptyChain: ChainProvider = {
      ...fakeChainProvider(),
      getUtxoByRef: async () => null,
    };
    await expect(
      provider.prepareCollateral({ provider: emptyChain, collateralAmountLovelace: 1n }),
    ).rejects.toThrow(/not found on chain/);
  });

  it("prepareCollateral throws when the host UTxO is below the request", async () => {
    const provider = new GivemeMyProvider({
      network: "preprod",
      fetchFn: fakeFetch(() => ({ status: 200, body: {} })),
    });
    const tinyChain: ChainProvider = {
      ...fakeChainProvider(),
      getUtxoByRef: async (ref) => {
        const u = await fakeChainProvider().getUtxoByRef(ref);
        return u ? { ...u, lovelace: 100n } : null;
      },
    };
    await expect(
      provider.prepareCollateral({ provider: tinyChain, collateralAmountLovelace: 5_000_000n }),
    ).rejects.toThrow(/Pick a different host or wait/);
  });

  it("prepareCollateral throws when network has no pinned host", () => {
    expect(
      () =>
        new GivemeMyProvider({
          network: "preview",
          fetchFn: fakeFetch(() => ({ status: 200, body: {} })),
        }),
    ).toThrow(/no pinned host/);
  });

  it("signTxBody POSTs the tx CBOR and parses the witness", async () => {
    let captured: { url: string; body: string; headers?: Record<string, string> } | null = null;
    const provider = new GivemeMyProvider({
      network: "preprod",
      fetchFn: fakeFetch((url, init) => {
        captured = { url, body: init?.body ?? "", headers: init?.headers };
        return { status: 200, body: { witness: witnessCborHex(HOST_PUBKEY, "ab".repeat(64)) } };
      }),
    });
    const w = await provider.signTxBody("84aa00deadbeef");
    expect(w).not.toBeNull();
    expect(w!.vkeyHex).toBe(HOST_PUBKEY);
    expect(w!.signatureHex).toBe("ab".repeat(64));
    // Endpoint matches the pinned giveme.my preprod URL.
    expect(captured!.url).toBe("https://www.giveme.my/preprod/collateral/");
    const parsed = JSON.parse(captured!.body);
    expect(parsed).toEqual({ tx: "84aa00deadbeef" });
    expect(captured!.headers?.["Content-Type"]).toBe("application/json");
  });

  it("signTxBody throws on non-2xx HTTP responses", async () => {
    const provider = new GivemeMyProvider({
      network: "preprod",
      fetchFn: fakeFetch(() => ({ status: 503, body: "service down" })),
    });
    await expect(provider.signTxBody("deadbeef")).rejects.toThrow(/503/);
  });

  it("signTxBody throws when the response is missing 'witness'", async () => {
    const provider = new GivemeMyProvider({
      network: "preprod",
      fetchFn: fakeFetch(() => ({ status: 200, body: { error: "bad tx" } })),
    });
    await expect(provider.signTxBody("deadbeef")).rejects.toThrow(/witness/);
  });

  it("signTxBody rejects a witness whose vkey doesn't match the pinned host key", async () => {
    const provider = new GivemeMyProvider({
      network: "preprod",
      fetchFn: fakeFetch(() => ({
        status: 200,
        body: { witness: witnessCborHex("ee".repeat(32), "11".repeat(64)) },
      })),
    });
    await expect(provider.signTxBody("deadbeef")).rejects.toThrow(/does not match pinned/);
  });

  it("uses the override endpoint when supplied", async () => {
    let captured: string | null = null;
    const provider = new GivemeMyProvider({
      network: "preprod",
      endpoint: "http://localhost:8080/preprod/collateral/",
      fetchFn: fakeFetch((url) => {
        captured = url;
        return { status: 200, body: { witness: witnessCborHex(HOST_PUBKEY, "ab".repeat(64)) } };
      }),
    });
    await provider.signTxBody("deadbeef");
    expect(captured).toBe("http://localhost:8080/preprod/collateral/");
  });

  it("appends /{network}/collateral/ when the override is a base URL", async () => {
    let captured: string | null = null;
    const provider = new GivemeMyProvider({
      network: "preprod",
      endpoint: "https://giveme.my",
      fetchFn: fakeFetch((url) => {
        captured = url;
        return { status: 200, body: { witness: witnessCborHex(HOST_PUBKEY, "ab".repeat(64)) } };
      }),
    });
    await provider.signTxBody("deadbeef");
    expect(captured).toBe("https://giveme.my/preprod/collateral/");
  });

  it("normalises trailing slashes on a full-path override", async () => {
    let captured: string | null = null;
    const provider = new GivemeMyProvider({
      network: "preprod",
      endpoint: "http://localhost:8080/preprod/collateral", // no trailing slash
      fetchFn: fakeFetch((url) => {
        captured = url;
        return { status: 200, body: { witness: witnessCborHex(HOST_PUBKEY, "ab".repeat(64)) } };
      }),
    });
    await provider.signTxBody("deadbeef");
    expect(captured).toBe("http://localhost:8080/preprod/collateral/");
  });

  it("treats empty / whitespace endpoint override as 'no override'", async () => {
    let captured: string | null = null;
    const provider = new GivemeMyProvider({
      network: "preprod",
      endpoint: "   ",
      fetchFn: fakeFetch((url) => {
        captured = url;
        return { status: 200, body: { witness: witnessCborHex(HOST_PUBKEY, "ab".repeat(64)) } };
      }),
    });
    await provider.signTxBody("deadbeef");
    expect(captured).toBe("https://www.giveme.my/preprod/collateral/");
  });

  it("surfaces a clear error when the endpoint returns HTML (homepage)", async () => {
    const provider = new GivemeMyProvider({
      network: "preprod",
      endpoint: "https://giveme.my", // resolved → /preprod/collateral/, but stub returns HTML anyway
      fetchFn: fakeFetch(() => ({
        status: 200,
        body: "<!DOCTYPE html><html><head><title>giveme.my</title></head>...",
      })),
    });
    await expect(provider.signTxBody("deadbeef")).rejects.toThrow(/HTML, not JSON/);
  });
});

describe("tx/collateral — parseGivemeMyWitnessResponse", () => {
  it("decodes a canonical witness CBOR", () => {
    const vk = "01".repeat(32);
    const sig = "ff".repeat(64);
    const wit = parseGivemeMyWitnessResponse({ witness: witnessCborHex(vk, sig) });
    expect(wit.vkeyHex).toBe(vk);
    expect(wit.signatureHex).toBe(sig);
  });

  it("rejects malformed top-level CBOR", () => {
    expect(() => parseGivemeMyWitnessResponse({ witness: "00" })).toThrow();
    expect(() => parseGivemeMyWitnessResponse({ witness: "8201" })).toThrow();
  });

  it("rejects when the inner array isn't [bytes(32), bytes(64)]", () => {
    // Replace the bytes(32) tag with bytes(31).
    const malformed = `8200825820${"01".repeat(32)}5840${"ff".repeat(64)}`.replace("5820", "581f");
    expect(() => parseGivemeMyWitnessResponse({ witness: malformed })).toThrow();
  });
});
