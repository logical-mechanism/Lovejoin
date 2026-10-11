// Token-pool rehearsal on Preprod over Koios.
//
// Drives the generalized (token-mixing) contracts launched by
// infra/bootstrap/koios-token-launch.py through every operation:
//
//   1. deposit (one box) + bulk deposit (three boxes)
//   2. wallet-paid Mix at N = 2, 3, 4
//   3. evaluation-only negatives: a valid Mix tx with one output's value
//      tampered (wrong Q, missing token, extra token, extra lovelace) must be
//      rejected by mix_logic. The Mix proofs hash the box value from the
//      reference datum, not the outputs' values, so the proofs stay valid
//      and only the value rule can reject. Never submitted.
//   4. withdraw two boxes in box-fee mode and two in wallet-fee mode
//
// The fee contract is out of scope: the launch funds no shards, so no tx here
// spends or replenishes one.
//
// Every submitted tx is evaluated first; its script budget, fee, and size are
// printed and written to <address book dir>/last-run.json.
//
// Opt-in: set LOVEJOIN_TOKEN_POOL_TEST=1. Also needs the launch's address book
// (artifacts/preprod-token/addresses.json, or LOVEJOIN_TOKEN_ADDRESSES) and
// the launch key (infra/bootstrap/wallets/token-preprod/payment.skey, or
// LOVEJOIN_TOKEN_SKEY_FILE). Owner secrets are saved next to the key before
// each deposit, and a run first withdraws any box an earlier, interrupted run
// left in the pool.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  buildBulkDepositTx,
  buildDepositTx,
  buildMixTx,
  buildScriptAddress,
  buildWithdrawTx,
  createCliMeshWallet,
  fetchPool,
  fetchProtocolParams,
  generateOwnerSecret,
  KoiosProvider,
  koiosBaseUrl,
  type LovejoinAddresses,
  type LovejoinWallet,
  type MeshFetcherSubmitter,
  type MixInput,
  ownsBox,
  type PoolEntry,
  type ProtocolParams,
  type Scalar,
  type WithdrawFeePayer,
} from "@lovejoin/sdk";

const repoPath = (p: string): string => fileURLToPath(new URL(`../../${p}`, import.meta.url));

const ADDRESSES_PATH =
  process.env.LOVEJOIN_TOKEN_ADDRESSES ?? repoPath("artifacts/preprod-token/addresses.json");
const SKEY_PATH =
  process.env.LOVEJOIN_TOKEN_SKEY_FILE ??
  repoPath("infra/bootstrap/wallets/token-preprod/payment.skey");
const SECRETS_PATH = `${dirname(SKEY_PATH)}/test-owner-secrets.json`;
const RESULTS_PATH = `${dirname(ADDRESSES_PATH)}/last-run.json`;

const skipReason =
  process.env.LOVEJOIN_TOKEN_POOL_TEST !== "1"
    ? "LOVEJOIN_TOKEN_POOL_TEST=1 not set"
    : !existsSync(ADDRESSES_PATH)
      ? `no address book at ${ADDRESSES_PATH}`
      : !existsSync(SKEY_PATH)
        ? `no launch key at ${SKEY_PATH}`
        : null;

const CONFIRM_MS = 10 * 60_000;

interface Box {
  ref: { txId: string; outputIndex: number };
  a: Uint8Array;
  b: Uint8Array;
  secret: Scalar;
}

interface Measured {
  step: string;
  txId: string;
  n: number | null;
  redeemers: Array<{ tag: string; index: number; mem: number; steps: number }>;
  steps: number;
  mem: number;
  fee: number;
  size: number;
}

