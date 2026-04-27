// M0 placeholder. Real ogmios chainsync indexer + Fastify routes land in M5.
// See docs/spec/05-backend.md.

export const BACKEND_VERSION = "0.0.0";

export type LovejoinBackendConfig = {
  ogmiosUrl: string;
  dbsyncUrl: string | null;
  network: "preprod" | "mainnet";
  port: number;
};
