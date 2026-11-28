/**
 * Org read tokens (docs/account-read-token.md "Org routes", docs/enterprise-accounts.md §6, §7).
 *
 * An org's private reads are served only to a bearer of a read token for that org, minted at
 * `POST /api/orgs/<orgId>/read-token` with an `OrgReadTokenRequest` signed by a live seat's
 * member key or seat admin key (subject `seat:<seatId>`), or by the STK of one of the org's
 * servers (subject `box:<serverDomain>`).
 *
 * The token is `ort1.<b64url(claims)>.<b64url(HMAC-SHA256)>`, keyed by the same Worker secret as
 * account read tokens (`ACCOUNT_READ_TOKEN_SECRET`) under its own context string, so neither kind
 * can stand in for the other. Every read re-checks the signer against the org as `.com` verifies
 * it from genesis: a revoked, frozen or lapsed seat, an org admin removed from the record, or a
 * server whose registration was revoked or deleted is refused on its next request.
 */

import {
  verifyOrgReadTokenRequestFast,
  type OrgReadTokenRequest,
  type OrgSeatRole,
} from "@flagship/protocol";
import type { ServerStorage } from "@flagship/storage";
import type { DirectoryNonceStore } from "./accountDirectory.js";
import { ACCOUNT_READ_HEADERS, decodeReadToken, encodeReadToken } from "./accountReadToken.js";
import { hexToBytes } from "./hex.js";
import { loadOrg, type OrgDeps, type OrgView } from "./orgs.js";
import { forbidden, malformed, ok, type HandlerResponseWithHeaders } from "./types.js";

const PREFIX = "ort1";
const MAC_CONTEXT = "flagship/org-read-token/v1";
export const ORG_SEAT_TOKEN_TTL_MS = 7 * 24 * 60 * 60_000;
export const ORG_BOX_TOKEN_TTL_MS = 24 * 60 * 60_000;
const FRESHNESS_MS = 5 * 60_000;
const ORG_ID = /^[0-9a-f]{32}$/;

/** `sub` is `seat:<seatId>` or `box:<serverDomain>`; `k` the signer's key at mint time. */
export interface OrgReadTokenClaims {
  o: string;
  sub: string;
  k: string;
  iat: number;
  exp: number;
}

export interface OrgReadTokenDeps extends OrgDeps {
  /** Unset ⇒ nothing can be minted and no gated org read passes. */
  secret: string | undefined;
  servers: ServerStorage;
  nonces: DirectoryNonceStore;
}

/**
 * Who may read: `any` = a live seat or one of the org's servers; `people` = a live seat;
 * `admin` = an org admin of the current record or a seat with the `servers-add` role.
 */
export type OrgReadScope = "any" | "people" | "admin";

export type OrgReadCheck =
  | { ok: true; claims: OrgReadTokenClaims }
  | { ok: false; response: HandlerResponseWithHeaders };

const unauthorized = (reason: string): HandlerResponseWithHeaders => ({
  status: 401,
  body: { error: reason, code: "org-read-token-required" },
  headers: { ...ACCOUNT_READ_HEADERS },
});

const nowOf = (d: OrgDeps) => (d.now ?? (() => Date.now()))();

const validClaims = (c: unknown): c is OrgReadTokenClaims => {
  const x = c as Partial<OrgReadTokenClaims> | null;
  return !!x && typeof x.o === "string" && typeof x.sub === "string" && typeof x.k === "string" && typeof x.exp === "number";
};

export async function handleMintOrgReadToken(deps: OrgReadTokenDeps, orgId: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  if (!deps.secret) return { status: 503, body: { error: "read tokens aren't configured" } };
  if (!ORG_ID.test(orgId)) return malformed("orgId");
  const b = body as { request?: Partial<OrgReadTokenRequest>; signature?: unknown } | null;
  const r = b?.request;
  if (
    !r || typeof r.orgId !== "string" || r.orgId !== orgId || typeof r.subject !== "string" ||
    typeof r.pubHex !== "string" || !/^[0-9a-f]{64}$/.test(r.pubHex) ||
    typeof r.issuedAt !== "number" || typeof r.nonceHex !== "string" || typeof b?.signature !== "string"
  ) return malformed("request");
  const now = nowOf(deps);
  if (Math.abs(now - r.issuedAt) > FRESHNESS_MS) return forbidden("not authorized");
  const request = r as OrgReadTokenRequest;
  if (!(await verifyOrgReadTokenRequestFast(request, b.signature, hexToBytes(request.pubHex)))) return forbidden("not authorized");
  const claims: OrgReadTokenClaims = { o: orgId, sub: request.subject, k: request.pubHex, iat: now, exp: 0 };
  if (!(await signerStillCurrent(deps, claims, now))) return forbidden("not authorized");
  if (!(await deps.nonces.claim(`org-read-token|${orgId}|${request.subject}|${request.nonceHex}`, now + FRESHNESS_MS, now))) {
    return forbidden("not authorized");
  }
  claims.exp = now + (claims.sub.startsWith("box:") ? ORG_BOX_TOKEN_TTL_MS : ORG_SEAT_TOKEN_TTL_MS);
  const token = await encodeReadToken(PREFIX, MAC_CONTEXT, claims, deps.secret);
  return ok({ token, expiresAt: claims.exp }, { ...ACCOUNT_READ_HEADERS });
}

