/**
 * Account read tokens (docs/account-read-token.md).
 *
 * An account's server inventory (`/pods`, `/stream`), device history
 * (`/audit`) and app names (`/apps/aliases`, `/apps/<id>/links`) are served
 * only to a bearer of a read token for that account. A token is minted at
 * `POST /api/accounts/<u>/read-token` by a device of the account (its signed
 * account-directory request), by the account's IRK (a device-endpoint claim
 * labelled `account-read-token`), or by one of the account's servers (a
 * `box-read-token-request/v1` signed with its STK).
 *
 * The token is `art1.<b64url(claims)>.<b64url(HMAC-SHA256)>`, keyed by the
 * Worker secret `ACCOUNT_READ_TOKEN_SECRET`; only `.com` reads it. Every read
 * re-checks that the signer is still current (device not revoked, IRK not
 * rotated, server not revoked), so revoking a device cuts it off on its next
 * request. Demo accounts are keyless by design and need no token.
 */

import {
  ACCOUNT_READ_TOKEN_LABEL,
  accountReadTokenPath,
  verifyBoxReadTokenRequestFast,
  verifyDeviceEndpointClaimFast,
  type BoxReadTokenRequest,
} from "@flagship/protocol";
import type {
  DemoUsersStorage,
  DeviceIdentityStorage,
  ServerStorage,
  UsernameStorage,
} from "@flagship/storage";
import {
  authorizeActiveDevice,
  type DirectoryAuthorization,
  type DirectoryNonceStore,
} from "./accountDirectory.js";
import { hexToBytes } from "./hex.js";
import { forbidden, malformed, ok, type HandlerResponseWithHeaders } from "./types.js";

const PREFIX = "art1";
const MAC_CONTEXT = "flagship/account-read-token/v1";
export const DEVICE_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
export const IRK_TOKEN_TTL_MS = 24 * 60 * 60_000;
export const BOX_TOKEN_TTL_MS = 24 * 60 * 60_000;
const FRESHNESS_MS = 5 * 60_000;

/** Who minted the token: `d:<deviceId>`, `irk`, or `s:<serverDomain>`. */
export interface AccountReadTokenClaims {
  u: string;
  sub: string;
  /** The signer's public key at mint time, lowercase hex. */
  k: string;
  iat: number;
  exp: number;
}

export interface AccountReadTokenDeps {
  /** Unset ⇒ nothing can be minted and only demo accounts can be read. */
  secret: string | undefined;
  usernames: UsernameStorage;
  identities: DeviceIdentityStorage;
  servers: ServerStorage;
  demoUsers: DemoUsersStorage;
  nonces: DirectoryNonceStore;
  now?: () => number;
}

export interface ReadTokenMintInput {
  /** The device path's signed request, read from headers. */
  device?: DirectoryAuthorization;
  /** The IRK path (`{auth, authSignature}`) or the server path (`{box, signature}`). */
  body?: unknown;
}

const READ_HEADERS = { "cache-control": "private, no-store", vary: "authorization" } as const;

const unauthorized = (reason: string): HandlerResponseWithHeaders => ({
  status: 401,
  body: { error: reason },
  headers: { ...READ_HEADERS },
});

export async function handleMintAccountReadToken(
  deps: AccountReadTokenDeps,
  username: string,
  input: ReadTokenMintInput,
): Promise<HandlerResponseWithHeaders> {
  if (!deps.secret) return { status: 503, body: { error: "read tokens aren't configured" } };
  const u = username.toLowerCase();
  const now = (deps.now ?? (() => Date.now()))();
  const signer = await authorizeSigner(deps, u, input, now);
  if (!signer) return forbidden("not authorized");
  const claims: AccountReadTokenClaims = { u, sub: signer.sub, k: signer.key, iat: now, exp: now + signer.ttlMs };
  const token = await encode(claims, deps.secret);
  return ok({ token, expiresAt: claims.exp }, { ...READ_HEADERS });
}

