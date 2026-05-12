/**
 * Encrypted-blob storage adapter for the maintainers protocol.
 *
 * The maintainers protocol normally rides on top of a public, append-only
 * substrate (a git folder). This adapter exposes the same `StorageAdapter`
 * surface but keeps every byte inside a single opaque AES-256-GCM blob:
 * the entire "folder" is decrypted into memory on demand and re-encrypted
 * on every write.
 *
 * Why this exists: Flagship reuses the maintainers envelope/mandate stack
 * as the substrate for per-user identity state on flagshipserver.com.
 * Project maintainership is *public* — that asymmetry is documented in
 * `docs/policy/no-kyc.md`. Per-user state is *not*: the storage layer
 * must never expose label, device-list, friend-graph or any other field
 * to `.com`. Everything inside the blob therefore stays ciphertext at rest
 * on the control plane, and only the user's UMK-derived 32-byte key can
 * unseal it.
 *
 * Blob layout (binary, MSB-first):
 *
 *     ┌─────────────────────────────┬───────────────────────────────┐
 *     │  nonce (12 bytes, random)   │  AES-GCM ciphertext + tag     │
 *     └─────────────────────────────┴───────────────────────────────┘
 *
 * The plaintext under the tag is a JSON document:
 *
 *     { entries: [{ path, bytes_b64, insertedAt }, ...] }
 *
 * The `insertedAt` field is a monotonic per-blob counter — it gives us a
 * synthetic canonical ordering for `log()` without needing a clock the
 * server side could ever observe.
 *
 * The 12-byte nonce is freshly random on every write (WebCrypto's
 * `getRandomValues`). Reusing a (key, nonce) pair under AES-GCM destroys
 * confidentiality, so every rewrite of the same key MUST generate a new
 * nonce; that's enforced by allocating one inside `flush()`.
 */

import type {
  StorageAdapter,
  StorageConflict,
  StorageReadResult,
  StorageWriteResult,
  StoredEntry,
} from "./storage.js";
import type { Envelope } from "./types.js";

/**
 * Minimal local Web Crypto typing.
 *
 * The maintainers protocol package targets `lib: ["ES2022"]` only — it
 * deliberately stays free of DOM/Node libs so the same source builds for
 * Cloudflare Workers, Node 20+, and a browser bundle. The browser-level
 * `crypto.subtle` typings would normally come from `lib.dom.d.ts`; we
 * inline just enough of them here to stay self-contained.
 */
interface SubtleCryptoLike {
  importKey(
    format: "raw",
    keyData: Uint8Array,
    algorithm: { name: "AES-GCM" },
    extractable: boolean,
    keyUsages: ReadonlyArray<"encrypt" | "decrypt">,
  ): Promise<AesGcmKey>;
  encrypt(
    algorithm: { name: "AES-GCM"; iv: Uint8Array },
    key: AesGcmKey,
    data: Uint8Array,
  ): Promise<ArrayBuffer>;
  decrypt(
    algorithm: { name: "AES-GCM"; iv: Uint8Array },
    key: AesGcmKey,
    data: Uint8Array,
  ): Promise<ArrayBuffer>;
}
interface CryptoLike {
  readonly subtle: SubtleCryptoLike;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}
type AesGcmKey = { readonly __aesGcmBrand: unique symbol };
declare const crypto: CryptoLike;

export interface EncryptedBlobAdapterOptions {
  /**
   * Fetch the current ciphertext blob, or null if no blob exists yet
   * (fresh user). Implementations route this to whatever transport they
   * use — for Flagship that's a GET against
   * `flagshipserver.com/api/user-identity/<usernameHash>`.
   */
  fetchBlob: () => Promise<Uint8Array | null>;
  /**
   * Persist a new ciphertext blob, overwriting the previous one. The
   * adapter never persists plaintext; this function only ever sees the
   * 12-byte-nonce-prefixed AES-GCM output produced by `flush()`.
   */
  storeBlob: (bytes: Uint8Array) => Promise<void>;
  /**
   * Produce the 32-byte AES-256-GCM key. Called lazily — once when the
   * adapter first decrypts (or first writes) and then cached.
   * Implementations derive this from the user's UMK via HKDF; the key
   * never leaves the caller's process.
   */
  deriveKey: () => Promise<Uint8Array>;
}

interface BlobEntry {
  path: string;
  bytes_b64: string;
  insertedAt: number;
}

