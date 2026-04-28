// Encrypted IndexedDB storage for the tier-2 BIP-39 fallback seed.
//
// Spec: docs/spec/06-ui.md M6.5 — "Tier-2 fallback (advanced disclosure):
// for hardware wallets that don't expose signData and for users who want
// a Lovejoin identity independent of any specific wallet, an opt-in
// BIP-39 mnemonic flow ... encrypted in IndexedDB under an Argon2id-
// derived key from a passphrase."
//
// The schema is intentionally narrow: ONE encrypted blob holding the
// 32-byte BIP-39 entropy, plus the meta record that holds the Argon2id
// parameters + a verifier ciphertext. We do NOT store per-box owner
// secrets here any more — the M6.5 vault derives them deterministically
// from a master seed (wallet-derived in the default flow, BIP-39-derived
// in the fallback flow), and the live pool scan is the authoritative
// answer to "which boxes do I own".
//
//   * `meta`    → { kdfParams, kdfSaltHex, vaultVerifyHex }  (key="meta")
//   * `seeds`   → { ciphertextHex, ivHex }                    (key="entropy")
//
// Threat model (docs/spec/08-threat-model.md): the browser is trusted in
// memory but at-rest disk must require the user's passphrase to decrypt.
// AES-GCM-256 over an Argon2id-derived key matches the rest of the
// industry (Lace, Eternl, Nami) and is computed entirely with hash-wasm
// + Web Crypto subtle so the module loads in the unit-test harness with
// `fake-indexeddb`.

import { argon2id } from "hash-wasm";
import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "lovejoin/vault/v1";
const DB_VERSION = 1;
const META_STORE = "meta";
const SEEDS_STORE = "seeds";
const META_KEY = "meta";
const ENTROPY_KEY = "entropy";
const VAULT_VERIFIER = "lovejoin/vault/v1";

// Argon2id parameters — OWASP "interactive login" recommendation for a
// 256-bit output: iterations=3, 64 MiB memory, single lane. Roughly
// 250 ms per derivation on a 2025-era laptop.
const KDF_DEFAULT = {
  iterations: 3,
  memorySize: 64 * 1024,
  parallelism: 1,
  hashLength: 32,
} as const;

export interface KdfParams {
  iterations: number;
  memorySize: number;
  parallelism: number;
  hashLength: number;
}

export interface VaultMeta {
  kdfParams: KdfParams;
  kdfSaltHex: string;
  vaultVerifyHex: string;
}

interface EncryptedBlob {
  ciphertextHex: string;
  ivHex: string;
}

/**
 * Handle to a successfully unlocked entropy vault. The AES-GCM key is held
 * in memory only — never re-exported. Drop the handle on lock-out (vault
 * lock / inactivity timer / tab close).
 */
export class UnlockedEntropyVault {
  constructor(
    private readonly db: IDBPDatabase,
    private readonly key: CryptoKey,
  ) {}

  /**
   * Read the stored 32-byte BIP-39 entropy as a hex string. Returns null
   * if the vault has been unlocked but the user hasn't yet stored a
   * recovery phrase (e.g. the "create vault → entered passphrase →
   * paused" intermediate state).
   */
  async getEntropyHex(): Promise<string | null> {
    const blob = (await this.db.get(SEEDS_STORE, ENTROPY_KEY)) as
      | EncryptedBlob
      | undefined;
    if (!blob) return null;
    return await this.decrypt(blob);
  }

  /**
   * Write the entropy hex. Overwrites any previous value. Caller is
   * responsible for validating the hex (32 bytes for BIP-39 24-word).
   */
  async putEntropyHex(entropyHex: string): Promise<void> {
    if (!/^[0-9a-fA-F]+$/.test(entropyHex) || entropyHex.length !== 64) {
      throw new Error(
        `entropy: expected 32-byte (64-hex-char) BIP-39 entropy, got ${entropyHex.length} chars`,
      );
    }
    const blob = await this.encrypt(entropyHex.toLowerCase());
    await this.db.put(SEEDS_STORE, blob, ENTROPY_KEY);
  }

  /**
   * Re-key the entropy onto a new passphrase. Implemented as
   * decrypt-then-re-encrypt so the new vault is independent of the old
   * key — a stolen pre-rotation backup remains decryptable with the old
   * passphrase but the live vault no longer is.
   */
  async rotatePassphrase(newPassphrase: string): Promise<UnlockedEntropyVault> {
    const entropy = await this.getEntropyHex();
    const fresh = await EntropyVault.create(this.db, newPassphrase);
    if (entropy) await fresh.putEntropyHex(entropy);
    return fresh;
  }

  private async encrypt(plaintext: string): Promise<EncryptedBlob> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: bs(iv) },
        this.key,
        bs(new TextEncoder().encode(plaintext)),
      ),
    );
    return { ciphertextHex: bytesToHex(cipher), ivHex: bytesToHex(iv) };
  }

  private async decrypt(blob: EncryptedBlob): Promise<string> {
    const cipher = hexToBytes(blob.ciphertextHex);
    const iv = hexToBytes(blob.ivHex);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bs(iv) },
        this.key,
        bs(cipher),
      ),
    );
    return new TextDecoder().decode(plain);
  }
}

