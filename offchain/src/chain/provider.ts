// Chain-provider abstraction.
//
// Why this exists: M2 ships a Blockfrost-backed provider so the SDK and stress
// tests can submit Mix txs without a local cardano-node. M5 will add a second
// implementation of the same interface backed by ogmios + db-sync (the
// self-hosted indexer). Switching between them is a config-only change for the
// SDK consumer.
//
// Spec: docs/spec/09-milestones.md M2 notes ("Provider abstraction is
// introduced at M2 because the stress-test submitters need it").

/** A 32-byte hash, lowercase hex, no `0x` prefix. */
export type Hex32 = string;

/** A 28-byte hash, lowercase hex, no `0x` prefix. */
export type Hex28 = string;

/** Lovelace amount (Cardano's smallest ADA unit). */
export type Lovelace = bigint;

/** A Cardano UTxO reference: <txid>#<index>. */
export interface UtxoRef {
  txId: Hex32;
  outputIndex: number;
}

/** Map of native asset quantities, keyed by `<policy_id><asset_name_hex>`. */
export type AssetMap = Record<string, bigint>;

/** A UTxO at an address. `dataHex` is the inline datum (CBOR hex) when present. */
export interface Utxo {
  ref: UtxoRef;
  address: string;
  lovelace: Lovelace;
  assets: AssetMap;
  /** CBOR hex of the inline datum; null if the UTxO has NoDatum or DatumHash. */
  inlineDatum: string | null;
  /** CBOR hex of the reference script attached to the UTxO; null if none. */
  referenceScript: string | null;
}

/**
 * Cardano network protocol parameters used by tx builders for fee computation,
 * min-UTxO checks, and script-cost limits. These are the *Cardano* params, not
 * the Lovejoin protocol params (those live on the reference UTxO).
 *
 * We keep the field set minimal and additive — provider implementations are free
 * to attach extra fields. SDK consumers should treat unrecognized fields as
 * informational.
 */
export interface NetworkProtocolParameters {
  /** Linear fee coefficient (lovelace per byte). */
  minFeeA: number;
  /** Linear fee constant. */
  minFeeB: number;
  /** Maximum tx size in bytes. */
  maxTxSize: number;
  /** Min ADA per UTxO byte (Conway: utxoCostPerByte). */
  utxoCostPerByte: bigint;
  /** Per-tx CPU budget. */
  maxTxExSteps: bigint;
  /** Per-tx memory budget. */
  maxTxExMem: bigint;
  /** Plutus script costing prices (CPU + memory). */
  pricesStep: number;
  pricesMem: number;
  /** Cost models, keyed by Plutus version (e.g. "PlutusV3"). */
  costModels: Record<string, number[]>;
  /** Network identifier — "mainnet" / "preprod" / "preview" / etc. */
  network: string;
  /** Slot duration in milliseconds. */
  slotLength: number;
}

/**
 * The provider abstraction. Every method that talks to chain state is async.
 * Implementations are expected to be safe for concurrent use.
 */
export interface ChainProvider {
  /**
   * Submit a fully signed tx (CBOR hex).
   * Returns the resulting txid on success; throws on submission failure.
   */
  submitTx(signedTxCborHex: string): Promise<Hex32>;

  /** UTxOs at a bech32-encoded address. */
  getUtxos(address: string): Promise<Utxo[]>;

  /** Resolve a specific UTxO by its (txid, index) reference. */
  getUtxoByRef(ref: UtxoRef): Promise<Utxo | null>;

  /**
   * Block until the tx with the given id has been confirmed onto the chain, or
   * until `timeoutMs` elapses (in which case the promise rejects). Idempotent:
   * if the tx is already confirmed, resolves immediately.
   */
  awaitConfirmation(txId: Hex32, timeoutMs?: number): Promise<void>;

  /**
   * Find the unique UTxO carrying the protocol's reference NFT. There must be
   * exactly one — if zero are found the protocol hasn't been bootstrapped on
   * this network; if more than one are found something is very wrong (the
   * one_shot_mint policy disallows duplicates).
   */
  getReferenceUtxo(nftPolicy: Hex28, nftAssetNameHex: string): Promise<Utxo>;

  /** Cardano network protocol parameters at the current epoch. */
  getProtocolParameters(): Promise<NetworkProtocolParameters>;
}
