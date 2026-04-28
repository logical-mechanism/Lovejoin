// fee-calibration.ts — measure the worst-case Cardano-charged fee for a Mix tx
// at the recommended max_n, and set max_fee_per_mix_lovelace = ceil(max × 1.25).
//
// Spec: docs/spec/09-milestones.md M4.
//
// Method:
//   1. Determine the target N from config (max_n).
//   2. For each pool size in {16, 64, 256}, build SAMPLES_PER_POOL_SIZE
//      Mix txs at width N, run the Blockfrost evaluator to get the
//      tight ex-units, derive the fee from those + tx size + network
//      params, and record.
//   3. Pick `ceil(max × 1.25)`. Persist into config + docs/perf.md.

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

  if (!process.env.LOVEJOIN_PAYMENT_SKEY && !process.env.LOVEJOIN_MNEMONIC) {
    abortWithM4Notice(
      "fee-calibration: needs LOVEJOIN_PAYMENT_SKEY or LOVEJOIN_MNEMONIC for funding",
    );
  }
  const wallet = await loadCalibrationWallet({ network });
  const { params: lovejoinParams } = await fetchProtocolParams(addresses as never, provider);
  const networkParams = await provider.getProtocolParameters();
  const mixBoxAddress = buildScriptAddress(
    addresses.mixBoxScriptHash!,
    network === "mainnet" ? 1 : 0,
    addresses.dappStakeKeyHashHex ?? null,
  );

  const samples: Sample[] = [];
  for (const poolSize of POOL_SIZES) {
    // Top up the pool to at least poolSize entries.
    let pool = await fetchPool({
      provider,
      mixBoxAddressBech32: mixBoxAddress,
      params: lovejoinParams,
    });
    if (pool.length < poolSize) {
      const need = poolSize - pool.length;
      console.log(`  pool=${pool.length}, depositing ${need} to reach ${poolSize}`);
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
        params: lovejoinParams,
      });
    }

    for (let i = 0; i < SAMPLES_PER_POOL_SIZE; i++) {
      const picked = pickRandomNTuple({ pool, n: targetN });
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
      const fee = computeFee({
        cpu: Number(evaluation.cpu),
        mem: Number(evaluation.mem),
        sizeBytes: result.signedTxHex.length / 2,
        params: networkParams,
      });
      samples.push({ poolSize, N: targetN, feeLovelace: fee });
      console.log(`    sample ${i + 1}: cpu=${evaluation.cpu} mem=${evaluation.mem} fee=${fee}`);
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

function computeFee(args: {
  cpu: number;
  mem: number;
  sizeBytes: number;
  params: { minFeeA: number; minFeeB: number; pricesStep: number; pricesMem: number };
}): number {
  // Cardano fee = a × tx_size + b + execution_fee
  // execution_fee = price_step × cpu + price_mem × mem
  const sizeFee = args.params.minFeeA * args.sizeBytes + args.params.minFeeB;
  const execFee = args.params.pricesStep * args.cpu + args.params.pricesMem * args.mem;
  return Math.ceil(sizeFee + execFee);
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
  lines.push(
    `**Recommendation:** \`max_fee_per_mix_lovelace = ${recommended}\` (max observed × 1.25).`,
  );
  lines.push("");

  const existing = (() => {
    try {
      return readRelative("docs/perf.md");
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
