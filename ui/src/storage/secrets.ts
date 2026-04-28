// Encrypted IndexedDB storage for box owner secrets.
//
// Spec: docs/spec/06-ui.md §"Key storage" — "Encrypted IndexedDB with
// Argon2id-derived key from a user passphrase. Same pattern as Lace, Eternl,
// Nami. Optional plaintext export/import."
//
// Threat model (docs/spec/08-threat-model.md): the browser is trusted, but
// disk-at-rest must require the user's passphrase to decrypt. The vault
// schema is intentionally tiny:
//   * `meta`   → { kdfParams, kdfSaltHex, vaultVerifyHex }  (one row, key="meta")
//   * `boxes`  → keyed by `<txId>#<outputIndex>`, value { ciphertext, iv }
//
// `vaultVerifyHex` is `AES-GCM(key, "lovejoin/vault/v1")`. On unlock we
// re-derive the key from the passphrase and try to decrypt the verifier; if
// it fails the passphrase is wrong and we surface a clean error rather than
// returning gibberish for every box. This mirrors how cardano-wallet-js / Lace
// detect bad passphrases without storing the passphrase itself.
//
// All cryptography uses the Web Crypto subtle API (AES-GCM-256) plus
// `hash-wasm`'s pure-WASM Argon2id. We never touch a Node-only crypto API,
// so the module loads in the test harness too (with `fake-indexeddb`).

import { argon2id } from "hash-wasm";
import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "lovejoin/vault/v1";
const DB_VERSION = 1;
const META_STORE = "meta";
const BOXES_STORE = "boxes";
const META_KEY = "meta";
const VAULT_VERIFIER = "lovejoin/vault/v1";

// Argon2id parameters chosen for an interactive-login UX on a 2025-era laptop:
// ~250 ms per derivation. Iterations=3 + 64 MiB memory + 1 lane is the OWASP
// "interactive login" recommendation for Argon2id with a 256-bit output.
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

export interface StoredBox {
  txId: string;
  outputIndex: number;
  ownerSecretHex: string;
  aHex: string;
  bHex: string;
  label: string;
  rounds: number;
  createdAt: number;
}

/**
 * Handle to a successfully unlocked vault. The AES-GCM key is held in
 * memory only — never persisted, never re-exported. Drop the handle on
 * lock-out (e.g. inactivity timeout).
 */
export class UnlockedVault {
  constructor(
    private readonly db: IDBPDatabase,
    private readonly key: CryptoKey,
  ) {}

