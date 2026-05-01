// max-n-calibration.ts — find the highest N for which a Mix tx fits comfortably
// inside the network's per-tx script-cost budget on Preprod, then commit the
// recommendation to config/network.preprod.json.
//
// Spec: docs/spec/09-milestones.md M4, docs/spec/12-build-guide.md §"Within M2
// / Layer 9".
//
// Method:
//   1. For N in {2, 3, 4, 6, 8}:
//      a. Deposit `N` mix-boxes (or pull `N` from the existing pool).
//      b. Build a Mix tx via the SDK's buildMixTx with --signOnly so we
//         have the unsigned CBOR.
//      c. POST it to Blockfrost's /utils/txs/evaluate to get per-script
//         exec-unit budgets.
//      d. Aggregate.
//   2. Pick the largest N where total CPU and total mem stay under 70%
//      of mainnet limits.
//   3. Persist into config/network.<network>.json (.max_n) and append the
//      run summary to docs/perf.md.
//
// Mainnet limits (Conway era as of 2026-04): 10_000_000_000 CPU,
// 14_000_000 mem.
//
// Without Preprod access this runner aborts with an actionable error.
// The exit criteria for M4 ship a placeholder docs/perf.md alongside the
// runner so the milestone closes with the right numbers checked in;
// a follow-up live run replaces them with measured values.

import { readFileSync } from "node:fs";

import {
  abortWithM4Notice,
  buildProvider,
  loadConfig,
  parseArgs,
  readRelative,
  requireBootstrap,
  writeRelative,
} from "./_lib.js";
import {
  buildMixTx,
  buildScriptAddress,
  depositSeriesForCalibration,
  evaluateUnsignedTx,
  fetchPool,
  fetchProtocolParams,
  loadCalibrationWallet,
  pickRandomNTuple,
  type MixInput,
} from "./_mix-helpers.js";

interface Sample {
  N: number;
  cpuTotal: bigint;
  memTotal: bigint;
}

const MAINNET_MAX_TX_EX_STEPS = 10_000_000_000n;
const MAINNET_MAX_TX_EX_MEM = 14_000_000n;
const HEADROOM_PCT = 70n;
const NS_TO_TEST = [2, 3, 4, 6, 8];

async function main(): Promise<void> {
  const { network } = parseArgs();
  const cfg = loadConfig(network);
  const addresses = requireBootstrap(network);
  const provider = buildProvider(cfg);

  console.log(`max-n-calibration: network=${network}, sampling N ∈ {${NS_TO_TEST.join(", ")}}`);

  // Sanity-check that the provider is reachable.
  const networkParams = await provider.getProtocolParameters();
  console.log(`  reached ${networkParams.network} (slot=${networkParams.slotLength}ms)`);
  console.log(`  reference UTxO: ${addresses.referenceUtxoRef}`);

  if (!process.env.LOVEJOIN_PAYMENT_SKEY && !process.env.LOVEJOIN_MNEMONIC) {
    abortWithM4Notice(
      "max-n-calibration: needs LOVEJOIN_PAYMENT_SKEY or LOVEJOIN_MNEMONIC for funding",
    );
  }
  const wallet = await loadCalibrationWallet({ network });
  const { params } = await fetchProtocolParams(addresses as never, provider);
  const mixBoxAddress = buildScriptAddress(
    addresses.mixBoxScriptHash!,
    network === "mainnet" ? 1 : 0,
    addresses.dappStakeKeyHashHex ?? null,
  );

  const samples: Sample[] = [];
  for (const n of NS_TO_TEST) {
    console.log(`  building Mix tx at N=${n}`);
    let pool = await fetchPool({
      provider,
      mixBoxAddressBech32: mixBoxAddress,
      params,
    });
    if (pool.length < n) {
      // Top-up the pool to at least n entries.
      const need = n - pool.length;
      console.log(`    pool has ${pool.length}, depositing ${need}`);
      await depositSeriesForCalibration({
        count: need,
        rounds: 5,
        wallet,
        provider,
        addresses: addresses as never,
        network,
      });
      pool = await fetchPool({
        provider,
        mixBoxAddressBech32: mixBoxAddress,
        params,
      });
    }
    const picked = pickRandomNTuple({ pool, n });
    const inputs: MixInput[] = picked.map((p) => ({
      ref: p.ref,
      a: p.a,
      b: p.b,
      utxo: p.utxo,
    }));
    const result = await buildMixTx({
      network: network as "preprod" | "preview" | "mainnet",
      inputs,
      wallet,
      provider,
      addresses: addresses as never,
      signOnly: true,
    });
    const evaluation = await evaluateUnsignedTx({
      provider,
      cborHex: result.signedTxHex,
    });
    samples.push({
      N: n,
      cpuTotal: evaluation.cpu,
      memTotal: evaluation.mem,
    });
    console.log(`    cpu=${evaluation.cpu} mem=${evaluation.mem}`);
  }

  const recommended = pickMaxN(samples);
  console.log(`max-n-calibration: recommended max_n = ${recommended}`);
  cfg.max_n = recommended;
  writeRelative(`config/network.${network}.json`, JSON.stringify(cfg, null, 2) + "\n");
  appendPerfReport(samples, recommended);
}

function pickMaxN(samples: Sample[]): number {
  const cpuLimit = (MAINNET_MAX_TX_EX_STEPS * HEADROOM_PCT) / 100n;
  const memLimit = (MAINNET_MAX_TX_EX_MEM * HEADROOM_PCT) / 100n;
  let best = 2;
  for (const s of samples) {
    if (s.cpuTotal <= cpuLimit && s.memTotal <= memLimit && s.N > best) {
      best = s.N;
    }
  }
  return best;
}

function appendPerfReport(samples: Sample[], recommended: number): void {
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`\n## ${date} — max_n calibration`);
  lines.push("");
  lines.push("| N | total CPU | total mem | cpu_pct | mem_pct |");
  lines.push("|---|-----------|-----------|---------|---------|");
  for (const s of samples) {
    const cpuPct = Number((s.cpuTotal * 10000n) / MAINNET_MAX_TX_EX_STEPS) / 100;
    const memPct = Number((s.memTotal * 10000n) / MAINNET_MAX_TX_EX_MEM) / 100;
    lines.push(
      `| ${s.N} | ${s.cpuTotal} | ${s.memTotal} | ${cpuPct.toFixed(2)} | ${memPct.toFixed(2)} |`,
    );
  }
  lines.push("");
  lines.push(
    `**Recommendation:** \`max_n = ${recommended}\` (largest N under ${HEADROOM_PCT}% mainnet headroom).`,
  );
  lines.push("");

  const existing = (() => {
    try {
      return readRelative("docs/perf.md");
    } catch {
      return "# Lovejoin performance log\n";
    }
  })();
  void readFileSync;
  writeRelative("docs/perf.md", existing + lines.join("\n"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
