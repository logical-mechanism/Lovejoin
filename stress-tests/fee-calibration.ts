// fee-calibration.ts — measure the worst-case Cardano-charged fee for a Mix tx
// at the recommended max_n, and set max_fee_per_mix_lovelace = ceil(max × 1.25).
//
// Spec: docs/spec/09-milestones.md M2.
//
// Until M4's Mix tx builder lands this runner aborts with a "needs M4" notice.
// The output schema (samples table + recommendation in docs/perf.md, value
// committed to network.<net>.json) is defined here so reviewers can sanity
// check the shape now.

import {
  buildProvider,
  loadConfig,
  parseArgs,
  requireBootstrap,
  writeRelative,
  abortWithM4Notice,
} from "./_lib.js";

const POOL_SIZES = [16, 64, 256];
const SAMPLES_PER_POOL_SIZE = 10;

interface Sample {
  poolSize: number;
  N: number;
  feeLovelace: number;
}

async function main(): Promise<void> {
  const { network } = parseArgs();
  const cfg = loadConfig(network);
  const addresses = requireBootstrap(network);
  const provider = buildProvider(cfg);

  const targetN = cfg.max_n;
  console.log(
    `fee-calibration: network=${network}, target N=${targetN}, ` +
      `pool sizes=${POOL_SIZES.join(",")} samples each=${SAMPLES_PER_POOL_SIZE}`,
  );
  console.log(`  reference UTxO: ${addresses.referenceUtxoRef}`);
  // touch provider so it isn't unused in the stub
  await provider.getProtocolParameters();

  abortWithM4Notice("fee-calibration");

  // eslint-disable-next-line no-unreachable
  const samples: Sample[] = [];
  for (const poolSize of POOL_SIZES) {
    for (let i = 0; i < SAMPLES_PER_POOL_SIZE; i++) {
      const fee = await runOneMixSample(poolSize, targetN);
      samples.push({ poolSize, N: targetN, feeLovelace: fee });
    }
  }

  const max = samples.reduce((a, s) => (s.feeLovelace > a ? s.feeLovelace : a), 0);
  const recommended = Math.ceil(max * 1.25);

  cfg.max_fee_per_mix_lovelace = recommended;
  writeRelative(`config/network.${network}.json`, JSON.stringify(cfg, null, 2) + "\n");
  appendPerfReport(samples, recommended);

  console.log(
    `fee-calibration: max observed = ${max} lovelace, recommended max_fee_per_mix = ${recommended}`,
  );
}

async function runOneMixSample(_poolSize: number, _n: number): Promise<number> {
  throw new Error("M4-required: build + submit one Mix tx, return self.fee");
}

function appendPerfReport(samples: Sample[], recommended: number): void {
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`\n## ${date} — fee calibration`);
  lines.push("");
  lines.push("| pool size | N | fee lovelace |");
  lines.push("|-----------|---|--------------|");
  for (const s of samples) {
    lines.push(`| ${s.poolSize} | ${s.N} | ${s.feeLovelace} |`);
  }
  lines.push("");
  lines.push(`**Recommendation:** \`max_fee_per_mix_lovelace = ${recommended}\` (max observed × 1.25).`);
  lines.push("");

  const existing = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { readFileSync } = require("node:fs");
      const { resolve } = require("node:path");
      return readFileSync(resolve(import.meta.dirname, "..", "docs/perf.md"), "utf8");
    } catch {
      return "# Lovejoin performance log\n";
    }
  })();
  writeRelative("docs/perf.md", existing + lines.join("\n"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
