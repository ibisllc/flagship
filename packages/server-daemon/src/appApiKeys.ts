/**
 * API keys an owner's app accepts from machine clients (docs/app-apis.md §3).
 *
 *   POST   /api/screens/services/:id/api-keys          { grant, signature, label } → 200 { ok, key }
 *   GET    /api/screens/services/:id/api-keys          → { keys:[{keyId, label, scope, createdAt, lastUsedAt, expiresAt}] }
 *   DELETE /api/screens/services/:id/api-keys/:keyId   → { ok } (no signature: it only removes access)
 *
 * The phone signs `flagship/app-api-key/v1` with the sensitive-order key; the
 * box mints the secret, returns the full `fsk_<keyId>_<secret>` once and keeps
 * only SHA-256(secret) (the secret is 32 random bytes, so a fast hash is
 * enough), with the grant and its signature, sealed under the SWK in
 * `<dataDir>/data/app-api-keys.sealed`. Keys are re-verified at every load, like
 * access lists: one whose signature no longer verifies is dropped.
 *
 * The app proxy calls `authenticate` before the container sees a request:
 * wrong, revoked or expired ⇒ 401; a read key on a write method ⇒ 403; over the
 * per-key rate ⇒ 429.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  APP_API_KEY_LABEL_MAX,
  apiKeyScopeAllows,
  formatAppApiKey,
  parseAppApiKey,
  parseAppApiKeyGrant,
  verifyAppApiKeyGrant,
  type AdminGrantView,
  type AppApiKeyGrant,
  type AppApiKeyScope,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";
import { keepCorruptAside, writeFileDurable } from "./durableFile.js";
import type { SwkOps } from "./keyCustodian.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";

type Swk = Pick<SwkOps, "sealWithSwk" | "openWithSwk">;

export interface ApiKeyView {
  keyId: string;
  label: string;
  scope: AppApiKeyScope;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
}

interface StoredKey extends ApiKeyView {
  serviceId: string;
  /** Lowercase hex SHA-256 of the secret's UTF-8 bytes. */
  secretSha256: string;
  grant: AppApiKeyGrant;
  signature: string;
  /**
   * Set when the key arrived in an owner-sealed server backup made on another
   * server (its grant names that one): the server it now lives on. Only the
   * owner can open a backup, so the import is the owner's say-so; the grant's
   * own owner signature is still checked at every load.
   */
  importedFor?: string;
}

/** One key as a server backup carries it: the grant, its signature and the secret's hash (never the secret). */
export interface ArchivedApiKey {
  grant: AppApiKeyGrant;
  signature: string;
  secretSha256: string;
  label: string;
  createdAt: number;
}

export type ApiKeyAuth =
  /** No `Authorization: Bearer fsk_…` on the request: not an API-key call. */
  | { kind: "none" }
  /** Wrong, revoked, expired, or for another app. */
  | { kind: "invalid" }
  | { kind: "scope"; keyId: string; scope: AppApiKeyScope }
  | { kind: "rate-limited"; keyId: string; retryAfterSec: number }
  | { kind: "ok"; keyId: string; scope: AppApiKeyScope };

export interface ApiKeyAuthenticator {
  authenticate(serviceId: string, method: string, headers: Record<string, string>): ApiKeyAuth;
}

export interface ApiKeyRateLimit {
  /** Requests a key may burst. */
  burst: number;
  /** Sustained requests per second. */
  perSecond: number;
}

export const DEFAULT_API_KEY_RATE: ApiKeyRateLimit = { burst: 120, perSecond: 10 };
/** lastUsedAt is written to disk at most this often per key. */
const LAST_USED_PERSIST_MS = 60_000;
const SAVE_DEBOUNCE_MS = 2_000;
const KEYS_PER_APP_MAX = 100;

const FSK_ANYWHERE = /fsk_/;

/**
 * The `fsk_` key a request carries, `"malformed"` when its Authorization
 * header mentions one but isn't exactly `Bearer fsk_<keyId>_<secret>`, or null
 * when it carries none (the app's own Authorization passes through untouched).
 */