  async listBoxes(): Promise<StoredBox[]> {
    const tx = this.db.transaction(BOXES_STORE, "readonly");
    const all = (await tx.store.getAll()) as EncryptedBlob[];
    const out: StoredBox[] = [];
    for (const blob of all) {
      const decrypted = await this.decrypt(blob);
      out.push(JSON.parse(decrypted) as StoredBox);
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  }

  async getBox(txId: string, outputIndex: number): Promise<StoredBox | null> {
    const blob = (await this.db.get(BOXES_STORE, boxKey(txId, outputIndex))) as
      | EncryptedBlob
      | undefined;
    if (!blob) return null;
    return JSON.parse(await this.decrypt(blob)) as StoredBox;
  }

  async putBox(box: StoredBox): Promise<void> {
    const blob = await this.encrypt(JSON.stringify(box));
    await this.db.put(BOXES_STORE, blob, boxKey(box.txId, box.outputIndex));
  }

  async deleteBox(txId: string, outputIndex: number): Promise<void> {
    await this.db.delete(BOXES_STORE, boxKey(txId, outputIndex));
  }

  /**
   * Re-key all stored boxes onto a new passphrase. Implemented as
   * decrypt-then-re-encrypt so the new vault's blobs are independent of the
   * old key — a stolen pre-rotation backup remains decryptable with the old
   * passphrase but the live vault no longer is.
   */
  async rotatePassphrase(newPassphrase: string): Promise<UnlockedVault> {
    const boxes = await this.listBoxes();
    const fresh = await Vault.create(this.db, newPassphrase);
    for (const b of boxes) await fresh.putBox(b);
    return fresh;
  }

  /**
   * Plaintext export. The spec calls this out as opt-in — the call site
   * is responsible for warning the user that the resulting JSON is
   * sensitive (every box's owner secret is in the clear).
   */
  async exportPlaintext(): Promise<StoredBox[]> {
    return this.listBoxes();
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
 * Static facade for opening the vault. Two flows:
 *   * `Vault.unlock(passphrase)` — prove the passphrase is correct + return
 *     the handle. First call ever auto-creates the vault meta with a fresh
 *     salt, so "first unlock" and "subsequent unlock" look the same to the
 *     caller.
 *   * `Vault.exists()` — has the vault meta been written? Lets the caller
 *     decide whether to render a "create passphrase" or "enter passphrase"
 *     UI.
 */
export const Vault = {
  async exists(): Promise<boolean> {
    const db = await getDb();
    const meta = (await db.get(META_STORE, META_KEY)) as VaultMeta | undefined;
    return meta !== undefined;
  },

  async unlock(passphrase: string): Promise<UnlockedVault> {
    if (!passphrase) throw new Error("vault: passphrase must be non-empty");
    const db = await getDb();
    const existing = (await db.get(META_STORE, META_KEY)) as VaultMeta | undefined;
    if (!existing) {
      return Vault.create(db, passphrase);
    }
    const key = await deriveKey(passphrase, existing.kdfParams, hexToBytes(existing.kdfSaltHex));
    try {
      const verifier = await decryptVerifier(key, existing.vaultVerifyHex);
      if (verifier !== VAULT_VERIFIER) {
        throw new Error("vault: passphrase incorrect");
      }
    } catch (e) {
      // AES-GCM authentication failure surfaces as an OperationError. We
      // collapse both possibilities into the same message so we don't leak
      // any information about which step failed.
      if ((e as Error).message.startsWith("vault:")) throw e;
      throw new Error("vault: passphrase incorrect");
    }
    return new UnlockedVault(db, key);
  },

  /**
   * Internal: write fresh meta + return an unlocked handle. Exposed
   * publicly because UnlockedVault.rotatePassphrase needs to call it; not
   * meant for direct UI use.
   */
  async create(db: IDBPDatabase, passphrase: string): Promise<UnlockedVault> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(passphrase, KDF_DEFAULT, salt);
    const verifier = await encryptVerifier(key);
    const meta: VaultMeta = {
      kdfParams: KDF_DEFAULT,
      kdfSaltHex: bytesToHex(salt),
      vaultVerifyHex: verifier,
    };
    await db.put(META_STORE, meta, META_KEY);
    return new UnlockedVault(db, key);
  },

  /**
   * Wipe the entire vault. Used by the "forget passphrase" recovery — the
   * user explicitly accepts losing every stored secret in exchange for
   * starting over. We purge both stores rather than just the meta so a
   * later attacker can't even decrypt offline.
   */
  async destroy(): Promise<void> {
    const db = await getDb();
    await db.clear(META_STORE);
    await db.clear(BOXES_STORE);
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
        if (!db.objectStoreNames.contains(BOXES_STORE)) {
          db.createObjectStore(BOXES_STORE);
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Test-only: drop the cached DB handle so a `vi.resetModules()` style test
 * can re-init against a fresh `fake-indexeddb`. Production code never calls
 * this — the singleton is fine for the lifetime of a real browser tab.
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
 *
 * TypeScript 5.7's lib.dom.d.ts narrowed `BufferSource` to require the
 * underlying buffer to be an `ArrayBuffer` (not `SharedArrayBuffer`); we
 * only ever build TypedArrays here (Uint8Array of plain ArrayBuffer),
 * which the runtime accepts but the typechecker rejects. The cast is a
 * one-line bypass — at runtime Node + browsers accept TypedArrays in
 * BufferSource positions for the AES-GCM / importKey APIs we use.
 */
function bs(b: Uint8Array): BufferSource {
  return b as unknown as BufferSource;
}

function boxKey(txId: string, outputIndex: number): string {
  return `${txId.toLowerCase()}#${outputIndex}`;
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