async function authorizeSigner(
  deps: AccountReadTokenDeps,
  u: string,
  input: ReadTokenMintInput,
  now: number,
): Promise<{ sub: string; key: string; ttlMs: number } | null> {
  if (input.device) {
    const device = await authorizeActiveDevice(
      { identities: deps.identities, nonces: deps.nonces, now: () => now },
      input.device,
      { accountId: u, method: "POST", path: accountReadTokenPath(u) },
    );
    return device ? { sub: `d:${device.deviceId}`, key: device.signerPubHex, ttlMs: DEVICE_TOKEN_TTL_MS } : null;
  }
  const body = input.body as
    | { auth?: Record<string, unknown>; authSignature?: unknown; box?: Partial<BoxReadTokenRequest>; signature?: unknown }
    | undefined;
  if (body?.auth) return await authorizeIrk(deps, u, body.auth, body.authSignature, now);
  if (body?.box) return await authorizeBox(deps, u, body.box, body.signature, now);
  return null;
}

async function authorizeIrk(
  deps: AccountReadTokenDeps,
  u: string,
  a: Record<string, unknown>,
  signature: unknown,
  now: number,
): Promise<{ sub: string; key: string; ttlMs: number } | null> {
  if (
    typeof a.username !== "string" || a.username.toLowerCase() !== u ||
    a.endpointLabel !== ACCOUNT_READ_TOKEN_LABEL ||
    typeof a.phoneIrkPub !== "string" || !/^[0-9a-f]{64}$/.test(a.phoneIrkPub) ||
    typeof a.nonce !== "string" || !/^[0-9a-f]{64}$/.test(a.nonce) ||
    typeof a.issuedAt !== "number" || typeof a.expiresAt !== "number" ||
    typeof signature !== "string" || !/^[0-9a-f]{128}$/.test(signature)
  ) return null;
  if (Math.abs(now - a.issuedAt) > FRESHNESS_MS || a.expiresAt <= now) return null;
  const user = await deps.usernames.get(u);
  if (!user?.irkPubHex || user.irkPubHex.toLowerCase() !== a.phoneIrkPub) return null;
  const verified = await verifyDeviceEndpointClaimFast(
    {
      username: a.username,
      endpointLabel: a.endpointLabel,
      phoneIrkPub: hexToBytes(a.phoneIrkPub),
      issuedAt: a.issuedAt,
      expiresAt: a.expiresAt,
      nonce: hexToBytes(a.nonce),
    },
    hexToBytes(signature),
    hexToBytes(user.irkPubHex),
  );
  if (!verified) return null;
  if (!(await deps.nonces.claim(`read-token|irk|${u}|${a.nonce}`, now + FRESHNESS_MS, now))) return null;
  return { sub: "irk", key: a.phoneIrkPub, ttlMs: IRK_TOKEN_TTL_MS };
}

async function authorizeBox(
  deps: AccountReadTokenDeps,
  u: string,
  r: Partial<BoxReadTokenRequest>,
  signature: unknown,
  now: number,
): Promise<{ sub: string; key: string; ttlMs: number } | null> {
  if (
    typeof r.username !== "string" || r.username.toLowerCase() !== u ||
    typeof r.serverDomain !== "string" || typeof r.stkPubHex !== "string" ||
    typeof r.issuedAt !== "number" || typeof r.nonceHex !== "string" ||
    typeof signature !== "string"
  ) return null;
  if (Math.abs(now - r.issuedAt) > FRESHNESS_MS) return null;
  const domain = r.serverDomain.toLowerCase();
  const server = await deps.servers.get(domain);
  if (!server || server.revokedAt || server.username.toLowerCase() !== u) return null;
  if (server.identityPubKeyHex.toLowerCase() !== r.stkPubHex) return null;
  const request = r as BoxReadTokenRequest;
  if (!(await verifyBoxReadTokenRequestFast(request, signature, hexToBytes(server.identityPubKeyHex)))) return null;
  if (!(await deps.nonces.claim(`read-token|box|${domain}|${r.nonceHex}`, now + FRESHNESS_MS, now))) return null;
  return { sub: `s:${domain}`, key: r.stkPubHex, ttlMs: BOX_TOKEN_TTL_MS };
}

export type AccountReadCheck = { ok: true; demo: boolean } | { ok: false; response: HandlerResponseWithHeaders };

/**
 * Gate a read of `username`'s private state on the request's
 * `authorization: Bearer <token>`. Demo accounts pass without one.
 */
