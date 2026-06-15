/**
 * MCP auth keys — one bearer key per `mcp` build session, the secret the
 * user pastes into their IDE (Cursor/Cline) so its agent can reach the
 * box's MCP build server. The key BINDS the connection to exactly one
 * build session: presenting it authorizes that build and nothing else.
 *
 * Minting is gated upstream by the paired-session gate (only the
 * authenticated phone can create a build + mint its key). The key is
 * sealed at rest with the same SWK-derived AEAD `serviceEnvStore` uses,
 * one file per build under the key dir (mode 0600, atomic tmp+rename).
 * An in-memory `sha256(key) → buildId` index is built on `load()` so
 * auth lookups are constant-time-ish and never touch disk; the sealed
 * record additionally holds the plaintext so the app can RE-display the
 * key (the user may need to paste it again).
 */

import { existsSync, readdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openLlmPayload, sealLlmPayload, type Bytes, type SealedBlob } from "@flagship/protocol";

const KEY_PREFIX = "fmcp_";

export interface McpKeyRecord {
  buildId: string;
  /** The full bearer key (prefix + hex). Secret. */
  key: string;
  createdAt: number;
  /** Optional human label for the IDE connection. */
  label?: string;
}

export interface McpKeyStore {
  /** Mint (or replace) the key for a build; returns the full record. */
  mint(buildId: string, label?: string): Promise<McpKeyRecord>;
  /** Resolve a presented bearer key to its build id, or null. */
  resolve(key: string): Promise<string | null>;
  /** The record for a build (incl. the key, for re-display), or null. */
  get(buildId: string): Promise<McpKeyRecord | null>;
  /** Revoke a build's key. Idempotent. */
  revoke(buildId: string): Promise<void>;
  /** Public-safe list (NO key material). */
  list(): Promise<Array<{ buildId: string; createdAt: number; label?: string }>>;
}

function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function generateKey(rand: () => Uint8Array): string {
  let s = "";
  for (const b of rand()) s += b.toString(16).padStart(2, "0");
  return KEY_PREFIX + s;
}

export class InMemoryMcpKeyStore implements McpKeyStore {
  private byBuild = new Map<string, McpKeyRecord>();
  private byHash = new Map<string, string>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly rand: () => Uint8Array = () => randomBytes(24),
  ) {}

  async mint(buildId: string, label?: string): Promise<McpKeyRecord> {
    const prev = this.byBuild.get(buildId);
    if (prev) this.byHash.delete(hashKey(prev.key));
    const rec: McpKeyRecord = {
      buildId,
      key: generateKey(this.rand),
      createdAt: this.now(),
      ...(label != null ? { label } : {}),
    };
    this.byBuild.set(buildId, rec);
    this.byHash.set(hashKey(rec.key), buildId);
    return rec;
  }

  async resolve(key: string): Promise<string | null> {
    return this.byHash.get(hashKey(key)) ?? null;
  }

  async get(buildId: string): Promise<McpKeyRecord | null> {
    const r = this.byBuild.get(buildId);
    return r ? { ...r } : null;
  }

  async revoke(buildId: string): Promise<void> {
    const prev = this.byBuild.get(buildId);
    if (prev) this.byHash.delete(hashKey(prev.key));
    this.byBuild.delete(buildId);
  }

  async list(): Promise<Array<{ buildId: string; createdAt: number; label?: string }>> {
    return [...this.byBuild.values()].map((r) => ({
      buildId: r.buildId,
      createdAt: r.createdAt,
      ...(r.label != null ? { label: r.label } : {}),
    }));
  }
}

export class FileMcpKeyStore implements McpKeyStore {
  private byBuild = new Map<string, McpKeyRecord>();
  private byHash = new Map<string, string>();

  constructor(
    private readonly dir: string,
    private readonly swk: Bytes,
    private readonly now: () => number = () => Date.now(),
    private readonly rand: () => Uint8Array = () => randomBytes(24),
  ) {}

  async load(): Promise<void> {
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".mcpkey")) continue;
      try {
        const hex = (await readFile(join(this.dir, f), "utf8")).trim();
        const rec = this.unseal(hex);
        if (rec) {
          this.byBuild.set(rec.buildId, rec);
          this.byHash.set(hashKey(rec.key), rec.buildId);
        }
      } catch {
        // skip unreadable entries
      }
    }
  }

  async mint(buildId: string, label?: string): Promise<McpKeyRecord> {
    const prev = this.byBuild.get(buildId);
    if (prev) this.byHash.delete(hashKey(prev.key));
    const rec: McpKeyRecord = {
      buildId,
      key: generateKey(this.rand),
      createdAt: this.now(),
      ...(label != null ? { label } : {}),
    };
    await this.persist(rec);
    this.byBuild.set(buildId, rec);
    this.byHash.set(hashKey(rec.key), buildId);
    return rec;
  }

  async resolve(key: string): Promise<string | null> {
    return this.byHash.get(hashKey(key)) ?? null;
  }

  async get(buildId: string): Promise<McpKeyRecord | null> {
    const r = this.byBuild.get(buildId);
    return r ? { ...r } : null;
  }

  async revoke(buildId: string): Promise<void> {
    const prev = this.byBuild.get(buildId);
    if (prev) this.byHash.delete(hashKey(prev.key));
    this.byBuild.delete(buildId);
    await rm(join(this.dir, `${encodeURIComponent(buildId)}.mcpkey`), { force: true });
  }

  async list(): Promise<Array<{ buildId: string; createdAt: number; label?: string }>> {
    return [...this.byBuild.values()].map((r) => ({
      buildId: r.buildId,
      createdAt: r.createdAt,
      ...(r.label != null ? { label: r.label } : {}),
    }));
  }

  private async persist(rec: McpKeyRecord): Promise<void> {
    if (!existsSync(this.dir)) await mkdir(this.dir, { recursive: true });
    const blob = sealLlmPayload(new TextEncoder().encode(JSON.stringify(rec)), this.swk);
    const file = join(this.dir, `${encodeURIComponent(rec.buildId)}.mcpkey`);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, sealedToHex(blob), { mode: 0o600 });
    await rename(tmp, file);
  }

  private unseal(hex: string): McpKeyRecord | null {
    const blob = sealedFromHex(hex);
    if (!blob) return null;
    const plain = openLlmPayload(blob, this.swk);
    const obj = JSON.parse(new TextDecoder().decode(plain)) as unknown;
    if (
      !obj ||
      typeof obj !== "object" ||
      typeof (obj as McpKeyRecord).buildId !== "string" ||
      typeof (obj as McpKeyRecord).key !== "string"
    ) {
      return null;
    }
    return obj as McpKeyRecord;
  }
}

function sealedToHex(blob: SealedBlob): string {
  const buf = new Uint8Array(blob.nonce.length + blob.ciphertext.length);
  buf.set(blob.nonce, 0);
  buf.set(blob.ciphertext, blob.nonce.length);
  let s = "";
  for (const x of buf) s += x.toString(16).padStart(2, "0");
  return s;
}

function sealedFromHex(hex: string): SealedBlob | null {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) return null;
  const buf = new Uint8Array(hex.length / 2);
  for (let i = 0; i < buf.length; i++) buf[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  if (buf.length < 12) return null;
  return { nonce: buf.slice(0, 12), ciphertext: buf.slice(12) };
}
