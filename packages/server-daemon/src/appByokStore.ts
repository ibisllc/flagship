/**
 * Per-app BYOK provider config — the user's own LLM provider key,
 * scoped to a single installed app.
 *
 * A vibe-coded app that wants to call an LLM at runtime uses the
 * *user's own* provider credentials (Anthropic / OpenAI / Google /
 * OpenRouter / Ollama). flagshipserver.com is never in the credential
 * path — the key lives only on the user's own Flagship box. This store
 * is where that `{providerId, apiKey, baseUrl?}` triple is held so the
 * daemon's runtime LLM-call seam can resolve it on a per-app basis.
 *
 * Secret-at-rest: the box is LUKS-encrypted, but the key is still
 * app-private, so we additionally wrap it with the same SWK-derived
 * AEAD the daemon already uses for the user's LLM key on the wire
 * (`sealLlmPayload`/`openLlmPayload` — see `LlmHarness`). One sealed
 * blob per app on disk, exactly mirroring the file-per-app, mode-0600,
 * atomic tmp+rename + boot-`load()` precedent set by `appAuthToken.ts`.
 *
 * The plaintext key is held only transiently for the duration of a
 * single provider call. It is NEVER logged, NEVER returned by any
 * screens / app-list / manifest / public endpoint, and the public
 * accessor (`describe`) deliberately omits it.
 *
 * Revoked by deleting the entry — happens on uninstall, idempotent.
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

/** The user's own provider credentials for one app. */
export interface AppByokConfig {
  /** Provider id matching a `@flagship/llm-providers` registry name. */
  providerId: string;
  /** The user's API key. SECRET — never logged or surfaced. */
  apiKey: string;
  /** Optional provider base-url override (proxy / self-host). */
  baseUrl?: string;
}

/**
 * Non-secret view of a stored config — safe to return from any
 * surface. Deliberately omits `apiKey`; `hasKey` is the only signal.
 */
export interface AppByokDescriptor {
  providerId: string;
  baseUrl?: string;
  hasKey: boolean;
}

export interface AppByokStore {
  /** Persist (or overwrite) the BYOK config for `appId`. */
  put(appId: string, cfg: AppByokConfig): Promise<void>;
  /** Load the full config (incl. key) for a runtime provider call, or null. */
  get(appId: string): Promise<AppByokConfig | null>;
  /** Non-secret descriptor for UI/debug surfaces. Never includes the key. */
  describe(appId: string): Promise<AppByokDescriptor | null>;
  /** Drop the config for an app (called on uninstall). Idempotent. */
  forget(appId: string): Promise<void>;
}

function redactDescriptor(cfg: AppByokConfig): AppByokDescriptor {
  return {
    providerId: cfg.providerId,
    baseUrl: cfg.baseUrl,
    hasKey: cfg.apiKey.length > 0,
  };
}

/**
 * In-memory implementation. Loses state across restarts; suitable for
 * tests and ephemeral daemons.
 */
export class InMemoryAppByokStore implements AppByokStore {
  private byApp = new Map<string, AppByokConfig>();

  async put(appId: string, cfg: AppByokConfig): Promise<void> {
    this.byApp.set(appId, { ...cfg });
  }

  async get(appId: string): Promise<AppByokConfig | null> {
    const c = this.byApp.get(appId);
    return c ? { ...c } : null;
  }

  async describe(appId: string): Promise<AppByokDescriptor | null> {
    const c = this.byApp.get(appId);
    return c ? redactDescriptor(c) : null;
  }

  async forget(appId: string): Promise<void> {
    this.byApp.delete(appId);
  }
}

/**
 * File-backed, SWK-sealed write-through cache. Production default.
 * One file per app under `<dir>/<appId>.byok` containing the
 * `sealLlmPayload` blob (nonce || ciphertext, hex). On construction
 * call `load()` to populate the in-memory cache.
 */
export class FileAppByokStore implements AppByokStore {
  private cache = new Map<string, AppByokConfig>();

  /** `swk` derives the same AEAD key the LLM harness uses on the wire. */
  constructor(
    private readonly dir: string,
    private readonly swk: Bytes,
  ) {}

  /** Read all persisted configs off disk into the cache. Call once on boot. */
  async load(): Promise<void> {
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".byok")) continue;
      const appId = f.slice(0, -".byok".length);
      try {
        const hex = (await readFile(join(this.dir, f), "utf8")).trim();
        const cfg = this.unseal(hex);
        if (cfg) this.cache.set(appId, cfg);
      } catch {
        // Ignore unreadable / undecryptable entries — a missing config
        // just means the app can't make BYOK calls until reconfigured,
        // which is better than refusing to boot.
      }
    }
  }

  async put(appId: string, cfg: AppByokConfig): Promise<void> {
    if (!existsSync(this.dir)) await mkdir(this.dir, { recursive: true });
    const blob = sealLlmPayload(
      new TextEncoder().encode(JSON.stringify(cfg)),
      this.swk,
    );
    const file = join(this.dir, `${appId}.byok`);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, sealedToHex(blob), { mode: 0o600 });
    await rename(tmp, file);
    this.cache.set(appId, { ...cfg });
  }

  async get(appId: string): Promise<AppByokConfig | null> {
    const c = this.cache.get(appId);
    return c ? { ...c } : null;
  }

  async describe(appId: string): Promise<AppByokDescriptor | null> {
    const c = this.cache.get(appId);
    return c ? redactDescriptor(c) : null;
  }

  async forget(appId: string): Promise<void> {
    this.cache.delete(appId);
    await rm(join(this.dir, `${appId}.byok`), { force: true });
  }

  private unseal(hex: string): AppByokConfig | null {
    const blob = sealedFromHex(hex);
    if (!blob) return null;
    const plain = openLlmPayload(blob, this.swk);
    const obj = JSON.parse(new TextDecoder().decode(plain)) as AppByokConfig;
    if (typeof obj.providerId !== "string" || typeof obj.apiKey !== "string") {
      return null;
    }
    return obj;
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