export async function requireAccountRead(
  deps: AccountReadTokenDeps,
  username: string,
  authorization: string | null | undefined,
): Promise<AccountReadCheck> {
  const u = username.toLowerCase();
  if (await deps.demoUsers.get(u)) return { ok: true, demo: true };
  const denied = { ok: false as const, response: unauthorized("an account read token is required") };
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!match || !deps.secret) return denied;
  const claims = await decode(match[1]!, deps.secret);
  const now = (deps.now ?? (() => Date.now()))();
  if (!claims || claims.u !== u || now >= claims.exp) return denied;
  if (!(await signerStillCurrent(deps, claims))) return denied;
  return { ok: true, demo: false };
}

async function signerStillCurrent(deps: AccountReadTokenDeps, c: AccountReadTokenClaims): Promise<boolean> {
  if (c.sub === "irk") {
    const user = await deps.usernames.get(c.u);
    return !!user?.irkPubHex && user.irkPubHex.toLowerCase() === c.k;
  }
  if (c.sub.startsWith("d:")) {
    const device = await deps.identities.get(c.u, c.sub.slice(2));
    return !!device && device.revokedAt === null && device.devicePubHex.toLowerCase() === c.k;
  }
  if (c.sub.startsWith("s:")) {
    const server = await deps.servers.get(c.sub.slice(2));
    return !!server && !server.revokedAt && server.username.toLowerCase() === c.u
      && server.identityPubKeyHex.toLowerCase() === c.k;
  }
  return false;
}

/** The headers every gated read answers with, so no cache keeps one account's state. */
export const ACCOUNT_READ_HEADERS: Readonly<Record<string, string>> = READ_HEADERS;

async function encode(claims: AccountReadTokenClaims, secret: string): Promise<string> {
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  return `${PREFIX}.${payload}.${b64urlEncode(await hmac(secret, `${MAC_CONTEXT}|${payload}`))}`;
}

// A token whose MAC checked out is remembered, keyed by the whole token string
// and the secret it was checked under, so the same bearer token (an app sends
// it on every poll) costs one HMAC per isolate rather than one per request.
// Only the MAC and the claims are remembered: expiry (`exp`) and whether the
// signer is still current are judged on every call, so a revoked device or a
// rotated root loses access on its next request exactly as before. A token the
// secret does not vouch for is never stored.
const VERIFIED_TOKENS = new Map<string, { secret: string; claims: AccountReadTokenClaims }>();
const VERIFIED_TOKENS_MAX = 512;

async function decode(token: string, secret: string): Promise<AccountReadTokenClaims | null> {
  const seen = VERIFIED_TOKENS.get(token);
  if (seen && seen.secret === secret) return seen.claims;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  try {
    const expected = await hmac(secret, `${MAC_CONTEXT}|${parts[1]}`);
    if (!timingSafeEqual(expected, b64urlDecode(parts[2]!))) return null;
    const c = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]!))) as AccountReadTokenClaims;
    if (typeof c.u !== "string" || typeof c.sub !== "string" || typeof c.k !== "string" || typeof c.exp !== "number") {
      return null;
    }
    if (VERIFIED_TOKENS.size >= VERIFIED_TOKENS_MAX) VERIFIED_TOKENS.delete(VERIFIED_TOKENS.keys().next().value!);
    VERIFIED_TOKENS.set(token, { secret, claims: c });
    return c;
  } catch {
    return null;
  }
}

/**
 * The claims of a bearer token that carries a valid MAC, or null. Says nothing
 * about expiry or whether the signer is still current: it exists so the route
 * can start the reads the gate will make together with its own.
 */
export async function peekAccountReadToken(
  secret: string | undefined,
  authorization: string | null | undefined,
): Promise<AccountReadTokenClaims | null> {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!match || !secret) return null;
  return decode(match[1]!, secret);
}

// The imported HMAC key, kept per secret: importing it is most of the work.
const hmacKeys = new Map<string, ReturnType<typeof crypto.subtle.importKey>>();

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    hmacKeys.set(secret, key);
    key.catch(() => hmacKeys.delete(secret));
  }
  return new Uint8Array(await crypto.subtle.sign("HMAC", await key, new TextEncoder().encode(message)));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