describe.skipIf(skipReason !== null)("token pool on Preprod over Koios", () => {
  const provider = new KoiosProvider({ baseUrl: koiosBaseUrl("preprod") });
  let mesh: MeshFetcherSubmitter;
  let wallet: LovejoinWallet;
  let walletAddress: string;
  let addresses: LovejoinAddresses;
  let params: ProtocolParams;
  let mixBoxAddress: string;
  let tokenUnit: string;
  let maxSteps: number;
  let maxMem: number;
  const secrets: Scalar[] = loadSecrets();
  let boxes: Box[] = [];
  const results: Measured[] = [];

  beforeAll(async () => {
    addresses = JSON.parse(readFileSync(ADDRESSES_PATH, "utf8")) as LovejoinAddresses;
    mesh = await provider.meshProvider();
    walletAddress = readFileSync(`${dirname(SKEY_PATH)}/payment.addr`, "utf8").trim();
    wallet = await enterpriseWallet(walletAddress, mesh);
    ({ params } = await fetchProtocolParams(addresses, provider));
    mixBoxAddress = buildScriptAddress(addresses.mixBoxScriptHash, 0);
    const token = params.boxValue.token;
    if (!token) throw new Error("the launch is not a token pool");
    tokenUnit = token.policy + token.name;
    const net = await provider.getProtocolParameters();
    maxSteps = Number(net.maxTxExSteps);
    maxMem = Number(net.maxTxExMem);
  });

  it("reads the token box value from the reference datum", () => {
    const token = addresses.protocol.token!;
    expect(params.boxValue).toEqual({
      lovelace: BigInt(addresses.protocol.box_lovelace!),
      token: { policy: token.policy, name: token.name, quantity: BigInt(token.quantity) },
    });
    // Q above 2^53 puts an 8-byte CBOR integer into the Mix context.
    expect(params.boxValue.token!.quantity > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it(
    "withdraws boxes an interrupted earlier run left in the pool",
    async () => {
      const stale = (await pool()).flatMap((e) => {
        const secret = secrets.find((s) => ownsBox(s, e));
        return secret === undefined ? [] : [{ ref: e.ref, a: e.a, b: e.b, secret }];
      });
      for (const box of stale) await withdraw(box, "box", "cleanup withdraw");
    },
    CONFIRM_MS * 4,
  );

  it(
    "deposits one box",
    async () => {
      const secret = rememberSecret(generateOwnerSecret());
      const r = await buildDepositTx({
        network: "preprod",
        rounds: 1,
        ownerSecret: secret,
        feeShard: null,
        wallet,
        provider,
        addresses,
        signOnly: true,
      });
      const txId = await submitMeasured("deposit", r.signedTxHex, null);
      boxes.push(await boxAt(txId, r.mixBoxOutputIndex, secret));
    },
    CONFIRM_MS,
  );

  it(
    "bulk-deposits three boxes",
    async () => {
      const fresh = [0, 1, 2].map(() => rememberSecret(generateOwnerSecret()));
      const r = await buildBulkDepositTx({
        network: "preprod",
        ownerSecrets: fresh,
        rounds: 1,
        feeShard: null,
        wallet,
        provider,
        addresses,
        signOnly: true,
      });
      const txId = await submitMeasured("bulk deposit (3 boxes)", r.signedTxHex, null);
      for (let i = 0; i < fresh.length; i++) boxes.push(await boxAt(txId, i, fresh[i]!));
      const ours = (await pool()).filter((e) => boxes.some((b) => sameRef(b.ref, e.ref)));
      expect(ours).toHaveLength(4);
    },
    CONFIRM_MS,
  );

  for (const n of [2, 3, 4]) {
    it(
      `mixes N=${n} with the wallet paying the fee`,
      async () => {
        await mix(n);
      },
      CONFIRM_MS,
    );
  }

  it(
    "rejects Mix outputs whose value differs from the box value (evaluation only)",
    async () => {
      const built = await buildMixTx({
        network: "preprod",
        inputs: await mixInputs(boxes.slice(0, 2)),
        wallet,
        provider,
        addresses,
        feePayer: "wallet",
        buildOnly: true,
      });
      const tx = built.unsignedTxHex;
      // Control: the untampered tx passes every script.
      await expect(mesh.evaluateTx(tx)).resolves.toBeDefined();

      const token = params.boxValue.token!;
      const lovelace = params.boxValue.lovelace;
      const q = token.quantity;
      const otherName = Buffer.from("LJEXTRA").toString("hex");
      const tampered: Record<string, string> = {
        "wrong Q": encodeValue(lovelace, [[token.policy, token.name, q + 1n]]),
        "missing token": encodeValue(lovelace, []),
        "extra token": encodeValue(lovelace, [
          [token.policy, token.name, q],
          [token.policy, otherName, 1n],
        ]),
        "extra lovelace": encodeValue(lovelace + 1n, [[token.policy, token.name, q]]),
      };
      for (const [label, value] of Object.entries(tampered)) {
        const bad = replaceOutputValue(tx, 0, value);
        expect(bad, label).not.toBe(tx);
        // mix_logic (the withdraw-zero redeemer) is the script that fails.
        await expect(mesh.evaluateTx(bad), label).rejects.toThrow(/purpose"?: "?withdraw/);
      }
    },
    CONFIRM_MS,
  );

  it(
    "withdraws two boxes paying from the box and two paying from the wallet",
    async () => {
      const modes: WithdrawFeePayer[] = ["box", "box", "wallet", "wallet"];
      for (const [i, box] of [...boxes].entries()) {
        await withdraw(box, modes[i % modes.length]!, `withdraw (${modes[i % modes.length]} fee)`);
      }
      boxes = [];
    },
    CONFIRM_MS * 4,
  );

  it("records the run", () => {
    const rows = results.map((r) => ({
      step: r.step,
      n: r.n ?? "",
      "cpu %": ((100 * r.steps) / maxSteps).toFixed(1),
      "mem %": ((100 * r.mem) / maxMem).toFixed(1),
      steps: r.steps,
      mem: r.mem,
      fee: r.fee,
      bytes: r.size,
      txId: r.txId,
    }));
    console.table(rows);
    writeFileSync(
      RESULTS_PATH,
      `${JSON.stringify({ at: new Date().toISOString(), maxSteps, maxMem, results }, null, 2)}\n`,
    );
  });

  // ---------------------------------------------------------------------------

  async function mix(n: number): Promise<void> {
    expect(boxes.length).toBeGreaterThanOrEqual(n);
    const chosen = boxes.slice(0, n);
    const r = await buildMixTx({
      network: "preprod",
      inputs: await mixInputs(chosen),
      wallet,
      provider,
      addresses,
      feePayer: "wallet",
      signOnly: true,
    });
    expect(r.plan.outputs).toHaveLength(n);
    const txId = await submitMeasured("Mix (wallet fee)", r.signedTxHex, n);
    const outputs: Box[] = [];
    for (let i = 0; i < n; i++) {
      const out = r.plan.outputs[i]!;
      const secret = chosen.map((b) => b.secret).find((s) => ownsBox(s, out));
      expect(secret, `owner of output ${i}`).toBeDefined();
      outputs.push(await boxAt(txId, i, secret!));
    }
    // Rotate so the next Mix starts with boxes this one did not touch.
    boxes = [...boxes.slice(n), ...outputs];
  }

  async function withdraw(box: Box, feePayer: WithdrawFeePayer, step: string): Promise<void> {
    const r = await buildWithdrawTx({
      network: "preprod",
      ownerSecret: box.secret,
      mixBox: { ref: box.ref, a: box.a, b: box.b },
      destinationAddressBech32: walletAddress,
      wallet,
      provider,
      addresses,
      feePayer,
      signOnly: true,
    });
    const txId = await submitMeasured(step, r.signedTxHex, null);
    const outputs = (await mesh.fetchUTxOs(txId)) as Array<{
      output: { address: string; amount: Array<{ unit: string; quantity: string }> };
    }>;
    const tokensHome = outputs
      .filter((o) => o.output.address === walletAddress)
      .flatMap((o) => o.output.amount)
      .filter((a) => a.unit === tokenUnit)
      .reduce((sum, a) => sum + BigInt(a.quantity), 0n);
    expect(tokensHome >= params.boxValue.token!.quantity).toBe(true);
  }

  async function mixInputs(chosen: ReadonlyArray<Box>): Promise<MixInput[]> {
    return Promise.all(
      chosen.map(async (b) => {
        const utxo = await provider.getUtxoByRef(b.ref);
        if (!utxo) throw new Error(`box ${b.ref.txId}#${b.ref.outputIndex} not found`);
        return { ref: b.ref, a: b.a, b: b.b, utxo };
      }),
    );
  }

  async function boxAt(txId: string, outputIndex: number, secret: Scalar): Promise<Box> {
    const entry = (await pool()).find((e) => sameRef(e.ref, { txId, outputIndex }));
    if (!entry) throw new Error(`no well-formed box at ${txId}#${outputIndex}`);
    expect(ownsBox(secret, entry)).toBe(true);
    expect(entry.utxo.lovelace).toBe(params.boxValue.lovelace);
    expect(entry.utxo.assets).toEqual({ [tokenUnit]: params.boxValue.token!.quantity });
    return { ref: entry.ref, a: entry.a, b: entry.b, secret };
  }

  async function pool(): Promise<PoolEntry[]> {
    return fetchPool({ provider, mixBoxAddressBech32: mixBoxAddress, params });
  }

  /** Evaluate (to record the budget), submit, and wait for one confirmation. */
  async function submitMeasured(step: string, signedTx: string, n: number | null): Promise<string> {
    const actions = (await mesh.evaluateTx(signedTx)) as Array<{
      tag: string;
      index: number;
      budget: { mem: number; steps: number };
    }>;
    const txId = await provider.submitTx(signedTx);
    console.log(`[token-pool] ${step}: submitted ${txId}`);
    await provider.awaitConfirmation(txId, CONFIRM_MS);
    const info = await txInfo(txId);
    results.push({
      step,
      txId,
      n,
      redeemers: actions.map((a) => ({
        tag: a.tag,
        index: a.index,
        mem: a.budget.mem,
        steps: a.budget.steps,
      })),
      steps: actions.reduce((s, a) => s + a.budget.steps, 0),
      mem: actions.reduce((s, a) => s + a.budget.mem, 0),
      fee: info.fee,
      size: info.size,
    });
    return txId;
  }
});

if (skipReason) console.log(`[token-pool] SKIP: ${skipReason}`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The launch key as a LovejoinWallet on its enterprise address. MeshWallet
 * fills a missing stake key with a placeholder and then reads UTxOs from, and
 * sends change to, that made-up base address, which holds nothing here. So
 * mesh only signs (with the payment key alone) and every address and UTxO
 * call is pinned to payment.addr.
 */
async function enterpriseWallet(
  address: string,
  mesh: MeshFetcherSubmitter,
): Promise<LovejoinWallet> {
  const skey = JSON.parse(readFileSync(SKEY_PATH, "utf8")) as { cborHex: string };
  const signer = await createCliMeshWallet({ networkId: 0, payment: skey.cborHex });
  type Row = { output: { amount: Array<{ unit: string; quantity: string }> } };
  const utxos = async (): Promise<Row[]> =>
    (mesh as unknown as { fetchAddressUTxOs(a: string): Promise<Row[]> }).fetchAddressUTxOs(
      address,
    );
  const lovelace = (u: Row): bigint =>
    BigInt(u.output.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0");
  return {
    getUsedAddresses: async () => [address],
    getChangeAddress: () => address,
    getUtxos: async () => (await utxos()) as never,
    // Like MeshWallet: the smallest pure-ADA UTxO of at least 5 ADA.
    getCollateral: async () =>
      (await utxos())
        .filter((u) => u.output.amount.length === 1 && lovelace(u) >= 5_000_000n)
        .sort((x, y) => (lovelace(x) < lovelace(y) ? -1 : 1))
        .slice(0, 1) as never,
    signTx: (tx, partialSign) => signer.signTx(tx, partialSign),
    submitTx: (tx) => mesh.submitTx(tx),
  };
}

function sameRef(
  x: { txId: string; outputIndex: number },
  y: { txId: string; outputIndex: number },
): boolean {
  return x.txId === y.txId && x.outputIndex === y.outputIndex;
}

function loadSecrets(): Scalar[] {
  if (!existsSync(SECRETS_PATH)) return [];
  return (JSON.parse(readFileSync(SECRETS_PATH, "utf8")) as string[]).map((h) => BigInt(`0x${h}`));
}

/** Save the owner secret next to the launch key before its box exists. */
function rememberSecret(secret: Scalar): Scalar {
  const saved = existsSync(SECRETS_PATH)
    ? (JSON.parse(readFileSync(SECRETS_PATH, "utf8")) as string[])
    : [];
  saved.push(secret.toString(16).padStart(64, "0"));
  writeFileSync(SECRETS_PATH, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  chmodSync(SECRETS_PATH, 0o600);
  return secret;
}

/** Fee and size of a confirmed tx, from Koios. */
async function txInfo(txId: string): Promise<{ fee: number; size: number }> {
  const res = await fetch(`${koiosBaseUrl("preprod")}/tx_info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ _tx_hashes: [txId], _inputs: false, _scripts: false }),
  });
  const [row] = (await res.json()) as Array<{ fee: string; tx_size: number }>;
  if (!row) throw new Error(`Koios has no tx_info for ${txId}`);
  return { fee: Number(row.fee), size: row.tx_size };
}

// --- Minimal CBOR splicing: swap one output's value in a tx, byte-exactly ---

/** Offset just past the CBOR item that starts at `at`. */
function itemEnd(b: Uint8Array, at: number): number {
  const major = b[at]! >> 5;
  const info = b[at]! & 0x1f;
  let pos = at + 1;
  let arg = info;
  if (info === 24) arg = b[pos++]!;
  else if (info === 25) ((arg = (b[pos]! << 8) | b[pos + 1]!), (pos += 2));
  else if (info === 26)
    ((arg = new DataView(b.buffer, b.byteOffset + pos).getUint32(0)), (pos += 4));
  else if (info === 27)
    ((arg = Number(new DataView(b.buffer, b.byteOffset + pos).getBigUint64(0))), (pos += 8));
  const indefinite = info === 31;
  switch (major) {
    case 0:
    case 1:
    case 7:
      return pos;
    case 2:
    case 3:
      if (!indefinite) return pos + arg;
      while (b[pos] !== 0xff) pos = itemEnd(b, pos);
      return pos + 1;
    case 4:
    case 5: {
      const items = major === 5 ? arg * 2 : arg;
      if (indefinite) {
        while (b[pos] !== 0xff) pos = itemEnd(b, pos);
        return pos + 1;
      }
      for (let i = 0; i < items; i++) pos = itemEnd(b, pos);
      return pos;
    }
    case 6:
      return itemEnd(b, pos);
    default:
      throw new Error(`unsupported CBOR major type ${major}`);
  }
}

/** Header length and entry count of a definite map or array at `at`. */
function header(b: Uint8Array, at: number): { start: number; count: number } {
  const info = b[at]! & 0x1f;
  if (info < 24) return { start: at + 1, count: info };
  if (info === 24) return { start: at + 2, count: b[at + 1]! };
  if (info === 25) return { start: at + 3, count: (b[at + 1]! << 8) | b[at + 2]! };
  throw new Error("unexpected CBOR container header");
}

/** Find the value of integer key `key` in the definite map at `at`. */
function mapValue(b: Uint8Array, at: number, key: number): { start: number; end: number } {
  let { start: pos, count } = header(b, at);
  for (; count > 0; count--) {
    const valueStart = itemEnd(b, pos);
    if (b[pos] === key) return { start: valueStart, end: itemEnd(b, valueStart) };
    pos = itemEnd(b, valueStart);
  }
  throw new Error(`map key ${key} not found`);
}

/** Replace the value of output `index` (post-Alonzo map form) in a tx. */
function replaceOutputValue(txHex: string, index: number, valueHex: string): string {
  const b = Buffer.from(txHex, "hex");
  const body = header(b, 0).start;
  const outputs = mapValue(b, body, 1).start;
  let pos = header(b, outputs).start;
  for (let i = 0; i < index; i++) pos = itemEnd(b, pos);
  if (b[pos]! >> 5 !== 5) throw new Error("expected a post-Alonzo (map) output");
  const value = mapValue(b, pos, 1);
  return txHex.slice(0, value.start * 2) + valueHex + txHex.slice(value.end * 2);
}

function cborHead(major: number, n: bigint): string {
  const m = major << 5;
  const hex = (v: bigint, bytes: number): string => v.toString(16).padStart(bytes * 2, "0");
  if (n < 24n) return hex(BigInt(m) + n, 1);
  if (n < 0x100n) return hex(BigInt(m + 24), 1) + hex(n, 1);
  if (n < 0x10000n) return hex(BigInt(m + 25), 1) + hex(n, 2);
  if (n < 0x100000000n) return hex(BigInt(m + 26), 1) + hex(n, 4);
  return hex(BigInt(m + 27), 1) + hex(n, 8);
}

/** Ledger Value CBOR: `coin` or `[coin, {policy: {name: qty}}]`. */
function encodeValue(lovelace: bigint, assets: Array<[string, string, bigint]>): string {
  if (assets.length === 0) return cborHead(0, lovelace);
  const byPolicy = new Map<string, Array<[string, bigint]>>();
  for (const [policy, name, qty] of assets) {
    byPolicy.set(policy, [...(byPolicy.get(policy) ?? []), [name, qty]]);
  }
  let multiasset = cborHead(5, BigInt(byPolicy.size));
  for (const [policy, names] of byPolicy) {
    multiasset += cborHead(2, 28n) + policy + cborHead(5, BigInt(names.length));
    for (const [name, qty] of names) {
      multiasset += cborHead(2, BigInt(name.length / 2)) + name + cborHead(0, qty);
    }
  }
  return `82${cborHead(0, lovelace)}${multiasset}`;
}