/**
 * Static facade for opening / creating / destroying the entropy vault.
 *
 *   * `EntropyVault.exists()`      — has the meta record been written?
 *   * `EntropyVault.unlock(pp)`    — verify the passphrase + return a handle.
 *                                    First-ever call auto-creates the meta.
 *   * `EntropyVault.destroy()`     — wipe meta + entropy. Used by the
 *                                    "reset recovery phrase" flow.
 */
export const EntropyVault = {
  async exists(): Promise<boolean> {
    const db = await getDb();
    const meta = (await db.get(META_STORE, META_KEY)) as VaultMeta | undefined;
    return meta !== undefined;
  },

  async unlock(passphrase: string): Promise<UnlockedEntropyVault> {
    if (!passphrase) throw new Error("vault: passphrase must be non-empty");
    const db = await getDb();
    const existing = (await db.get(META_STORE, META_KEY)) as VaultMeta | undefined;
    if (!existing) {
      return EntropyVault.create(db, passphrase);
    }
    const key = await deriveKey(passphrase, existing.kdfParams, hexToBytes(existing.kdfSaltHex));
    try {
      const verifier = await decryptVerifier(key, existing.vaultVerifyHex);
      if (verifier !== VAULT_VERIFIER) {
        throw new Error("vault: passphrase incorrect");
      }
    } catch (e) {
      // AES-GCM authentication failure surfaces as an OperationError. We
      // collapse both possibilities into the same message so we don't
      // leak any information about which step failed.
      if ((e as Error).message.startsWith("vault:")) throw e;
      throw new Error("vault: passphrase incorrect");
    }
    return new UnlockedEntropyVault(db, key);
  },

  async create(db: IDBPDatabase, passphrase: string): Promise<UnlockedEntropyVault> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(passphrase, KDF_DEFAULT, salt);
    const verifier = await encryptVerifier(key);
    const meta: VaultMeta = {
      kdfParams: KDF_DEFAULT,
      kdfSaltHex: bytesToHex(salt),
      vaultVerifyHex: verifier,
    };
    await db.put(META_STORE, meta, META_KEY);
    return new UnlockedEntropyVault(db, key);
  },

  /**
   * Wipe the entire vault. Used by the "reset recovery phrase" flow —
   * the user explicitly accepts losing the encrypted entropy in
   * exchange for starting over. Funds remain on chain; the original 24
   * words can still restore the vault from a paper backup.
   */
  async destroy(): Promise<void> {
    const db = await getDb();
    await db.clear(META_STORE);
    await db.clear(SEEDS_STORE);
  },
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE);
        }
        if (!db.objectStoreNames.contains(SEEDS_STORE)) {
          db.createObjectStore(SEEDS_STORE);
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Test-only: drop the cached DB handle so a `vi.resetModules()` style
 * test can re-init against a fresh `fake-indexeddb`. Production code
 * never calls this — the singleton is fine for the lifetime of a real
 * browser tab.
 */
export function __resetForTests(): void {
  dbPromise = null;
}

async function deriveKey(
  passphrase: string,
  params: KdfParams,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const raw = (await argon2id({
    password: passphrase,
    salt,
    iterations: params.iterations,
    memorySize: params.memorySize,
    parallelism: params.parallelism,
    hashLength: params.hashLength,
    outputType: "binary",
  })) as Uint8Array;
  // Copy out of any wasm-backed buffer into a plain Uint8Array — the
  // hash-wasm runtime can recycle its internal buffer after returning.
  return crypto.subtle.importKey(
    "raw",
    bs(Uint8Array.from(raw)),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptVerifier(key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bs(iv) },
      key,
      bs(new TextEncoder().encode(VAULT_VERIFIER)),
    ),
  );
  // We pack iv|cipher into one hex blob so meta stays a single field.
  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv, 0);
  packed.set(cipher, iv.length);
  return bytesToHex(packed);
}

async function decryptVerifier(key: CryptoKey, packedHex: string): Promise<string> {
  const packed = hexToBytes(packedHex);
  const iv = packed.slice(0, 12);
  const cipher = packed.slice(12);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bs(iv) },
      key,
      bs(cipher),
    ),
  );
  return new TextDecoder().decode(plain);
}

/**
 * Cast a Uint8Array to `BufferSource` for the WebCrypto subtle calls.
 * TS 5.7's lib.dom.d.ts narrowed `BufferSource` to require an underlying
 * `ArrayBuffer`; runtime accepts TypedArrays in BufferSource positions.
 */
function bs(b: Uint8Array): BufferSource {
  return b as unknown as BufferSource;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/^0x/i, "");
  if (cleaned.length % 2 !== 0) throw new Error("hex must have even length");
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
