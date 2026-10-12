/**
 * API keys an owner's app ACCEPTS from machine clients (scripts, devices,
 * other servers) — `flagship/app-api-key/v1` (docs/app-apis.md §3).
 *
 * The phone picks a `keyId` (16 lowercase hex) and a scope, and signs with
 * the sensitive-order key (admin root when held, else the owner IRK):
 *
 *   flagship/app-api-key/v1|<serverDomain>|<serviceId>|<keyId>|<scope>|<expiresAt>|<issuedAt>
 *
 * `expiresAt` is unix ms, or 0 for "until revoked" (what the apps send).
 * The box mints the secret and hands the full key back once:
 * `fsk_<keyId>_<43 base64url chars>` (32 random bytes).
 *
 * `test-vectors/app-api-key/vectors.json` is the cross-platform reference.
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard, resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_APP_API_KEY = "flagship/app-api-key/v1";

export type AppApiKeyScope = "read" | "write";

export interface AppApiKeyGrant {
  /** The box the key is for (its FQDN). */
  serverDomain: string;
  /** The installed service, `<creator>-<slug>`. */
  serviceId: string;
  /** 16 lowercase hex, chosen by the client. */
  keyId: string;
  /** `read`: GET/HEAD/OPTIONS only; `write`: every method. */
  scope: AppApiKeyScope;
  /** Unix ms, or 0 = never expires. */
  expiresAt: number;
  /** Unix ms. */
  issuedAt: number;
}

export const APP_API_KEY_ID_RE = /^[0-9a-f]{16}$/;
/** `fsk_<keyId>_<secret>`; the secret is 32 bytes as unpadded base64url. */
export const APP_API_KEY_RE = /^fsk_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
export const APP_API_KEY_LABEL_MAX = 64;

/** Methods a `read` key may use. */
export function apiKeyScopeAllows(scope: AppApiKeyScope, method: string): boolean {
  if (scope === "write") return true;
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

export function appApiKeyGrantCanonicalBytes(g: AppApiKeyGrant): Bytes {
  if (g.serverDomain.length === 0) throw new Error("app-api-key: empty serverDomain");
  if (g.serviceId.length === 0) throw new Error("app-api-key: empty serviceId");
  legacyFieldGuard("serverDomain", g.serverDomain);
  legacyFieldGuard("serviceId", g.serviceId);
  if (!APP_API_KEY_ID_RE.test(g.keyId)) throw new Error("app-api-key: keyId must be 16 lowercase hex");
  if (g.scope !== "read" && g.scope !== "write") throw new Error("app-api-key: scope must be read or write");
  if (!Number.isSafeInteger(g.expiresAt) || g.expiresAt < 0) throw new Error("app-api-key: bad expiresAt");
  if (!Number.isSafeInteger(g.issuedAt) || g.issuedAt < 0) throw new Error("app-api-key: bad issuedAt");
  return new TextEncoder().encode(
    [TAG_APP_API_KEY, g.serverDomain, g.serviceId, g.keyId, g.scope, String(g.expiresAt), String(g.issuedAt)].join("|"),
  );
}

export function signAppApiKeyGrant(g: AppApiKeyGrant, signer: MsgSigner): Bytes {
  return resolveMsgSigner(signer)(appApiKeyGrantCanonicalBytes(g));
}

/** Never throws: a malformed grant simply fails. */
export function verifyAppApiKeyGrant(g: AppApiKeyGrant, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, appApiKeyGrantCanonicalBytes(g), pub);
  } catch {
    return false;
  }
}

/** Shape-check an untrusted JSON grant (no signature check). */
export function parseAppApiKeyGrant(v: unknown): AppApiKeyGrant | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.serverDomain !== "string" || typeof r.serviceId !== "string") return null;
  if (typeof r.keyId !== "string" || (r.scope !== "read" && r.scope !== "write")) return null;
  if (typeof r.expiresAt !== "number" || typeof r.issuedAt !== "number") return null;
  const g: AppApiKeyGrant = {
    serverDomain: r.serverDomain,
    serviceId: r.serviceId,
    keyId: r.keyId,
    scope: r.scope,
    expiresAt: r.expiresAt,
    issuedAt: r.issuedAt,
  };
  try {
    appApiKeyGrantCanonicalBytes(g);
  } catch {
    return null;
  }
  return g;
}

/** Split `fsk_<keyId>_<secret>`; null when it isn't one. */
export function parseAppApiKey(token: string): { keyId: string; secret: string } | null {
  const m = APP_API_KEY_RE.exec(token);
  return m ? { keyId: m[1]!, secret: m[2]! } : null;
}

export function formatAppApiKey(keyId: string, secret: string): string {
  return `fsk_${keyId}_${secret}`;
}
