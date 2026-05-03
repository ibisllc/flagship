/**
 * Phone-state backup: an opaque, SWK-encrypted blob the phone pushes to its
 * own Flagship server periodically. After phone loss + UMK recovery, the
 * fresh phone fetches and decrypts. The daemon never sees plaintext — that's
 * intentional, the same property as peer-backup shards but for phone state.
 *
 * The blob contains: paired-desktop list, registered servers, app
 * memberships, etc. — anything the phone wants to survive a wipe.
 */

export interface PhoneStateBlob {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  /** Phone-supplied monotonic version (e.g. unix ms) for last-write-wins. */
  version: number;
  /** When the daemon stored this blob. */
  storedAt: number;
}

const MAX_BLOB_BYTES = 256 * 1024;

export interface PhoneStateStore {
  put(blob: PhoneStateBlob): { ok: true } | { ok: false; reason: string };
  get(): PhoneStateBlob | undefined;
  size(): number;
}

export class InMemoryPhoneStateStore implements PhoneStateStore {
  private current?: PhoneStateBlob;

  put(blob: PhoneStateBlob): { ok: true } | { ok: false; reason: string } {
    if (blob.ciphertext.length === 0) return { ok: false, reason: "ciphertext is empty" };
    if (blob.ciphertext.length > MAX_BLOB_BYTES) {
      return { ok: false, reason: `ciphertext exceeds ${MAX_BLOB_BYTES} bytes` };
    }
    if (blob.nonce.length !== 12) return { ok: false, reason: "nonce must be 12 bytes" };
    if (this.current && blob.version <= this.current.version) {
      return { ok: false, reason: "version is not monotonic" };
    }
    this.current = {
      ciphertext: blob.ciphertext.slice(),
      nonce: blob.nonce.slice(),
      version: blob.version,
      storedAt: blob.storedAt,
    };
    return { ok: true };
  }

  get(): PhoneStateBlob | undefined {
    if (!this.current) return undefined;
    return {
      ciphertext: this.current.ciphertext.slice(),
      nonce: this.current.nonce.slice(),
      version: this.current.version,
      storedAt: this.current.storedAt,
    };
  }

  size(): number {
    return this.current ? this.current.ciphertext.length : 0;
  }
}

export const PHONE_STATE_MAX_BYTES = MAX_BLOB_BYTES;
