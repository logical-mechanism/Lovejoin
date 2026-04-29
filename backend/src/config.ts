// Backend configuration: env vars + the bootstrap-produced addresses.json.
//
// Spec: docs/spec/05-backend.md §"Environment / config".
//
// We load addresses.json once at startup. Re-bootstrapping the protocol
// produces a new file; the indexer should be restarted to pick it up. That
// matches the spec's "no live re-bootstrap" stance — bootstrap is a
// one-shot ceremony.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildScriptAddress } from "./address.js";

/** A 28-byte hash, lowercase hex (script hash, NFT policy id, etc.). */
export type Hex28 = string;
/** A 32-byte hash, lowercase hex (txid, block hash). */
export type Hex32 = string;

/**
 * Subset of `artifacts/<network>/addresses.json` the backend needs. Mirrors
 * the offchain SDK's `LovejoinAddresses` shape but kept independent so the
 * backend doesn't depend on `@lovejoin/sdk` (M5 ships before the SDK is
 * declared an internal dep, and pulling it would drag in mesh / cbor-x).
 */
export interface LovejoinAddresses {
  network: "preprod" | "mainnet" | "preview";
  protocol: {
    denom_lovelace: number;
    max_fee_per_mix_lovelace: number;
    /** Optional informational only; the validator never reads this. */
    fee_shard_target?: number;
  };
  referenceNftPolicy: Hex28;
  referenceNftAssetName: string;
  referenceUtxoRef: string;
  referenceHolderScriptHash: Hex28;
  mixLogicScriptHash: Hex28;
  mixBoxScriptHash: Hex28;
  feeScriptHash: Hex28;
  feeShardUtxos: string[];
  /** Optional dApp stake-key hash for base-address derivation. */
  dappStakeKeyHashHex?: Hex28;
}

/** Resolved runtime configuration. */
export interface BackendConfig {
  network: "preprod" | "mainnet" | "preview";
  port: number;
  host: string;
  ogmiosUrl: string;
  /**
   * Optional — db-sync is the primary `/history/:address` source. If both
   * `dbsyncUrl` and `blockfrostProjectId` are set, db-sync is preferred and
   * Blockfrost is the fallback when db-sync errors. If only one is set
   * the route uses it directly; if neither, `/history` returns 503.
   */
  dbsyncUrl: string | null;
  /**
   * Optional Blockfrost project id. When set, `/history/:address` falls
   * back to Blockfrost while db-sync is unavailable (initial sync, brief
   * outage). Same env var convention as the SDK.
   */
  blockfrostProjectId: string | null;
  /**
   * Optional Blockfrost base URL override. Defaults to the public
   * Blockfrost endpoint for `network` when `blockfrostProjectId` is set.
   */
  blockfrostBaseUrl: string | null;
  /** Origin allowlist for CORS, or `*` to allow all. */
  corsOrigins: string[] | "*";
  /** Per-IP rate limit, requests per minute. */
  rateLimitPerMin: number;
  addresses: LovejoinAddresses;
  /** Bech32 address strings derived from the script hashes + dapp stake key. */
  derived: {
    mixBoxAddress: string;
    feeContractAddress: string;
    referenceHolderAddress: string;
  };
}

const DEFAULTS = {
  port: 3001,
  host: "0.0.0.0",
  rateLimitPerMin: 600,
};

