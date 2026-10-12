/**
 * A signed order to change an app's live data (docs/app-apis.md §6).
 *
 * Reading an app's database over the paired owner session needs no
 * signature (it runs in a READ ONLY transaction); anything that may change
 * data or schema carries this grant, signed by the sensitive-order key
 * (admin root when held, else the owner IRK):
 *
 *   flagship/app-db-write/v1|<serverDomain>|<serviceId>|<store>|<sha256 hex of the UTF-8 sql>|<issuedAt ms>
 *
 * `test-vectors/app-db-write/vectors.json` is the cross-platform reference.
 */
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "./edSync.js";
import { hex, legacyFieldGuard, resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_APP_DB_WRITE = "flagship/app-db-write/v1";

export interface AppDbWriteGrant {
  /** The box (its FQDN). */
  serverDomain: string;
  /** The installed service, `<creator>-<slug>`. */
  serviceId: string;
  /** The app's data store (`default` for a single-store app). */
  store: string;
  /** `appDbSqlSha256` of the exact SQL sent with the grant. */
  sqlSha256: string;
  /** Unix ms. */
  issuedAt: number;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Lowercase hex SHA-256 of the SQL's UTF-8 bytes (no normalization). */
export function appDbSqlSha256(sql: string): string {
  return hex(sha256(new TextEncoder().encode(sql)));
}

export function appDbWriteGrantCanonicalBytes(g: AppDbWriteGrant): Bytes {
  if (g.serverDomain.length === 0) throw new Error("app-db-write: empty serverDomain");
  if (g.serviceId.length === 0) throw new Error("app-db-write: empty serviceId");
  if (g.store.length === 0) throw new Error("app-db-write: empty store");
  legacyFieldGuard("serverDomain", g.serverDomain);
  legacyFieldGuard("serviceId", g.serviceId);
  legacyFieldGuard("store", g.store);
  if (!SHA256_HEX_RE.test(g.sqlSha256)) throw new Error("app-db-write: sqlSha256 must be 64 lowercase hex");
  if (!Number.isSafeInteger(g.issuedAt) || g.issuedAt < 0) throw new Error("app-db-write: bad issuedAt");
  return new TextEncoder().encode(
    [TAG_APP_DB_WRITE, g.serverDomain, g.serviceId, g.store, g.sqlSha256, String(g.issuedAt)].join("|"),
  );
}

export function signAppDbWriteGrant(g: AppDbWriteGrant, signer: MsgSigner): Bytes {
  return resolveMsgSigner(signer)(appDbWriteGrantCanonicalBytes(g));
}

/** Never throws: a malformed grant simply fails. */
export function verifyAppDbWriteGrant(g: AppDbWriteGrant, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, appDbWriteGrantCanonicalBytes(g), pub);
  } catch {
    return false;
  }
}

/** Shape-check an untrusted JSON grant (no signature check). */
export function parseAppDbWriteGrant(v: unknown): AppDbWriteGrant | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.serverDomain !== "string" || typeof r.serviceId !== "string" || typeof r.store !== "string") return null;
  if (typeof r.sqlSha256 !== "string") return null;
  if (typeof r.issuedAt !== "number" || !Number.isSafeInteger(r.issuedAt)) return null;
  const g: AppDbWriteGrant = {
    serverDomain: r.serverDomain,
    serviceId: r.serviceId,
    store: r.store,
    sqlSha256: r.sqlSha256,
    issuedAt: r.issuedAt,
  };
  try {
    appDbWriteGrantCanonicalBytes(g);
  } catch {
    return null;
  }
  return g;
}
