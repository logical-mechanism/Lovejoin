// SDK bridge — wires @lovejoin/sdk into the React app.
//
// Spec: + M6.5 (06-ui.md "config" deliverable).
//
// Two-layer config model:
//   1. Build-time defaults baked from Vite env vars (VITE_NETWORK,
//      VITE_BACKEND_URL, VITE_BLOCKFROST_PROJECT_ID, VITE_COLLATERAL_ENDPOINT).
//      These ship in the static bundle and let the production UI run with
//      zero user input.
//   2. Per-browser overrides written to localStorage by the dev-only
//      ?advanced=1 panel. Overrides win when present but are never required.
//
// The production UI never surfaces a config form — every screen reads
// `useAppState().config` and just works.

import {
  BackendChainProvider,
  BlockfrostProvider,
  getKnownCollateralHost,
  lovejoinNetworkToCollateralNetwork,
  type ChainProvider,
  type LovejoinAddresses,
} from "@lovejoin/sdk";

export const NETWORKS = ["preprod", "preview", "mainnet"] as const;
export type Network = (typeof NETWORKS)[number];

const STORAGE_KEY = "lovejoin.config.v1";

/**
 * Returns the SDK's canonical clearnet collateral URL for `network`, or
 * "" if the upstream doesn't index that network ("preview" today). The
 * URL is the source of truth shared with the SDK's `GivemeMyProvider`
 * default — keeping them in sync prevents the "probe says unknown but
 * signing works" mismatch that bit the alpha deploy.
 */
function defaultCollateralEndpoint(network: Network): string {
  const cn = lovejoinNetworkToCollateralNetwork(network);
  if (!cn) return "";
  const host = getKnownCollateralHost(cn);
  return host?.perNetwork[cn]?.url ?? "";
}

// Default backend URL — points at the dev-mode `make backend-dev` target
// (Fastify on :3001) so `pnpm dev` + `make backend-dev` "just works"
// out of the box. Production deploys override via VITE_BACKEND_URL at
// build time. Set VITE_BACKEND_URL="" explicitly to disable.
const DEFAULT_BACKEND_URL = "http://localhost:3001";

export interface RuntimeConfig {
  network: Network;
  blockfrostProjectId: string;
  backendUrl: string;
  collateralProviderEndpoint: string;
}

function envNetwork(): Network {
  const v = (import.meta.env.VITE_NETWORK ?? "").trim();
  return NETWORKS.includes(v as Network) ? (v as Network) : "preprod";
}

/**
 * Build-time defaults from Vite env. These are immutable per build — see
 * ui/.env.example. The function is called once at module load to seed
 * `loadConfig`; the result is stable for the lifetime of the tab.
 */
export function envDefaults(): RuntimeConfig {
  // VITE_BACKEND_URL semantics:
  //   - undefined  → fall back to DEFAULT_BACKEND_URL (localhost:3001).
  //   - ""         → caller explicitly disabled the backend; UI uses
  //                  direct Blockfrost queries.
  //   - any value  → use that URL.
  const rawBackend = import.meta.env.VITE_BACKEND_URL;
  const backendUrl = rawBackend === undefined ? DEFAULT_BACKEND_URL : rawBackend.trim();
  const network = envNetwork();
  // VITE_COLLATERAL_ENDPOINT semantics:
  //   - undefined / ""  → use the SDK's pinned host for this network
  //                       (matches what GivemeMyProvider does internally,
  //                       so the reachability probe and the signing
  //                       path don't diverge).
  //   - any value       → operator override (advanced mode, .onion, dev
  //                       instance, etc.).
  const rawCollateral = (import.meta.env.VITE_COLLATERAL_ENDPOINT ?? "").trim();
  return {
    network,
    blockfrostProjectId: (import.meta.env.VITE_BLOCKFROST_PROJECT_ID ?? "").trim(),
    backendUrl,
    collateralProviderEndpoint: rawCollateral || defaultCollateralEndpoint(network),
  };
}

/**
 * True when `?advanced=1` is present in the current URL. We re-read it on
 * each call rather than caching at module load so unit tests can flip it
 * by mutating `location.search`.
 */
export function isAdvancedMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("advanced") === "1";
  } catch {
    return false;
  }
}

/**
 * Read the effective config: env defaults overlaid with the
 * advanced-mode-only localStorage overrides. Without `?advanced=1` the
 * overrides are deliberately ignored — a user who once flipped a setting
 * and shared the URL doesn't permanently mutate other people's UI.
 */
