#!/usr/bin/env node
// lovejoin CLI — `lovejoin <subcommand> [...]`.
//
// Spec: docs/spec/04-offchain.md §"CLI" — `lovejoin deposit --rounds N`,
// `lovejoin withdraw --secret … --to …`. Mix lands in M4.
//
// The CLI is a thin wrapper around the SDK's tx/deposit + tx/withdraw
// builders. It reads addresses.json + a wallet secret from env / disk and
// drives the build → sign → submit pipeline. Output is one machine-readable
// JSON line per subcommand so it composes with shell pipelines.
//
// Env vars:
//   LOVEJOIN_NETWORK            preprod (default) | preview | mainnet
//   LOVEJOIN_ADDRESSES          path to artifacts/<net>/addresses.json
//                               (default: ./artifacts/<net>/addresses.json)
//   BLOCKFROST_PROJECT_ID_PREPROD     Blockfrost project id for preprod
//   BLOCKFROST_PROJECT_ID_PREVIEW     ditto for preview
//   BLOCKFROST_PROJECT_ID_MAINNET     ditto for mainnet
//   LOVEJOIN_PAYMENT_SKEY       cardano-cli payment.skey hex string
//                               (alternative: LOVEJOIN_MNEMONIC=word1,word2,…)
//   LOVEJOIN_STAKE_SKEY         optional stake.skey hex (otherwise enterprise addr)

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import {
  BlockfrostProvider,
  type ChainProvider,
} from "../chain/index.js";
import {
  buildDepositTx,
  buildMixTx,
  buildWithdrawTx,
  type LovejoinAddresses,
  type MixBoxRef,
  type MixInput,
} from "../tx/index.js";
import {
  fetchPool,
  pickRandomNTuple,
  type PoolEntry,
} from "../pool/index.js";
import { fetchProtocolParams } from "../tx/params.js";
import { buildScriptAddress } from "../tx/address.js";
import {
  type LovejoinNetworkId,
  type LovejoinWallet,
  createCliMeshWallet,
  createMnemonicMeshWallet,
  networkIdFor,
} from "../wallet/index.js";

interface Env {
  network: "preprod" | "preview" | "test" | "mainnet";
  networkId: LovejoinNetworkId;
  addressesPath: string;
}

function readEnv(): Env {
  const network = (process.env.LOVEJOIN_NETWORK ?? "preprod") as Env["network"];
  if (!["preprod", "preview", "test", "mainnet"].includes(network)) {
    fatal(`LOVEJOIN_NETWORK must be one of preprod/preview/test/mainnet (got ${network})`);
  }
  const defaultAddrPath = `./artifacts/${network}/addresses.json`;
  return {
    network,
    networkId: networkIdFor(network),
    addressesPath: process.env.LOVEJOIN_ADDRESSES ?? defaultAddrPath,
  };
}

function loadAddresses(env: Env): LovejoinAddresses {
  const fullPath = resolvePath(env.addressesPath);
  let raw: string;
  try {
    raw = readFileSync(fullPath, "utf8");
  } catch (e) {
    fatal(`failed to read ${fullPath}: ${(e as Error).message}`);
  }
  return JSON.parse(raw) as LovejoinAddresses;
}

function chainProvider(env: Env): ChainProvider {
  const projectIdEnv = projectIdEnvFor(env.network);
  const projectId = process.env[projectIdEnv];
  if (!projectId) {
    fatal(`${projectIdEnv} is required`);
  }
  return new BlockfrostProvider({
    baseUrl: blockfrostBaseUrl(env.network),
    projectId,
  });
}

function projectIdEnvFor(network: Env["network"]): string {
  const map: Record<Env["network"], string> = {
    preprod: "BLOCKFROST_PROJECT_ID_PREPROD",
    preview: "BLOCKFROST_PROJECT_ID_PREVIEW",
    test: "BLOCKFROST_PROJECT_ID_PREPROD", // local-ish testing reuses preprod
    mainnet: "BLOCKFROST_PROJECT_ID_MAINNET",
  };
  return map[network];
}

function blockfrostBaseUrl(network: Env["network"]): string {
  if (network === "mainnet") return "https://cardano-mainnet.blockfrost.io/api/v0";
  if (network === "preview") return "https://cardano-preview.blockfrost.io/api/v0";
  return "https://cardano-preprod.blockfrost.io/api/v0";
}

async function loadWallet(env: Env): Promise<LovejoinWallet> {
  const skey = process.env.LOVEJOIN_PAYMENT_SKEY;
  const mnemonic = process.env.LOVEJOIN_MNEMONIC;
  if (skey) {
    const stake = process.env.LOVEJOIN_STAKE_SKEY;
    return createCliMeshWallet({
      networkId: env.networkId,
      payment: skey,
      ...(stake ? { stake } : {}),
    });
  }
  if (mnemonic) {
    const words = mnemonic.split(/[\s,]+/).filter((w) => w.length > 0);
    return createMnemonicMeshWallet({
      networkId: env.networkId,
      mnemonic: words,
    });
  }
  fatal("no wallet credentials: set LOVEJOIN_PAYMENT_SKEY or LOVEJOIN_MNEMONIC");
}

