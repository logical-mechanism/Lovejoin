// Backend configuration: env vars + the bootstrap-produced addresses.json.
//
// Spec: §"Environment / config".
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
  /**
   * Optional chain point at-or-just-before the protocol's bootstrap tx.
   * The indexer uses this as its chainsync intersection so a fresh
   * backend doesn't re-walk the entire chain. Stamped by
   * `infra/bootstrap/stamp-start-point.sh` after `02-mint-and-lock.sh`
   * lands. Override with `BOOTSTRAP_START_SLOT` + `BOOTSTRAP_START_BLOCKHASH`.
   */
  bootstrapStartPoint?: { slot: number; blockHash: Hex32 };
}

/** Resolved runtime configuration. */
export interface BackendConfig {
  network: "preprod" | "mainnet" | "preview";
  port: number;
  host: string;
  ogmiosUrl: string;
  /**
   * Optional — db-sync backs `/tx/:hash` + `/tx/:hash/utxos` (the SDK's
   * `awaitConfirmation` and `getUtxoByRef` paths). When unset those
   * routes return 503; chain-state routes (`/utxos`, `/pool`, `/fee`)
   * are served from indexer state and don't need db-sync.
   */
  dbsyncUrl: string | null;
  /** Origin allowlist for CORS, or `*` to allow all. */
  corsOrigins: string[] | "*";
  /** Per-IP rate limit, requests per minute. */
  rateLimitPerMin: number;
  addresses: LovejoinAddresses;
  /**
   * Bech32 enterprise script-address strings derived from the script
   * hashes. All dApp UTxOs live at enterprise addresses (no stake
   * credential) — the on-chain perimeter (audit H-01) rejects anything
   * else, so this is the single canonical address shape per script.
   */
  derived: {
    mixBoxAddress: string;
    feeContractAddress: string;
    referenceHolderAddress: string;
    /**
     * Seedelf wallet-script enterprise address — derived from the
     * canonical Seedelf-Wallet deployment for this network (same hash
     * on preprod + mainnet, override via SEEDELF_WALLET_SCRIPT_HASH).
     * Allowlisted on `/utxos/:address` so the Vault's Seedelf panel
     * pulls from db-sync instead of falling back to Blockfrost.
     */
    seedelfWalletAddress: string;
  };
  /**
   * Resolved chainsync intersection point, in priority order:
   *   1. `BOOTSTRAP_START_SLOT` + `BOOTSTRAP_START_BLOCKHASH` env vars
   *   2. `addresses.bootstrapStartPoint` (stamped post-bootstrap)
   *   3. null → indexer falls back to `["origin"]`
   * Skipping ahead past genesis is the difference between the indexer
   * being usable in minutes vs. days.
   */
  bootstrapStartPoint: { slot: number; blockHash: Hex32 } | null;
}

const DEFAULTS = {
  port: 3001,
  host: "0.0.0.0",
  rateLimitPerMin: 600,
};

/**
 * Canonical Seedelf wallet-script hash. Same on preprod + mainnet —
 * matches the SDK's `SEEDELF_PREPROD_ADDRESSES.walletScriptHash` /
 * `SEEDELF_MAINNET_ADDRESSES.walletScriptHash`. Operators running a
 * private Seedelf deployment override via `SEEDELF_WALLET_SCRIPT_HASH`.
 */
const DEFAULT_SEEDELF_WALLET_SCRIPT_HASH =
  "94bca9c099e84ffd90d150316bb44c31a78702239076a0a80ea4a469";

