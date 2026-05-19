/**
 * Per-app environment variables — the owner's `key=value` pairs scoped
 * to a single installed app.
 *
 * The core product is "vibecode an app." Instead of an AI-credentials-
 * specific pipe, an app gets a generic `Record<string,string>` of env
 * vars the owner sets from the phone/laptop control surface. The values
 * are injected ONLY into the deployed app's runtime environment. The
 * vibecoding model is given the env-var NAMES (so generated code can
 * reference them) but NEVER the values. "Set your OpenAI key" is just
 * "set `OPENAI_API_KEY` as an env var" — no AI special-casing.
 *
 * Secret-at-rest: the box is LUKS-encrypted, but values are still
 * app-private, so we additionally wrap them with the same SWK-derived
 * AEAD the daemon already uses for the user's LLM key on the wire
 * (`sealLlmPayload`/`openLlmPayload` — see `LlmHarness`). One sealed
 * blob per app on disk, exactly mirroring the file-per-app, mode-0600,
 * atomic tmp+rename + boot-`load()` precedent set by `appAuthToken.ts`.
 *
 * The plaintext values are held only transiently for the duration of a
 * single deploy (env injection). They are NEVER logged, NEVER returned
 * by any screens / app-list / manifest / public endpoint, and the only
 * non-runtime accessor (`names`) deliberately returns the KEY NAMES
 * ONLY — that is the single thing the vibecode session and any public
 * surface may obtain.
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

/** The owner's per-app env vars. Values are SECRET. */
export type AppEnv = Record<string, string>;

export interface AppEnvStore {
  /** Persist (full replace) the env map for `serviceId`. */
  put(serviceId: string, env: AppEnv): Promise<void>;
  /** Load the full env map (incl. values) for runtime injection, or null. */
  get(serviceId: string): Promise<AppEnv | null>;
  /**
   * The KEY NAMES only (sorted) for `serviceId` — the ONLY thing a
   * non-runtime caller (the vibecode session, any public/screens
   * surface) may obtain. Never includes values. Empty array when the
   * app has no env set.
   */
  names(serviceId: string): Promise<string[]>;
  /** Drop the env for an app (called on uninstall). Idempotent. */
  forget(serviceId: string): Promise<void>;
}

function sortedNames(env: AppEnv): string[] {
  return Object.keys(env).sort();
}

/**
 * The ONLY env artifact that may travel with an exported / shared /
 * published app: a schema of declared env-var NAMES (sorted), so a
 * recipient knows what to set on their own box. It carries NO values —
 * the values are sealed at rest on the originating box and never leave
 * it. `store.names(serviceId)` is the source; this is the shape that may
 * be embedded in a share/marketplace package.
 */
export interface ExportedEnvSchema {
  /** Declared env-var names. Never values. */
  names: string[];
}

export async function exportEnvSchema(
  store: AppEnvStore,
  serviceId: string,
): Promise<ExportedEnvSchema> {
  return { names: await store.names(serviceId) };
}

/**
 * In-memory implementation. Loses state across restarts; suitable for
 * tests and ephemeral daemons.
 */
export class InMemoryAppEnvStore implements AppEnvStore {
  private byApp = new Map<string, AppEnv>();

  async put(serviceId: string, env: AppEnv): Promise<void> {
    this.byApp.set(serviceId, { ...env });
  }

  async get(serviceId: string): Promise<AppEnv | null> {
    const e = this.byApp.get(serviceId);
    return e ? { ...e } : null;
  }

  async names(serviceId: string): Promise<string[]> {
    const e = this.byApp.get(serviceId);
    return e ? sortedNames(e) : [];
  }

  async forget(serviceId: string): Promise<void> {
    this.byApp.delete(serviceId);
  }
}

/**
 * File-backed, SWK-sealed write-through cache. Production default.
 * One file per app under `<dir>/<serviceId>.env` containing the
 * `sealLlmPayload` blob (nonce || ciphertext, hex). On construction
 * call `load()` to populate the in-memory cache.
 */
export class FileAppEnvStore implements AppEnvStore {
  private cache = new Map<string, AppEnv>();

  /** `swk` derives the same AEAD key the LLM harness uses on the wire. */
  constructor(
    private readonly dir: string,
    private readonly swk: Bytes,
  ) {}

  /** Read all persisted envs off disk into the cache. Call once on boot. */
  async load(): Promise<void> {
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".env")) continue;
      const serviceId = f.slice(0, -".env".length);
      try {
        const hex = (await readFile(join(this.dir, f), "utf8")).trim();
        const env = this.unseal(hex);
        if (env) this.cache.set(serviceId, env);
      } catch {
        // Ignore unreadable / undecryptable entries — a missing env
        // just means the app runs without those vars until reset,
        // which is better than refusing to boot.
      }
    }
  }

  async put(serviceId: string, env: AppEnv): Promise<void> {
    if (!existsSync(this.dir)) await mkdir(this.dir, { recursive: true });
    const blob = sealLlmPayload(
      new TextEncoder().encode(JSON.stringify(env)),
      this.swk,
    );
    const file = join(this.dir, `${serviceId}.env`);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, sealedToHex(blob), { mode: 0o600 });
    await rename(tmp, file);
    this.cache.set(serviceId, { ...env });
  }

  async get(serviceId: string): Promise<AppEnv | null> {
    const e = this.cache.get(serviceId);
    return e ? { ...e } : null;
  }

  async names(serviceId: string): Promise<string[]> {
    const e = this.cache.get(serviceId);
    return e ? sortedNames(e) : [];
  }

  async forget(serviceId: string): Promise<void> {
    this.cache.delete(serviceId);
    await rm(join(this.dir, `${serviceId}.env`), { force: true });
  }

  private unseal(hex: string): AppEnv | null {
    const blob = sealedFromHex(hex);
    if (!blob) return null;
    const plain = openLlmPayload(blob, this.swk);
    const obj = JSON.parse(new TextDecoder().decode(plain)) as unknown;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const out: AppEnv = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v !== "string") return null;
      out[k] = v;
    }
    return out;
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