function fatal(msg: string): never {
  process.stderr.write(`lovejoin: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function cmdDeposit(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      rounds: { type: "string", default: "30" },
      "min-rounds": { type: "string" },
      "owner-secret": { type: "string" },
      json: { type: "boolean", default: true },
      "sign-only": { type: "boolean", default: false },
    },
    strict: true,
  });
  const rounds = Number.parseInt(values.rounds!, 10);
  if (!Number.isFinite(rounds) || rounds <= 0) {
    fatal(`--rounds must be a positive integer (got ${values.rounds})`);
  }
  const env = readEnv();
  const addresses = loadAddresses(env);
  const provider = chainProvider(env);
  const wallet = await loadWallet(env);

  const opts: Parameters<typeof buildDepositTx>[0] = {
    network: env.network,
    rounds,
    wallet,
    provider,
    addresses,
  };
  if (values["min-rounds"] !== undefined) {
    opts.minRounds = Number.parseInt(values["min-rounds"]!, 10);
  }
  if (values["owner-secret"] !== undefined) {
    opts.ownerSecret = BigInt(`0x${values["owner-secret"]!}`);
  }
  if (values["sign-only"] === true) opts.signOnly = true;

  const result = await buildDepositTx(opts);
  process.stdout.write(
    JSON.stringify(
      {
        action: "deposit",
        network: env.network,
        txId: result.txId,
        mixBoxOutputIndex: result.mixBoxOutputIndex,
        ownerSecretHex: result.owner.secretHex,
        ownerPublicPointHex: result.owner.publicPointHex,
        ownerLabel: result.owner.label,
      },
      null,
      2,
    ) + "\n",
  );
}

async function cmdWithdraw(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      secret: { type: "string" },
      "secret-file": { type: "string" },
      "box-ref": { type: "string" },
      "box-a": { type: "string" },
      "box-b": { type: "string" },
      to: { type: "string" },
      "sign-only": { type: "boolean", default: false },
    },
    strict: true,
  });
  if (!values.to) fatal("--to <bech32-address> is required");
  if (!values["box-ref"]) fatal("--box-ref <txid#idx> is required");
  if (!values["box-a"]) fatal("--box-a <48-byte-hex> is required");
  if (!values["box-b"]) fatal("--box-b <48-byte-hex> is required");
  const secretHex = values.secret ?? (values["secret-file"]
    ? readFileSync(values["secret-file"]!, "utf8").trim()
    : undefined);
  if (!secretHex) fatal("--secret <hex> or --secret-file <path> is required");
  const ownerSecret = BigInt(`0x${secretHex.replace(/^0x/i, "")}`);

  const [boxTx, boxIdx] = values["box-ref"]!.split("#");
  if (!boxTx || boxIdx === undefined) fatal("--box-ref must be <txid>#<idx>");

  const env = readEnv();
  const addresses = loadAddresses(env);
  const provider = chainProvider(env);
  const wallet = await loadWallet(env);

  const mixBox: MixBoxRef = {
    ref: { txId: boxTx.toLowerCase(), outputIndex: Number.parseInt(boxIdx, 10) },
    a: hexToBytes(values["box-a"]!),
    b: hexToBytes(values["box-b"]!),
  };

  const opts: Parameters<typeof buildWithdrawTx>[0] = {
    network: env.network,
    ownerSecret,
    mixBox,
    destinationAddressBech32: values.to!,
    wallet,
    provider,
    addresses,
  };
  if (values["sign-only"] === true) opts.signOnly = true;

  const result = await buildWithdrawTx(opts);
  process.stdout.write(
    JSON.stringify(
      {
        action: "withdraw",
        network: env.network,
        txId: result.txId,
        destination: values.to,
        ownerLabel: result.owner.label,
      },
      null,
      2,
    ) + "\n",
  );
}

async function cmdMix(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      n: { type: "string" },
      rounds: { type: "string", default: "1" },
      "box-ref": { type: "string", multiple: true },
      "fee-payer": { type: "string", default: "shard" },
      "sign-only": { type: "boolean", default: false },
    },
    strict: true,
  });
  const feePayerArg = values["fee-payer"]!;
  if (feePayerArg !== "shard" && feePayerArg !== "wallet") {
    fatal(`--fee-payer must be 'shard' or 'wallet' (got ${feePayerArg})`);
  }
  const feePayer = feePayerArg as "shard" | "wallet";
  const rounds = Number.parseInt(values.rounds!, 10);
  if (!Number.isFinite(rounds) || rounds <= 0) {
    fatal(`--rounds must be a positive integer (got ${values.rounds})`);
  }
  const env = readEnv();
  const addresses = loadAddresses(env);
  const provider = chainProvider(env);
  const wallet = await loadWallet(env);

  const { params } = await fetchProtocolParams(addresses, provider);
  const mixBoxAddress = buildScriptAddress(
    addresses.mixBoxScriptHash,
    env.networkId,
    addresses.dappStakeKeyHashHex ?? null,
  );

  const explicitRefs: ReadonlyArray<string> | undefined = values["box-ref"] as
    | ReadonlyArray<string>
    | undefined;

  const recordedTxs: string[] = [];
  for (let i = 0; i < rounds; i++) {
    const pool = await fetchPool({
      provider,
      mixBoxAddressBech32: mixBoxAddress,
      params,
    });
    if (pool.length < 2) {
      fatal(`mix: pool has ${pool.length} entries; need at least 2`);
    }
    const targetN = values.n
      ? Number.parseInt(values.n, 10)
      : Math.min(pool.length, 6); // legacy default; UI/calibration drives the real cap
    if (!Number.isInteger(targetN) || targetN < 2) {
      fatal(`--n must be a positive integer >= 2`);
    }
    let inputs: MixInput[];
    if (explicitRefs && i === 0 && explicitRefs.length >= 2) {
      // First round honours --box-ref. Subsequent rounds ignore (the boxes
      // were just spent — pick fresh ones from the pool).
      inputs = await resolveExplicitRefs(explicitRefs, pool, mixBoxAddress);
    } else {
      const picked = pickRandomNTuple({ pool, n: Math.min(targetN, pool.length) });
      inputs = picked.map<MixInput>((p) => ({
        ref: p.ref,
        a: p.a,
        b: p.b,
        utxo: p.utxo,
      }));
    }
    if (inputs.length < 2) {
      fatal(`mix: only ${inputs.length} inputs available; need >= 2`);
    }
    const result = await buildMixTx({
      network: env.network,
      inputs,
      wallet,
      provider,
      addresses,
      feePayer,
      ...(values["sign-only"] === true ? { signOnly: true } : {}),
    });
    recordedTxs.push(result.txId);
    process.stdout.write(
      JSON.stringify(
        {
          action: "mix",
          network: env.network,
          round: i + 1,
          rounds,
          n: result.plan.n,
          txId: result.txId,
        },
        null,
        2,
      ) + "\n",
    );
    if (i + 1 < rounds && result.txId) {
      // Wait for confirmation before the next round so the new mix-boxes
      // are visible in the pool. The SDK's awaitConfirmation polls
      // Blockfrost; cap at 5 minutes per round.
      await provider.awaitConfirmation(result.txId, 5 * 60_000);
    }
  }
  if (rounds > 1) {
    process.stdout.write(
      JSON.stringify({ action: "mix-summary", rounds, txIds: recordedTxs }, null, 2) +
        "\n",
    );
  }
}

async function resolveExplicitRefs(
  refs: ReadonlyArray<string>,
  pool: ReadonlyArray<PoolEntry>,
  mixBoxAddress: string,
): Promise<MixInput[]> {
  const byRef = new Map<string, PoolEntry>();
  for (const e of pool) byRef.set(`${e.ref.txId}#${e.ref.outputIndex}`, e);
  const out: MixInput[] = [];
  for (const r of refs) {
    const entry = byRef.get(r.toLowerCase());
    if (!entry) {
      fatal(
        `mix: --box-ref ${r} not found in pool at ${mixBoxAddress}; ` +
          `bad ref or already spent.`,
      );
    }
    out.push({ ref: entry.ref, a: entry.a, b: entry.b, utxo: entry.utxo });
  }
  return out;
}

async function cmdHelp(): Promise<void> {
  process.stdout.write(
    [
      "lovejoin — CLI for the Lovejoin Sigmajoin SDK",
      "",
      "Usage:",
      "  lovejoin deposit --rounds N [--min-rounds M] [--owner-secret HEX] [--sign-only]",
      "  lovejoin mix [--n N] [--rounds K] [--box-ref TXID#IDX --box-ref ...]",
      "                [--fee-payer shard|wallet] [--sign-only]",
      "  lovejoin withdraw --secret HEX --box-ref TXID#IDX --box-a HEX --box-b HEX --to ADDR [--sign-only]",
      "  lovejoin help",
      "",
      "Environment:",
      "  LOVEJOIN_NETWORK              preprod (default) | preview | mainnet",
      "  LOVEJOIN_ADDRESSES            path to addresses.json (default: ./artifacts/<net>/addresses.json)",
      "  BLOCKFROST_PROJECT_ID_*       Blockfrost project id (per network)",
      "  LOVEJOIN_PAYMENT_SKEY         cardano-cli payment skey hex string",
      "  LOVEJOIN_STAKE_SKEY           optional stake skey hex (otherwise enterprise addr)",
      "  LOVEJOIN_MNEMONIC             alternative wallet source: 'word1 word2 ...' or comma-separated",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      await cmdHelp();
      return;
    case "deposit":
      await cmdDeposit(rest);
      return;
    case "mix":
      await cmdMix(rest);
      return;
    case "withdraw":
      await cmdWithdraw(rest);
      return;
    default:
      fatal(`unknown subcommand "${sub}". Try \`lovejoin help\`.`);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (cleaned.length % 2 !== 0) throw new Error("hex string must have even length");
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

main().catch((err) => {
  process.stderr.write(`lovejoin: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
