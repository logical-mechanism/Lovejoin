/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NETWORK?: string;
  readonly VITE_BACKEND_URL?: string;
  readonly VITE_BLOCKFROST_PROJECT_ID?: string;
  readonly VITE_COLLATERAL_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
