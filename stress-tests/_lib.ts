// Shared helpers for the stress-test runners.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BlockfrostProvider, type ChainProvider } from "@lovejoin/sdk";

export interface NetworkConfig {
  network: string;
  denom_lovelace: number;
  max_fee_per_mix_lovelace: number;
  max_n: number;
  fee_shard_target: number;
  provider: {
    kind: "blockfrost";
    baseUrl: string;
    projectIdEnv: string;
  };
}

export interface Addresses {
  network: string;
  protocol: {
    denom_lovelace: number;
    max_fee_per_mix_lovelace: number;
    max_n: number;
    /** Optional informational only; the validator never reads this. */
    fee_shard_target?: number;
  };
  referenceNftPolicy: string | null;
  referenceNftAssetName: string | null;
  referenceUtxoRef: string | null;
  mixLogicScriptHash: string | null;
  mixBoxScriptHash: string | null;
  feeScriptHash: string | null;
  feeShardUtxos: string[];
  referenceScriptUtxos: Record<string, string>;
  /** Optional 28-byte hex stake-key hash baked into every dApp UTxO. */
  dappStakeKeyHashHex?: string;
}

export function repoRoot(): string {
  return resolve(import.meta.dirname, "..");
}

export function loadConfig(network: string): NetworkConfig {
  return JSON.parse(readFileSync(resolve(repoRoot(), `config/network.${network}.json`), "utf8"));
}

export function loadAddresses(network: string): Addresses {
  return JSON.parse(
    readFileSync(resolve(repoRoot(), `artifacts/${network}/addresses.json`), "utf8"),
  );
}

export function buildProvider(cfg: NetworkConfig): ChainProvider {
  const projectId = process.env[cfg.provider.projectIdEnv];
  if (!projectId) {
    throw new Error(
      `stress-tests: ${cfg.provider.projectIdEnv} env var must be set (Blockfrost project id for ${cfg.network})`,
    );
  }
  return new BlockfrostProvider({
    baseUrl: cfg.provider.baseUrl,
    projectId,
  });
}

/**
 * Stress-test pre-flight: every runner depends on (a) the protocol being fully
 * bootstrapped on the target network and (b) the M4 Mix tx builder being
 * available. Until M4 lands, runners abort here with a clear "needs M4" path.
 *
 * @returns the loaded addresses on success.
 */
export function requireBootstrap(network: string): Addresses {
  const a = loadAddresses(network);
  if (
    !a.referenceNftPolicy ||
    !a.referenceUtxoRef ||
    !a.mixLogicScriptHash ||
    a.feeShardUtxos.length === 0
  ) {
    throw new Error(
      [
        `stress-tests: ${network} not bootstrapped yet.`,
        `Run infra/bootstrap/{00,01,02,03}-*.sh first; addresses.json needs:`,
        `  referenceNftPolicy, referenceUtxoRef, mixLogicScriptHash,`,
        `  feeShardUtxos.length > 0, referenceScriptUtxos.{mix_box,mix_logic,fee_contract}`,
      ].join("\n"),
    );
  }
  return a;
}

export function abortWithM4Notice(message: string): never {
  console.error(message);
  process.exit(2);
}

export function writeRelative(relativePath: string, content: string): void {
  writeFileSync(resolve(repoRoot(), relativePath), content);
}

export function readRelative(relativePath: string): string {
  return readFileSync(resolve(repoRoot(), relativePath), "utf8");
}

export function parseArgs(): {
  network: string;
  rest: string[];
} {
  const argv = process.argv.slice(2);
  let network = process.env.NETWORK ?? "preprod";
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--network" || argv[i] === "-n") {
      network = argv[++i] ?? network;
    } else {
      rest.push(argv[i]!);
    }
  }
  return { network, rest };
}