interface BlobPlaintext {
  entries: BlobEntry[];
}

const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const COUNTER_FLOOR = 0;

export class EncryptedBlobAdapter implements StorageAdapter {
  private readonly opts: EncryptedBlobAdapterOptions;
  private loaded = false;
  private entries = new Map<string, BlobEntry>();
  private counter = COUNTER_FLOOR;
  private cachedKey: AesGcmKey | null = null;

  constructor(opts: EncryptedBlobAdapterOptions) {
    this.opts = opts;
  }

  async read(path: string): Promise<StorageReadResult> {
    await this.ensureLoaded();
    const entry = this.entries.get(path);
    if (!entry) throw new Error(`EncryptedBlobAdapter: no entry at ${path}`);
    return {
      bytes: base64Decode(entry.bytes_b64),
      modifiedAt: new Date(entry.insertedAt).toISOString(),
      sha: String(entry.insertedAt),
    };
  }

  async write(
    path: string,
    bytes: Uint8Array,
    _envelope: Envelope,
  ): Promise<StorageWriteResult | StorageConflict> {
    void _envelope;
    await this.ensureLoaded();
    this.counter += 1;
    const entry: BlobEntry = {
      path,
      bytes_b64: base64Encode(bytes),
      insertedAt: this.counter,
    };
    this.entries.set(path, entry);
    await this.flush();
    return {
      ok: true,
      sha: String(entry.insertedAt),
      modifiedAt: new Date(entry.insertedAt).toISOString(),
    };
  }

  async list(prefix: string): Promise<StoredEntry[]> {
    await this.ensureLoaded();
    const out: StoredEntry[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.path.startsWith(prefix)) continue;
      out.push({
        path: entry.path,
        modifiedAt: new Date(entry.insertedAt).toISOString(),
        sha: String(entry.insertedAt),
      });
    }
    out.sort((a, b) => Number(a.sha) - Number(b.sha));
    return out;
  }

  async log(): Promise<StoredEntry[]> {
    return this.list("");
  }

  /** Drop the in-memory cache; subsequent ops will refetch + redecrypt. */
  reset(): void {
    this.loaded = false;
    this.entries.clear();
    this.counter = COUNTER_FLOOR;
    this.cachedKey = null;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const blob = await this.opts.fetchBlob();
    if (!blob) {
      this.loaded = true;
      return;
    }
    const key = await this.getKey();
    const plain = await decryptBlob(blob, key);
    for (const entry of plain.entries) {
      this.entries.set(entry.path, entry);
      if (entry.insertedAt > this.counter) this.counter = entry.insertedAt;
    }
    this.loaded = true;
  }

  private async flush(): Promise<void> {
    const key = await this.getKey();
    const plain: BlobPlaintext = { entries: [...this.entries.values()] };
    const blob = await encryptBlob(plain, key);
    await this.opts.storeBlob(blob);
  }

  private async getKey(): Promise<AesGcmKey> {
    if (this.cachedKey) return this.cachedKey;
    const raw = await this.opts.deriveKey();
    if (raw.length !== KEY_BYTES) {
      throw new Error(`deriveKey() must return ${KEY_BYTES} bytes, got ${raw.length}`);
    }
    this.cachedKey = await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
    return this.cachedKey;
  }
}

async function encryptBlob(plain: BlobPlaintext, key: AesGcmKey): Promise<Uint8Array> {
  const json = new TextEncoder().encode(JSON.stringify(plain));
  const nonce = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(nonce);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, json),
  );
  const out = new Uint8Array(NONCE_BYTES + ct.length);
  out.set(nonce, 0);
  out.set(ct, NONCE_BYTES);
  return out;
}

async function decryptBlob(blob: Uint8Array, key: AesGcmKey): Promise<BlobPlaintext> {
  if (blob.length < NONCE_BYTES + 16) {
    throw new Error("EncryptedBlobAdapter: blob shorter than nonce+tag");
  }
  const nonce = blob.slice(0, NONCE_BYTES);
  const ct = blob.slice(NONCE_BYTES);
  const pt = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct),
  );
  const parsed = JSON.parse(new TextDecoder().decode(pt)) as BlobPlaintext;
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error("EncryptedBlobAdapter: malformed plaintext");
  }
  return parsed;
}

declare function btoa(s: string): string;
declare function atob(s: string): string;

function base64Encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function base64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
