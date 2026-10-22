/**
 * Separate access lists per server, a Pro option (docs/service-access-gating.md,
 * "Separate lists per server (Pro)").
 *
 * An app's access list is one list shared by every server of the account that
 * runs it. An admin can sign this order to give the app a separate list on each
 * server (`server`), or to go back to one list (`account`, where every server
 * takes the app's lead server's list). It names the app only, never a server,
 * so the same order holds wherever the app runs; latest order wins.
 *
 *   flagship/app-list-scope/v1|<serviceRef>|<account|server>|<issuedAt>
 *
 * Signed by the box's sensitive-order key, like the other admin-only access
 * orders (the admin root, or a device with an admin-root-signed `admin` grant;
 * the owner IRK only on a box with no admin root). A box honours `server` only
 * while it holds a CA-signed plan attestation saying the account is Pro
 * (planAttestation.ts).
 *
 * `test-vectors/app-list-scope/vectors.json` is the cross-platform reference.
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard, resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_APP_LIST_SCOPE = "flagship/app-list-scope/v1";

export const APP_LIST_SCOPES = ["account", "server"] as const;
export type AppListScope = (typeof APP_LIST_SCOPES)[number];

const SERVICE_REF_RE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;

export interface AppListScopeOrder {
  serviceRef: string;
  scope: AppListScope;
  issuedAt: number;
}

export function appListScopeCanonicalBytes(o: AppListScopeOrder): Bytes {
  if (!SERVICE_REF_RE.test(o.serviceRef)) throw new Error(`${TAG_APP_LIST_SCOPE}: bad serviceRef`);
  legacyFieldGuard("serviceRef", o.serviceRef);
  if (!(APP_LIST_SCOPES as readonly string[]).includes(o.scope)) throw new Error(`${TAG_APP_LIST_SCOPE}: bad scope`);
  if (!Number.isSafeInteger(o.issuedAt) || o.issuedAt < 0) throw new Error(`${TAG_APP_LIST_SCOPE}: bad issuedAt`);
  return new TextEncoder().encode([TAG_APP_LIST_SCOPE, o.serviceRef, o.scope, String(o.issuedAt)].join("|"));
}

export function signAppListScope(o: AppListScopeOrder, signer: MsgSigner): Bytes {
  return resolveMsgSigner(signer)(appListScopeCanonicalBytes(o));
}

/** Never throws: a malformed order simply fails. */
export function verifyAppListScope(o: AppListScopeOrder, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, appListScopeCanonicalBytes(o), pub);
  } catch {
    return false;
  }
}

/** Shape-check an untrusted JSON order (no signature check). */
export function parseAppListScopeOrder(v: unknown): AppListScopeOrder | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.serviceRef !== "string" || typeof r.scope !== "string" || typeof r.issuedAt !== "number") return null;
  if ("serverId" in r) return null;
  const o = { serviceRef: r.serviceRef, scope: r.scope as AppListScope, issuedAt: r.issuedAt };
  try {
    appListScopeCanonicalBytes(o);
  } catch {
    return null;
  }
  return o;
}