export function apiKeyFromHeaders(headers: Record<string, string>): { keyId: string; secret: string } | "malformed" | null {
  const auth = headers["authorization"];
  if (typeof auth !== "string" || !FSK_ANYWHERE.test(auth)) return null;
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(auth);
  const parsed = m ? parseAppApiKey(m[1]!) : null;
  return parsed ?? "malformed";
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export interface AppApiKeyStoreOptions {
  now?: () => number;
  rate?: ApiKeyRateLimit;
}

export class AppApiKeyStore implements ApiKeyAuthenticator {
  private keys = new Map<string, StoredKey>();
  private buckets = new Map<string, { tokens: number; at: number }>();
  private persistedLastUsed = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private readonly rate: ApiKeyRateLimit;

  /** `path` null ⇒ memory only (tests). */
  constructor(
    private readonly path: string | null,
    private readonly swk: Swk | null,
    opts: AppApiKeyStoreOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.rate = opts.rate ?? DEFAULT_API_KEY_RATE;
  }

  /** Load, keeping only keys whose grant still verifies. Returns how many were dropped. */
  async load(authorize: (grant: AppApiKeyGrant, sig: Uint8Array) => boolean, serverDomain: string): Promise<{ dropped: number }> {
    if (!this.path || !this.swk) return { dropped: 0 };
    let hexText: string;
    try {
      hexText = (await readFile(this.path, "utf8")).trim();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { dropped: 0 };
      throw e;
    }
    let parsed: { keys?: unknown };
    try {
      const buf = Buffer.from(hexText, "hex");
      if (buf.length < 12) throw new Error(`${this.path} is truncated`);
      const plain = this.swk.openWithSwk({ nonce: buf.subarray(0, 12), ciphertext: buf.subarray(12) });
      parsed = JSON.parse(Buffer.from(plain).toString("utf8")) as { keys?: unknown };
    } catch (e) {
      // Closed (no key works); set aside so the next save doesn't overwrite it.
      await keepCorruptAside(this.path, e, "No app API key works until you make new ones.");
      throw e;
    }
    let dropped = 0;
    this.keys.clear();
    for (const raw of Array.isArray(parsed.keys) ? parsed.keys : []) {
      const k = raw as Partial<StoredKey>;
      const grant = parseAppApiKeyGrant(k.grant);
      const sig = typeof k.signature === "string" && /^[0-9a-f]{128}$/.test(k.signature) ? Buffer.from(k.signature, "hex") : null;
      if (
        !grant ||
        !sig ||
        (grant.serverDomain !== serverDomain && k.importedFor !== serverDomain) ||
        typeof k.secretSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(k.secretSha256) ||
        typeof k.label !== "string" ||
        typeof k.createdAt !== "number" ||
        !authorize(grant, new Uint8Array(sig))
      ) {
        dropped++;
        continue;
      }
      const lastUsedAt = typeof k.lastUsedAt === "number" ? k.lastUsedAt : null;
      this.keys.set(grant.keyId, {
        serviceId: grant.serviceId,
        keyId: grant.keyId,
        label: k.label,
        scope: grant.scope,
        createdAt: k.createdAt,
        lastUsedAt,
        expiresAt: grant.expiresAt,
        secretSha256: k.secretSha256,
        grant,
        signature: k.signature as string,
        ...(k.importedFor === serverDomain && grant.serverDomain !== serverDomain ? { importedFor: serverDomain } : {}),
      });
      if (lastUsedAt !== null) this.persistedLastUsed.set(grant.keyId, lastUsedAt);
    }
    if (dropped > 0) await this.save();
    return { dropped };
  }

  list(serviceId: string): ApiKeyView[] {
    return [...this.keys.values()]
      .filter((k) => k.serviceId === serviceId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(view);
  }

  /** keyIds are unique across the box (the key string carries only the keyId). */
  has(keyId: string): boolean {
    return this.keys.has(keyId);
  }

  count(serviceId: string): number {
    let n = 0;
    for (const k of this.keys.values()) if (k.serviceId === serviceId) n++;
    return n;
  }

  /** Mint the secret for an already-authorized grant. Returns the full key (shown once). */
  async create(grant: AppApiKeyGrant, signature: string, label: string): Promise<{ key: string; view: ApiKeyView }> {
    if (this.keys.has(grant.keyId)) throw new Error("keyId exists");
    const secret = randomBytes(32).toString("base64url");
    const stored: StoredKey = {
      serviceId: grant.serviceId,
      keyId: grant.keyId,
      label,
      scope: grant.scope,
      createdAt: this.now(),
      lastUsedAt: null,
      expiresAt: grant.expiresAt,
      secretSha256: sha256Hex(secret),
      grant,
      signature: signature.toLowerCase(),
    };
    this.keys.set(grant.keyId, stored);
    await this.save();
    return { key: formatAppApiKey(grant.keyId, secret), view: view(stored) };
  }

  /** A service's keys for a server backup. */
  exportService(serviceId: string): ArchivedApiKey[] {
    return [...this.keys.values()]
      .filter((k) => k.serviceId === serviceId)
      .map((k) => ({ grant: k.grant, signature: k.signature, secretSha256: k.secretSha256, label: k.label, createdAt: k.createdAt }));
  }

  /**
   * Take a service's keys from a server backup onto THIS server (`serverDomain`),
   * so the clients that hold them keep working. Each grant must still verify
   * under the owner and name the service; a keyId already here is skipped.
   */
  async importService(
    serviceId: string,
    keys: unknown,
    authorize: (grant: AppApiKeyGrant, sig: Uint8Array) => boolean,
    serverDomain: string,
  ): Promise<{ imported: number; dropped: number }> {
    let imported = 0;
    let dropped = 0;
    for (const raw of Array.isArray(keys) ? keys : []) {
      const k = raw as Partial<ArchivedApiKey>;
      const grant = parseAppApiKeyGrant(k.grant);
      const sig = typeof k.signature === "string" && /^[0-9a-f]{128}$/.test(k.signature) ? Buffer.from(k.signature, "hex") : null;
      if (
        !grant ||
        !sig ||
        grant.serviceId !== serviceId ||
        this.keys.has(grant.keyId) ||
        typeof k.secretSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(k.secretSha256) ||
        typeof k.label !== "string" ||
        !authorize(grant, new Uint8Array(sig))
      ) {
        dropped++;
        continue;
      }
      this.keys.set(grant.keyId, {
        serviceId,
        keyId: grant.keyId,
        label: k.label,
        scope: grant.scope,
        createdAt: typeof k.createdAt === "number" ? k.createdAt : this.now(),
        lastUsedAt: null,
        expiresAt: grant.expiresAt,
        secretSha256: k.secretSha256,
        grant,
        signature: k.signature!.toLowerCase(),
        ...(grant.serverDomain !== serverDomain ? { importedFor: serverDomain } : {}),
      });
      imported++;
    }
    if (imported > 0) await this.save();
    return { imported, dropped };
  }

  async revoke(serviceId: string, keyId: string): Promise<boolean> {
    const k = this.keys.get(keyId);
    if (!k || k.serviceId !== serviceId) return false;
    this.keys.delete(keyId);
    this.buckets.delete(keyId);
    await this.save();
    return true;
  }

  /** Drop every key of a service that is no longer installed. */
  async pruneTo(installed: (serviceId: string) => boolean): Promise<number> {
    let n = 0;
    for (const [id, k] of this.keys) {
      if (!installed(k.serviceId)) {
        this.keys.delete(id);
        this.buckets.delete(id);
        n++;
      }
    }
    if (n > 0) await this.save();
    return n;
  }

  async dropService(serviceId: string): Promise<number> {
    return this.pruneTo((id) => id !== serviceId);
  }

  /** The key, when it is valid for this service right now (no rate or lastUsed accounting). */
  private match(serviceId: string, keyId: string, secret: string): StoredKey | null {
    const k = this.keys.get(keyId);
    const want = Buffer.from(k?.secretSha256 ?? "0".repeat(64), "hex");
    const got = createHash("sha256").update(secret, "utf8").digest();
    const same = timingSafeEqual(want, got);
    if (!k || !same || k.serviceId !== serviceId) return null;
    if (k.expiresAt !== 0 && this.now() >= k.expiresAt) return null;
    return k;
  }

  authenticate(serviceId: string, method: string, headers: Record<string, string>): ApiKeyAuth {
    const presented = apiKeyFromHeaders(headers);
    if (presented === null) return { kind: "none" };
    if (presented === "malformed") return { kind: "invalid" };
    const k = this.match(serviceId, presented.keyId, presented.secret);
    if (!k) return { kind: "invalid" };
    const retryAfterSec = this.take(k.keyId);
    if (retryAfterSec > 0) return { kind: "rate-limited", keyId: k.keyId, retryAfterSec };
    this.touch(k);
    if (!apiKeyScopeAllows(k.scope, method)) return { kind: "scope", keyId: k.keyId, scope: k.scope };
    return { kind: "ok", keyId: k.keyId, scope: k.scope };
  }

  /** Token bucket per key. Returns 0 when the request may go, else seconds to wait. */
  private take(keyId: string): number {
    const now = this.now();
    const b = this.buckets.get(keyId) ?? { tokens: this.rate.burst, at: now };
    b.tokens = Math.min(this.rate.burst, b.tokens + ((now - b.at) / 1000) * this.rate.perSecond);
    b.at = now;
    this.buckets.set(keyId, b);
    if (b.tokens < 1) return Math.max(1, Math.ceil((1 - b.tokens) / this.rate.perSecond));
    b.tokens -= 1;
    return 0;
  }

  private touch(k: StoredKey): void {
    const now = this.now();
    k.lastUsedAt = now;
    const persisted = this.persistedLastUsed.get(k.keyId) ?? 0;
    if (now - persisted >= LAST_USED_PERSIST_MS) {
      this.persistedLastUsed.set(k.keyId, now);
      this.scheduleSave();
    }
  }

  private scheduleSave(): void {
    if (!this.path || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save().catch(() => {});
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  /** Wait for pending writes (tests, shutdown). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.save();
    }
    await this.chain;
  }

  private save(): Promise<void> {
    const path = this.path;
    const swk = this.swk;
    if (!path || !swk) return Promise.resolve();
    const snapshot = { keys: [...this.keys.values()] };
    const next = this.chain.then(async () => {
      const blob = swk.sealWithSwk(new TextEncoder().encode(JSON.stringify(snapshot)));
      const hexText = Buffer.concat([Buffer.from(blob.nonce), Buffer.from(blob.ciphertext)]).toString("hex");
      await mkdir(dirname(path), { recursive: true });
      await writeFileDurable(path, hexText);
    });
    this.chain = next.catch(() => {});
    return next;
  }
}

function view(k: StoredKey): ApiKeyView {
  return {
    keyId: k.keyId,
    label: k.label,
    scope: k.scope,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    expiresAt: k.expiresAt,
  };
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

// ── screens API ───────────────────────────────────────────────────────

export interface ApiKeyAuthority {
  username: string;
  ownerIrkPub: Uint8Array;
  adminRootPub?: Uint8Array;
  activeGrants?: readonly AdminGrantView[];
}

/** The grant's signature under the box's sensitive-order authority. */
export function apiKeyAuthorizer(a: ApiKeyAuthority): (grant: AppApiKeyGrant, sig: Uint8Array) => boolean {
  return (grant, signature) =>
    authorizeSensitiveOrder({
      ownerIrkPub: a.ownerIrkPub,
      ...(a.adminRootPub ? { adminRootPub: a.adminRootPub } : {}),
      username: a.username,
      ...(a.activeGrants ? { activeGrants: a.activeGrants } : {}),
      order: grant,
      signature,
      verify: verifyAppApiKeyGrant,
    });
}

export interface AppApiKeysHttpOptions {
  serverDomain: string;
  store: AppApiKeyStore;
  /** Null when the box doesn't know its owner: nothing can be authorized. */
  authorize: ((grant: AppApiKeyGrant, sig: Uint8Array) => boolean) | null;
  installed: (serviceId: string) => boolean;
  now?: () => number;
  /** How far `issuedAt` may be from the box clock. Default 10 min. */
  maxSkewMs?: number;
}

export interface AppApiKeysHttp {
  handle(path: string, method: string, req: HttpRequest, ctx: { companion: boolean }): Promise<HttpResponse | null>;
}

const J = { "content-type": "application/json" } as const;
const KEYS_RE = /^\/api\/screens\/services\/([^/]+)\/api-keys$/;
const KEY_RE = /^\/api\/screens\/services\/([^/]+)\/api-keys\/([^/]+)$/;

export function isAppApiKeysPath(path: string): boolean {
  return KEYS_RE.test(path) || KEY_RE.test(path);
}

const COMPANION_ERROR =
  "companion sessions are read-only: open your owner app to manage API keys";

/** Runs behind the paired-session gate (screensHttp). */
export function buildAppApiKeysHttp(opts: AppApiKeysHttpOptions): AppApiKeysHttp {
  const now = opts.now ?? (() => Date.now());
  const maxSkew = opts.maxSkewMs ?? 10 * 60_000;
  const json = (status: number, body: unknown): HttpResponse => ({ status, headers: J, body: JSON.stringify(body) });
  const err = (status: number, error: string, extra: Record<string, unknown> = {}): HttpResponse =>
    json(status, { error, ...extra });

  async function create(serviceId: string, req: HttpRequest): Promise<HttpResponse> {
    let body: { grant?: unknown; signature?: unknown; label?: unknown };
    try {
      body = JSON.parse(req.body.toString("utf8")) as typeof body;
    } catch {
      return err(400, "invalid json");
    }
    if (typeof body !== "object" || body === null) return err(400, "invalid json");
    const grant = parseAppApiKeyGrant(body.grant);
    if (!grant) return err(400, "malformed grant");
    if (grant.serviceId !== serviceId) return err(400, "grant is for a different service");
    if (typeof body.signature !== "string" || !/^[0-9a-fA-F]{128}$/.test(body.signature)) {
      return err(400, "invalid signature hex");
    }
    if (typeof body.label !== "string") return err(400, "label required");
    const label = body.label.trim();
    if (label.length < 1 || [...label].length > APP_API_KEY_LABEL_MAX) {
      return err(400, `label must be 1–${APP_API_KEY_LABEL_MAX} characters`);
    }
    if (/[\u0000-\u001f\u007f]/.test(label)) return err(400, "label must be one line of plain text");
    if (grant.serverDomain !== opts.serverDomain) return err(403, "grant is for a different server");
    if (Math.abs(now() - grant.issuedAt) > maxSkew) {
      return err(403, "stale grant: issuedAt is more than 10 minutes from the server's clock");
    }
    if (!opts.authorize) return err(503, "this server doesn't know its owner yet");
    if (!opts.authorize(grant, new Uint8Array(Buffer.from(body.signature, "hex")))) {
      return err(403, "invalid signature");
    }
    if (opts.store.has(grant.keyId)) return err(409, "keyId exists; pick a new one");
    if (opts.store.count(serviceId) >= KEYS_PER_APP_MAX) {
      return err(400, `an app can have at most ${KEYS_PER_APP_MAX} API keys; revoke one first`);
    }
    const { key } = await opts.store.create(grant, body.signature, label);
    return json(200, { ok: true, key });
  }

  return {
    async handle(path, method, req, ctx) {
      const many = KEYS_RE.exec(path);
      const one = many ? null : KEY_RE.exec(path);
      if (!many && !one) return null;
      const serviceId = safeDecode((many ?? one)![1]!);
      if (serviceId === null) return err(400, "bad path");
      if (many && method === "GET") {
        if (!opts.installed(serviceId)) return err(404, "no such service");
        return json(200, { keys: opts.store.list(serviceId) });
      }
      if (many && method === "POST") {
        if (ctx.companion) return err(403, COMPANION_ERROR, { code: "companion-write-not-allowed" });
        if (!opts.installed(serviceId)) return err(404, "no such service");
        return create(serviceId, req);
      }
      if (one && method === "DELETE") {
        if (ctx.companion) return err(403, COMPANION_ERROR, { code: "companion-write-not-allowed" });
        if (!opts.installed(serviceId)) return err(404, "no such service");
        const keyId = safeDecode(one[2]!) ?? "";
        if (!(await opts.store.revoke(serviceId, keyId))) return err(404, "no such API key");
        return json(200, { ok: true });
      }
      return err(405, "method not allowed");
    },
  };
}