/** The claims of a bearer org read token whose MAC verifies, else null (no freshness or signer check). */
export async function peekOrgReadToken(secret: string | undefined, authorization: string | null | undefined): Promise<OrgReadTokenClaims | null> {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!match || !secret) return null;
  return decodeReadToken(PREFIX, MAC_CONTEXT, match[1]!, secret, validClaims);
}

/** Gate a read of `orgId`'s private state on `authorization: Bearer <org read token>`. */
export async function requireOrgRead(
  deps: OrgReadTokenDeps,
  orgId: string,
  authorization: string | null | undefined,
  scope: OrgReadScope = "any",
): Promise<OrgReadCheck> {
  const denied = { ok: false as const, response: unauthorized("an org read token is required") };
  const claims = await peekOrgReadToken(deps.secret, authorization);
  const now = nowOf(deps);
  if (!claims || claims.o !== orgId || now >= claims.exp) return denied;
  if (scope !== "any" && !claims.sub.startsWith("seat:")) return denied;
  if (!(await signerStillCurrent(deps, claims, now, scope === "admin"))) return denied;
  return { ok: true, claims };
}

async function signerStillCurrent(deps: OrgReadTokenDeps, c: OrgReadTokenClaims, now: number, wantAdmin = false): Promise<boolean> {
  if (c.sub.startsWith("box:")) return !wantAdmin && (await boxStillCurrent(deps, c.o, c.sub.slice(4), c.k));
  if (!c.sub.startsWith("seat:")) return false;
  const seatId = c.sub.slice(5);
  let v: OrgView | null;
  try {
    v = await loadOrg(deps, c.o, now);
  } catch {
    return false;
  }
  return !!v && seatStillCurrent(v, seatId, c.k, now, wantAdmin);
}

function seatStillCurrent(v: OrgView, seatId: string, key: string, now: number, wantAdmin: boolean): boolean {
  if (!/^[0-9a-f]{32}$/.test(seatId)) return false;
  if (v.book.freezes.some((f) => f.seatId === seatId && f.issuedAt <= now && now < f.untilMs)) return false;
  const admin = v.state.current.admins.find((a) => a.seatId === seatId);
  if (admin) {
    const bound = v.state.bindings.get(`${v.state.current.version}:${seatId}`)?.ed25519PubHex ?? admin.binding.ed25519PubHex;
    if (bound.toLowerCase() === key) return !wantAdmin || admin.kind === "admin";
  }
  if (v.book.revoked.has(seatId)) return false;
  const seat = v.book.seats.get(seatId);
  if (!seat || seat.grant.expiresAt <= now) return false;
  const keys = [seat.member.ed25519PubHex, seat.admin?.ed25519PubHex].filter((k): k is string => typeof k === "string");
  if (!keys.some((k) => k.toLowerCase() === key)) return false;
  return !wantAdmin || seat.roles.some((r: OrgSeatRole) => r.role === "servers-add");
}

async function boxStillCurrent(deps: OrgReadTokenDeps, orgId: string, domain: string, key: string): Promise<boolean> {
  if (domain !== domain.toLowerCase()) return false;
  const [listed, server] = await Promise.all([deps.orgs.getObject(orgId, "server", domain), deps.servers.get(domain)]);
  if (!listed || !server || server.revokedAt) return false;
  let stored: { serverDomain?: string; identityPubKeyHex?: string };
  try {
    stored = JSON.parse(listed.bodyJson) as typeof stored;
  } catch {
    return false;
  }
  return stored.serverDomain === domain && stored.identityPubKeyHex?.toLowerCase() === key
    && server.identityPubKeyHex.toLowerCase() === key;
}
