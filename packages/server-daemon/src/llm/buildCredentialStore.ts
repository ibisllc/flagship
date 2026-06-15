/**
 * Transient BYOK credential store — the box's short-lived holder for the
 * owner's LLM provider key, scoped to one vibe-code session / build.
 *
 * Why a store at all? The owner endorsed a "transient key on the box"
 * posture: a build/chat should continue (multi-turn, the git-adapt pass)
 * even while the phone is locked, so the daemon keeps the key for the
 * life of the session rather than re-requesting it per turn. The phone /
 * webapp delivers the credential ONCE over the paired-session-gated
 * pinned pipe (the box terminates TLS); subsequent turns reuse it.
 *
 * ── flagshipserver.com is NEVER in this path ──────────────────────────
 * The credential only ever flows phone/webapp → box. .com never sees it,
 * never relays it, never stores it. The box calls the provider directly.
 *
 * Secret-at-rest: keyed by sessionId/buildId, one sealed file per entry
 * under `<dir>/<id>.cred`, mode-0600, atomic tmp+rename — exactly the
 * `serviceEnvStore` precedent, using the same SWK-derived AEAD
 * (`sealLlmPayload`/`openLlmPayload`). On boot `load()` repopulates the
 * cache so an in-flight build survives a daemon restart.
 *
 * The plaintext is held in the in-memory cache and handed out ONLY via
 * `get()` (the just-in-time unseal a provider call needs). It is NEVER
 * logged, NEVER returned by any screens / journal / public surface, and
 * the non-secret accessor (`providerName`) returns the PROVIDER NAME
 * only — the single thing the journal may record.
 *
 * Cleared on session end / cancel via `forget()` (idempotent).
 */

import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  openLlmPayload,
  sealLlmPayload,
  type Bytes,
  type SealedBlob,
} from "@flagship/protocol";
import type { LlmCredential } from "../llmHarness.js";

export interface BuildCredentialStore {
  /** Store (full replace) the credential for `id`. Plaintext at rest is sealed. */
  put(id: string, cred: LlmCredential): Promise<void>;
  /** The full credential (incl. apiKey) for a just-in-time provider call, or null. */
  get(id: string): Promise<LlmCredential | null>;
  /** Whether a credential exists for `id` (no unseal). */
  has(id: string): boolean;
  /**
   * The PROVIDER NAME only — the single non-secret field a value-free
   * journal may record. Null when no credential is set.
   */
  providerName(id: string): string | null;
  /** Drop the credential for `id` (session end / cancel). Idempotent. */
  forget(id: string): Promise<void>;
}

function validate(obj: unknown): LlmCredential | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.provider !== "string" || o.provider.length === 0) return null;
  if (typeof o.apiKey !== "string" || o.apiKey.length === 0) return null;
  if (o.baseUrl !== undefined && typeof o.baseUrl !== "string") return null;
  const out: LlmCredential = { provider: o.provider, apiKey: o.apiKey };
  if (typeof o.baseUrl === "string" && o.baseUrl.length > 0) out.baseUrl = o.baseUrl;
  return out;
}

/** In-memory implementation. Loses state across restarts; for tests. */
export class InMemoryBuildCredentialStore implements BuildCredentialStore {
  private byId = new Map<string, LlmCredential>();

  async put(id: string, cred: LlmCredential): Promise<void> {
    this.byId.set(id, { ...cred });
  }

  async get(id: string): Promise<LlmCredential | null> {
    const c = this.byId.get(id);
    return c ? { ...c } : null;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  providerName(id: string): string | null {
    return this.byId.get(id)?.provider ?? null;
  }

  async forget(id: string): Promise<void> {
    this.byId.delete(id);
  }
}

/**
 * File-backed, SWK-sealed write-through cache. Production default. One
 * file per id under `<dir>/<id>.cred` holding the `sealLlmPayload` blob
 * (nonce || ciphertext, hex). Call `load()` once on boot.
 */
export class FileBuildCredentialStore implements BuildCredentialStore {
  private cache = new Map<string, LlmCredential>();

  constructor(
    private readonly dir: string,
    private readonly swk: Bytes,
  ) {}

  async load(): Promise<void> {
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".cred")) continue;
      const id = f.slice(0, -".cred".length);
      try {
        const hex = (await readFile(join(this.dir, f), "utf8")).trim();
        const cred = this.unseal(hex);
        if (cred) this.cache.set(id, cred);
      } catch {
        // Unreadable / undecryptable entry → the build just lacks a
        // credential until the owner re-delivers one. Never refuse boot.
      }
    }
  }

  async put(id: string, cred: LlmCredential): Promise<void> {
    const ok = validate(cred);
    if (!ok) throw new Error("invalid credential");
    if (!existsSync(this.dir)) await mkdir(this.dir, { recursive: true });
    const blob = sealLlmPayload(
      new TextEncoder().encode(JSON.stringify(ok)),
      this.swk,
    );
    const file = join(this.dir, `${id}.cred`);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, sealedToHex(blob), { mode: 0o600 });
    await rename(tmp, file);
    this.cache.set(id, { ...ok });
  }

  async get(id: string): Promise<LlmCredential | null> {
    const c = this.cache.get(id);
    return c ? { ...c } : null;
  }

  has(id: string): boolean {
    return this.cache.has(id);
  }

  providerName(id: string): string | null {
    return this.cache.get(id)?.provider ?? null;
  }

  async forget(id: string): Promise<void> {
    this.cache.delete(id);
    await rm(join(this.dir, `${id}.cred`), { force: true });
  }

  private unseal(hex: string): LlmCredential | null {
    const blob = sealedFromHex(hex);
    if (!blob) return null;
    const plain = openLlmPayload(blob, this.swk);
    return validate(JSON.parse(new TextDecoder().decode(plain)) as unknown);
  }
}

// Wire form: [nonce: 12 B][ciphertext + GCM tag: var], hex-encoded.
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
  for (let i = 0; i < buf.length; i++) {
    buf[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  if (buf.length < 12) return null;
  return { nonce: buf.slice(0, 12), ciphertext: buf.slice(12) };
}