/**
 * Resolve the backend configuration from process env vars and the
 * addresses.json the bootstrap ceremony produced.
 *
 * @param env Defaults to `process.env`. Tests inject a synthetic env.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): BackendConfig {
  const network = parseNetwork(env.NETWORK ?? "preprod");
  const port = parseIntegerEnv(env.PORT, DEFAULTS.port, "PORT");
  const host = env.HOST?.trim() || DEFAULTS.host;
  const ogmiosUrl = (env.OGMIOS_URL ?? "ws://localhost:1337").trim();
  const dbsyncUrl = env.DBSYNC_URL?.trim() || null;
  const blockfrostProjectId = env.BLOCKFROST_PROJECT_ID?.trim() || null;
  const blockfrostBaseUrl = env.BLOCKFROST_BASE_URL?.trim() || null;
  const corsOrigins = parseCorsOrigins(env.CORS_ORIGINS);
  const rateLimitPerMin = parseIntegerEnv(
    env.RATE_LIMIT_PER_MIN,
    DEFAULTS.rateLimitPerMin,
    "RATE_LIMIT_PER_MIN",
  );

  const addressesPath = env.ADDRESSES_PATH ?? defaultAddressesPath(network);
  const addresses = loadAddresses(addressesPath);

  const networkId: 0 | 1 = network === "mainnet" ? 1 : 0;
  const stakeKey = addresses.dappStakeKeyHashHex ?? null;
  const derived = {
    mixBoxAddress: buildScriptAddress(addresses.mixBoxScriptHash, networkId, stakeKey),
    // Fee shards live at the enterprise (unstaked) script address — the
    // bootstrap funded them there, so the indexer + API must look up the
    // unstaked address regardless of the dApp stake key.
    feeContractAddress: buildScriptAddress(addresses.feeScriptHash, networkId, null),
    referenceHolderAddress: buildScriptAddress(
      addresses.referenceHolderScriptHash,
      networkId,
      stakeKey,
    ),
  };

  return {
    network,
    port,
    host,
    ogmiosUrl,
    dbsyncUrl,
    blockfrostProjectId,
    blockfrostBaseUrl,
    corsOrigins,
    rateLimitPerMin,
    addresses,
    derived,
  };
}

/** Parse + validate addresses.json. Exported for tests. */
export function loadAddresses(path: string): LovejoinAddresses {
  const absolute = resolve(path);
  const raw = readFileSync(absolute, "utf8");
  const parsed = JSON.parse(raw) as Partial<LovejoinAddresses>;
  return validateAddresses(parsed, absolute);
}

export function validateAddresses(
  parsed: Partial<LovejoinAddresses>,
  source: string,
): LovejoinAddresses {
  const errs: string[] = [];
  function require28(name: keyof LovejoinAddresses): void {
    const v = parsed[name];
    if (typeof v !== "string" || !/^[0-9a-f]{56}$/.test(v)) {
      errs.push(`${name} must be 28-byte lowercase hex (got ${JSON.stringify(v)})`);
    }
  }
  if (
    parsed.network !== "preprod" &&
    parsed.network !== "mainnet" &&
    parsed.network !== "preview"
  ) {
    errs.push(`network must be preprod/mainnet/preview (got ${JSON.stringify(parsed.network)})`);
  }
  require28("referenceNftPolicy");
  require28("referenceHolderScriptHash");
  require28("mixLogicScriptHash");
  require28("mixBoxScriptHash");
  require28("feeScriptHash");
  if (typeof parsed.referenceNftAssetName !== "string") {
    errs.push("referenceNftAssetName must be a string");
  }
  if (typeof parsed.referenceUtxoRef !== "string") {
    errs.push("referenceUtxoRef must be a string");
  }
  if (!Array.isArray(parsed.feeShardUtxos)) {
    errs.push("feeShardUtxos must be an array");
  }
  if (!parsed.protocol || typeof parsed.protocol !== "object") {
    errs.push("protocol must be an object");
  }
  if (errs.length > 0) {
    throw new Error(
      `addresses.json (${source}) is malformed:\n  - ${errs.join("\n  - ")}`,
    );
  }
  return parsed as LovejoinAddresses;
}

function parseNetwork(s: string): "preprod" | "mainnet" | "preview" {
  const v = s.trim().toLowerCase();
  if (v === "preprod" || v === "mainnet" || v === "preview") return v;
  throw new Error(`NETWORK must be preprod / mainnet / preview, got ${s}`);
}

function parseIntegerEnv(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseCorsOrigins(raw: string | undefined): string[] | "*" {
  if (!raw || raw.trim() === "" || raw.trim() === "*") return "*";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function defaultAddressesPath(network: string): string {
  return `./artifacts/${network}/addresses.json`;
}