/**
 * Resolve the backend configuration from process env vars and the
 * addresses.json the bootstrap ceremony produced.
 *
 * @param env Defaults to `process.env`. Tests inject a synthetic env.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const network = parseNetwork(env.NETWORK ?? "preprod");
  const port = parseIntegerEnv(env.PORT, DEFAULTS.port, "PORT");
  const host = env.HOST?.trim() || DEFAULTS.host;
  const ogmiosUrl = (env.OGMIOS_URL ?? "ws://localhost:1337").trim();
  const dbsyncUrl = env.DBSYNC_URL?.trim() || null;
  const corsOrigins = parseCorsOrigins(env.CORS_ORIGINS);
  const rateLimitPerMin = parseIntegerEnv(
    env.RATE_LIMIT_PER_MIN,
    DEFAULTS.rateLimitPerMin,
    "RATE_LIMIT_PER_MIN",
  );

  const addressesPath = env.ADDRESSES_PATH ?? defaultAddressesPath(network);
  const addresses = loadAddresses(addressesPath);
  const bootstrapStartPoint = resolveBootstrapStartPoint(env, addresses);

  const networkId: 0 | 1 = network === "mainnet" ? 1 : 0;
  const seedelfWalletScriptHash =
    env.SEEDELF_WALLET_SCRIPT_HASH?.trim() || DEFAULT_SEEDELF_WALLET_SCRIPT_HASH;
  if (!/^[0-9a-f]{56}$/.test(seedelfWalletScriptHash)) {
    throw new Error(
      `SEEDELF_WALLET_SCRIPT_HASH must be 56-char lowercase hex, got ${JSON.stringify(seedelfWalletScriptHash)}`,
    );
  }
  const derived = {
    mixBoxAddress: buildScriptAddress(addresses.mixBoxScriptHash, networkId),
    feeContractAddress: buildScriptAddress(addresses.feeScriptHash, networkId),
    referenceHolderAddress: buildScriptAddress(addresses.referenceHolderScriptHash, networkId),
    seedelfWalletAddress: buildScriptAddress(seedelfWalletScriptHash, networkId),
  };

  return {
    network,
    port,
    host,
    ogmiosUrl,
    dbsyncUrl,
    corsOrigins,
    rateLimitPerMin,
    addresses,
    derived,
    bootstrapStartPoint,
  };
}

function resolveBootstrapStartPoint(
  env: NodeJS.ProcessEnv,
  addresses: LovejoinAddresses,
): { slot: number; blockHash: Hex32 } | null {
  const slotRaw = env.BOOTSTRAP_START_SLOT?.trim();
  const hashRaw = env.BOOTSTRAP_START_BLOCKHASH?.trim();
  // Either both env vars or neither — treating only one as set is almost
  // always a config typo and silently falling back is worse than yelling.
  if ((slotRaw && !hashRaw) || (!slotRaw && hashRaw)) {
    throw new Error("BOOTSTRAP_START_SLOT and BOOTSTRAP_START_BLOCKHASH must be set together");
  }
  if (slotRaw && hashRaw) {
    const slot = Number(slotRaw);
    if (!Number.isInteger(slot) || slot < 0) {
      throw new Error(
        `BOOTSTRAP_START_SLOT must be a non-negative integer, got ${JSON.stringify(slotRaw)}`,
      );
    }
    if (!/^[0-9a-f]{64}$/.test(hashRaw)) {
      throw new Error(
        `BOOTSTRAP_START_BLOCKHASH must be 64-char lowercase hex, got ${JSON.stringify(hashRaw)}`,
      );
    }
    return { slot, blockHash: hashRaw };
  }
  return addresses.bootstrapStartPoint ?? null;
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
  if (parsed.bootstrapStartPoint !== undefined) {
    const sp = parsed.bootstrapStartPoint;
    if (
      typeof sp !== "object" ||
      sp === null ||
      typeof sp.slot !== "number" ||
      sp.slot < 0 ||
      typeof sp.blockHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(sp.blockHash)
    ) {
      errs.push(
        `bootstrapStartPoint must be { slot:number, blockHash:64-hex } (got ${JSON.stringify(sp)})`,
      );
    }
  }
  if (errs.length > 0) {
    throw new Error(`addresses.json (${source}) is malformed:\n  - ${errs.join("\n  - ")}`);
  }
  return parsed as LovejoinAddresses;
}

function parseNetwork(s: string): "preprod" | "mainnet" | "preview" {
  const v = s.trim().toLowerCase();
  if (v === "preprod" || v === "mainnet" || v === "preview") return v;
  throw new Error(`NETWORK must be preprod / mainnet / preview, got ${s}`);
}

function parseIntegerEnv(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseCorsOrigins(raw: string | undefined): string[] | "*" {
  // Closed by default. Same-origin works without CORS — only set
  // CORS_ORIGINS when the UI lives on a different origin from the API
  // (e.g. lovejo.in fetching api.lovejo.in). Operators can opt into
  // reflect-any-origin by setting CORS_ORIGINS=* explicitly; that's
  // useful for staging / local dev only (security review v1, finding
  // M2 — eliminates the "I forgot to set CORS_ORIGINS in prod" trap
  // where the previous default reflected any caller).
  if (!raw || raw.trim() === "") return [];
  if (raw.trim() === "*") return "*";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function defaultAddressesPath(network: string): string {
  return `./artifacts/${network}/addresses.json`;
}
