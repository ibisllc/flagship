/**
 * Storage-adapter interface — exactly the shape described in §6 of the
 * spec.
 *
 * The verifier algorithm doesn't care which adapter is behind it: a
 * public git-based adapter (used by adopting projects) and an
 * encrypted-blob adapter (used by the Flagship user-identity store)
 * implement the same surface and produce equivalent envelope streams.
 *
 * Adapters are NOT included in this package — they live alongside the
 * relevant deployment surface (e.g., `maintainers-adapter-github`,
 * `flagship-user-identity-store`). This interface is the contract.
 */

import type { Envelope } from "./types.js";

export interface StoredEntry {
  path: string;
  modifiedAt: string;
  sha: string;
}

export interface StorageReadResult {
  bytes: Uint8Array;
  modifiedAt?: string;
  sha?: string;
}

export interface StorageWriteResult {
  ok: true;
  sha: string;
  modifiedAt: string;
}

export interface StorageConflict {
  ok: false;
  reason: "conflict" | "forbidden" | "not-found" | "verification-failed";
  detail?: string;
}

export interface StorageAdapter {
  /** Read raw bytes at a path. */
  read(path: string): Promise<StorageReadResult>;
  /**
   * Write raw bytes at a path, accompanied by the parsed envelope (so the
   * adapter can enforce per-envelope policy if it chooses to). Returns
   * conflict on optimistic-locking failure.
   */
  write(
    path: string,
    bytes: Uint8Array,
    envelope: Envelope,
  ): Promise<StorageWriteResult | StorageConflict>;
  /** List paths under a prefix in canonical-log order. */
  list(prefix: string): Promise<StoredEntry[]>;
  /** Return the canonical ordering of all envelope-bearing entries. */
  log(): Promise<StoredEntry[]>;
}

/**
 * In-memory adapter for tests. Maintains insertion order as the
 * canonical log; no real anti-equivocation but predictable for
 * deterministic verifier tests.
 */
export class InMemoryStorageAdapter implements StorageAdapter {
  private readonly entries = new Map<string, { bytes: Uint8Array; insertedAt: number }>();
  private counter = 0;

  async read(path: string): Promise<StorageReadResult> {
    const entry = this.entries.get(path);
    if (!entry) throw new Error(`InMemoryStorageAdapter: no entry at ${path}`);
    return {
      bytes: entry.bytes,
      modifiedAt: new Date(entry.insertedAt).toISOString(),
      sha: String(entry.insertedAt),
    };
  }

  async write(
    path: string,
    bytes: Uint8Array,
  ): Promise<StorageWriteResult | StorageConflict> {
    this.counter++;
    this.entries.set(path, { bytes, insertedAt: this.counter });
    return {
      ok: true,
      sha: String(this.counter),
      modifiedAt: new Date(this.counter).toISOString(),
    };
  }

  async list(prefix: string): Promise<StoredEntry[]> {
    const out: StoredEntry[] = [];
    for (const [path, entry] of this.entries) {
      if (path.startsWith(prefix)) {
        out.push({
          path,
          modifiedAt: new Date(entry.insertedAt).toISOString(),
          sha: String(entry.insertedAt),
        });
      }
    }
    out.sort((a, b) => Number(a.sha) - Number(b.sha));
    return out;
  }

  async log(): Promise<StoredEntry[]> {
    return this.list("");
  }
}