export function loadConfig(): RuntimeConfig {
  const defaults = envDefaults();
  if (typeof window === "undefined") return defaults;
  if (!isAdvancedMode()) return defaults;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<RuntimeConfig>;
    const network = NETWORKS.includes(parsed.network as Network)
      ? (parsed.network as Network)
      : defaults.network;
    return {
      network,
      blockfrostProjectId:
        (parsed.blockfrostProjectId ?? "").trim() || defaults.blockfrostProjectId,
      // For backendUrl: an explicit "" override means the user disabled the
      // backend (UI falls back to direct Blockfrost). Only `undefined` (key
      // absent from the persisted blob) falls back to the env default.
      backendUrl: parsed.backendUrl === undefined ? defaults.backendUrl : parsed.backendUrl.trim(),
      collateralProviderEndpoint:
        (parsed.collateralProviderEndpoint ?? "").trim() || defaults.collateralProviderEndpoint,
    };
  } catch {
    return defaults;
  }
}

/**
 * Persist a config override to localStorage. No-op outside the browser and
 * outside `?advanced=1`. Persisted state is only honored when the
 * advanced flag is set on a future load.
 */
export function saveConfig(cfg: RuntimeConfig): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

export function clearConfigOverrides(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

/**
 * Map a network name to the Blockfrost API base URL. Mirrors the SDK CLI
 * (offchain/src/cli/index.ts) so a project id that works on the CLI works
 * here unchanged.
 */
export function blockfrostBaseUrl(network: Network): string {
  if (network === "mainnet") return "https://cardano-mainnet.blockfrost.io/api/v0";
  if (network === "preview") return "https://cardano-preview.blockfrost.io/api/v0";
  return "https://cardano-preprod.blockfrost.io/api/v0";
}

/**
 * Build a chain provider for the given runtime config.
 *
 * When `backendUrl` is configured, returns a BackendChainProvider that
 * leans on the self-hosted backend (db-sync + ogmios) for chain reads
 * and tx submission, with a Blockfrost provider as the fallback for
 * any single method that throws. When `backendUrl` is empty, returns a
 * plain BlockfrostProvider (Blockfrost-only deployment).
 *
 * Returns null when neither a backend URL nor a Blockfrost project id
 * is configured — the UI surfaces a calm "configuration missing" state
 * rather than a thrown error.
 */
export function makeProvider(cfg: RuntimeConfig): ChainProvider | null {
  const hasBackend = cfg.backendUrl.trim().length > 0;
  const hasBlockfrost = cfg.blockfrostProjectId.trim().length > 0;
  if (!hasBackend && !hasBlockfrost) return null;
  const blockfrost = hasBlockfrost
    ? new BlockfrostProvider({
        baseUrl: blockfrostBaseUrl(cfg.network),
        projectId: cfg.blockfrostProjectId.trim(),
      })
    : null;
  if (!hasBackend) return blockfrost;
  return new BackendChainProvider({
    baseUrl: cfg.backendUrl.trim(),
    fallback: blockfrost,
  });
}

/**
 * Fetch the bootstrap addresses.json for the given network. The file is a
 * static asset under ui/public/addresses.<network>.json copied from
 * artifacts/<network>/addresses.json by the bootstrap operator.
 */
export async function loadAddresses(network: Network): Promise<LovejoinAddresses> {
  const url = `${import.meta.env.BASE_URL}addresses.${network}.json`;
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) {
    throw new Error(
      `addresses.${network}.json not found at ${url} (HTTP ${res.status}). ` +
        `Copy artifacts/${network}/addresses.json into ui/public/.`,
    );
  }
  return (await res.json()) as LovejoinAddresses;
}

/**
 * Mesh's BrowserWallet picker — returns the list of CIP-30 wallets the
 * browser has injected into `window.cardano`.
 *
 * The mesh import is lazy because @meshsdk/core transitively pulls
 * libsodium-wrappers-sumo, which fails to load in some environments
 * (see offchain/src/wallet/cip30.ts for the canonical writeup). The lazy
 * import means the rest of the UI renders even if mesh fails to initialize.
 */
export async function listInstalledWallets(): Promise<
  Array<{ id: string; name: string; icon: string; version: string }>
> {
  const { BrowserWallet } = await import("@meshsdk/core");
  return BrowserWallet.getInstalledWallets();
}

/**
 * Connect to a CIP-30 wallet by its id (e.g. "lace", "eternl", "nami") and
 * return the wallet handle the SDK tx builders accept.
 */
export async function connectWallet(id: string): Promise<import("@meshsdk/core").BrowserWallet> {
  const { BrowserWallet } = await import("@meshsdk/core");
  return BrowserWallet.enable(id);
}
