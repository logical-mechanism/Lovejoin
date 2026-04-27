// max-n-calibration.ts — find the highest N for which a Mix tx fits comfortably
// inside the network's per-tx script-cost budget on Preprod, then commit the
// recommendation to config/network.preprod.json.
//
// Spec: docs/spec/09-milestones.md M2 Risk 3, docs/spec/12-build-guide.md
//        §"Within M2 / Layer 9".
//
// Method:
//   1. For N in {2, 3, 4, 6, 8}:
//      a. Build a Mix tx with N inputs + N outputs + fee shard + collateral.
//      b. Have Blockfrost evaluate the tx (POST /utils/txs/evaluate) — this
//         returns per-script CPU/mem without paying for submission.
//      c. Record the totals.
//   2. Pick the largest N where totalCpu < 0.70 * mainnet maxTxExSteps and
//      totalMem < 0.70 * mainnet maxTxExMem.
//   3. Persist into config/network.preprod.json (.max_n) and append the run
//      summary to docs/perf.md.
//
// Mainnet limits (current Conway): 10_000_000_000 CPU, 14_000_000 mem.
// We compare against MAINNET limits even though we're running on Preprod —
// max_n must hold on mainnet for v1 to be meaningful.

import {
  buildProvider,
  loadConfig,
  parseArgs,
  requireBootstrap,
  writeRelative,
  abortWithM4Notice,
} from "./_lib.js";

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

  abortWithM4Notice("max-n-calibration");

  // Below is the shape the code will take when M4's mix tx builder lands.
  // Kept here so the data-flow + output schema are reviewable now.
  // eslint-disable-next-line no-unreachable
  const samples: Sample[] = [];
  for (const n of NS_TO_TEST) {
    const tx = await buildMixTxStub(n, addresses, provider);
    const evaluation = await evaluateTxStub(tx);
    samples.push({ N: n, cpuTotal: evaluation.cpu, memTotal: evaluation.mem });
    console.log(`  N=${n}: cpu=${evaluation.cpu} mem=${evaluation.mem}`);
  }

  const recommended = pickMaxN(samples);
  console.log(`max-n-calibration: recommended max_n = ${recommended}`);

  // Persist into network.<network>.json.
  cfg.max_n = recommended;
  writeRelative(`config/network.${network}.json`, JSON.stringify(cfg, null, 2) + "\n");

  // Append a run summary to docs/perf.md.
  appendPerfReport(samples, recommended);
}

async function buildMixTxStub(
  _n: number,
  _addresses: ReturnType<typeof requireBootstrap>,
  _provider: ReturnType<typeof buildProvider>,
): Promise<{ cborHex: string }> {
  throw new Error("M4-required: replace with offchain/src/tx/mix.ts builder");
}

async function evaluateTxStub(_tx: {
  cborHex: string;
}): Promise<{ cpu: bigint; mem: bigint }> {
  throw new Error("M4-required: invoke Blockfrost /utils/txs/evaluate");
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
    lines.push(`| ${s.N} | ${s.cpuTotal} | ${s.memTotal} | ${cpuPct.toFixed(2)} | ${memPct.toFixed(2)} |`);
  }
  lines.push("");
  lines.push(`**Recommendation:** \`max_n = ${recommended}\` (largest N under ${HEADROOM_PCT}% mainnet headroom).`);
  lines.push("");

  const existing = (() => {
    try {
      return readPerf();
    } catch {
      return "# Lovejoin performance log\n";
    }
  })();
  writeRelative("docs/perf.md", existing + lines.join("\n"));
}

function readPerf(): string {
  // Lazy require to avoid pulling fs at top-level when stub aborts early.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require("node:fs");
  const { resolve } = require("node:path");
  return readFileSync(
    resolve(import.meta.dirname, "..", "docs/perf.md"),
    "utf8",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
