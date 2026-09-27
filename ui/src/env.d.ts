/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NETWORK?: string;
  readonly VITE_BACKEND_URL?: string;
  readonly VITE_BLOCKFROST_PROJECT_ID?: string;
  readonly VITE_COLLATERAL_ENDPOINT?: string;
  // Seedelf protocol coordinates (issue #135). Operators running their own
  // Seedelf deployment override the SDK's canonical defaults via these.
  // Reference UTxO refs use the "<txid>#<idx>" format.
  readonly VITE_SEEDELF_WALLET_SCRIPT_HASH?: string;
  readonly VITE_SEEDELF_POLICY_ID?: string;
  readonly VITE_SEEDELF_WALLET_REFERENCE_UTXO?: string;
  readonly VITE_SEEDELF_REFERENCE_UTXO?: string;
  readonly VITE_SEEDELF_WALLET_REFERENCE_SCRIPT_SIZE?: string;
  readonly VITE_SEEDELF_REFERENCE_SCRIPT_SIZE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
