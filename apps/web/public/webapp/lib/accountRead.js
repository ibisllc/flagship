// Account read tokens (docs/account-read-token.md).
//
// `.com` answers an account's server inventory (`/pods`, `/stream`), device
// history (`/audit`) and app names (`/apps/aliases`, `/apps/<id>/links`) only
// to a bearer of a read token for that account. `accountReadFetch` is the one
// door for those reads: it attaches the token, mints one silently while the
// account is unlocked in this tab, re-mints once on a 401, and otherwise keeps
// going without one. It never prompts. Tokens live in memory only, per
// profile and account, and are dropped when the session locks.
//
// Minting prefers this device's account key (the signed account-directory
// request the `/profile` read uses, 30-day token) and falls back to the IRK
// (a device-endpoint claim labelled `account-read-token`, 24-hour token).
// Demo accounts read without a token; keyless remote (companion) profiles
// never read these endpoints at all.

import { controlApex } from "./apex.js";
import { canonicalDirectoryRequest } from "./accountMetadata.js";
import { isCompanionProfile } from "./companionGuard.js";
import { isDemoProfile } from "./demoAccount.js";
import { getActiveProfile } from "./profiles.js";
import { getSession, onSessionLock } from "./state.js";
import { answerIfAccountGone, noteAccountGoneResponse } from "./accountGone.js";
import { bytesToHex, deriveAccountDeviceKeyFromSeed, deriveIrkFromSeed, signWithIrk } from "../keystore.js";

import { tr } from "./i18n.js";
export const ACCOUNT_READ_TOKEN_LABEL = "account-read-token";
const TAG_DEVICE_ENDPOINT_CLAIM = "flagship/device-endpoint-claim/v1";
/** Re-mint a token this long before `.com` would stop accepting it. */
const REFRESH_MARGIN_MS = 10 * 60_000;
const GATED_PATH = /\/api\/users\/([^/?#]+)\/(?:pods|stream|audit|apps\/aliases|apps\/[^/?#]+\/links)(?:[?#]|$)/;

/** @type {Map<string, { token: string, expiresAt: number }>} */
const tokens = new Map();
/** @type {Map<string, Promise<{ token: string, expiresAt: number } | null>>} */
const minting = new Map();
const pausedListeners = new Set();
let paused = false;

onSessionLock(() => clearAccountReadTokens());

/** The account a gated read is for, or null when `url` isn't one. */
export function accountReadUsername(url) {
  const m = GATED_PATH.exec(String(url));
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

/** True once a read was refused and no token could be minted without the
 *  account keys: the UI shows "status paused, unlock to refresh". */
export function isAccountReadPaused() {
  return paused;
}

export function onAccountReadPausedChange(fn) {
  pausedListeners.add(fn);
  return () => pausedListeners.delete(fn);
}

function setPaused(next) {
  if (paused === next) return;
  paused = next;
  for (const fn of pausedListeners) {
    try { fn(paused); } catch { /* a listener must never break a read */ }
  }
}

export function clearAccountReadTokens() {
  tokens.clear();
  minting.clear();
}

/**
 * Fetch a gated account read. Same contract as `fetch`; `deps` injects
 * `fetch`, `getSession`, `getProfile`, `now`, `baseUrl` (the mint origin) and
 * the signing seams for tests.
 */
export async function accountReadFetch(url, init = {}, deps = {}) {
  const f = deps.fetch ?? globalThis.fetch;
  const profile = (deps.getProfile ?? getActiveProfile)();
  if ((deps.isCompanion ?? isCompanionProfile)()) {
    return new Response(JSON.stringify({ error: tr("a remote browser doesn't read the account's servers") }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  const username = accountReadUsername(url);
  const goneAnswer = username ? answerIfAccountGone(url) : null;
  if (goneAnswer) return goneAnswer;
  if (!username || isDemoProfile(profile)) return noted(url, await f(url, init));
  let entry = await tokenFor(username, deps, false);
  let r = await f(url, withToken(init, entry?.token));
  if (r.status === 401 && canMint(username, deps)) {
    forget(username, deps);
    entry = await tokenFor(username, deps, true);
    if (entry) r = await f(url, withToken(init, entry.token));
  }
  if (r.status === 401) setPaused(true);
  else if (r.ok) setPaused(false);
  return noted(url, r);
}

/** A removed account answers 404 account-not-found: note it (lib/accountGone.js). */
async function noted(url, r) {
  await noteAccountGoneResponse(url, r);
  return r;
}

function withToken(init, token) {
  if (!token) return init;
  return { ...init, headers: { ...headersObject(init.headers), authorization: `Bearer ${token}` } };
}

function headersObject(h) {
  if (!h) return {};
  if (typeof Headers !== "undefined" && h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h);
  return { ...h };
}

function cacheKey(username, deps) {
  const profile = (deps.getProfile ?? getActiveProfile)();
  return `${profile?.cloudName ?? ""}|${username}`;
}

function forget(username, deps) {
  tokens.delete(cacheKey(username, deps));
}

/** The account keys are unlocked in this tab, for this account. */
function canMint(username, deps) {
  const session = (deps.getSession ?? getSession)();
  return session?.umk instanceof Uint8Array && String(session.username ?? "").toLowerCase() === username;
}

async function tokenFor(username, deps, force) {
  if (!canMint(username, deps)) return null;
  const key = cacheKey(username, deps);
  const now = (deps.now ?? Date.now)();
  const cached = tokens.get(key);
  if (!force && cached && cached.expiresAt - REFRESH_MARGIN_MS > now) return cached;
  let pending = minting.get(key);
  if (!pending) {
    pending = mintAccountReadToken(username, deps).catch(() => null);
    minting.set(key, pending);
  }
  try {
    const minted = await pending;
    if (minted) tokens.set(key, minted);
    return minted;
  } finally {
    minting.delete(key);
  }
}

/** Mint a token: the device path first, the IRK path if that's refused or
 *  this profile has no device identity. Returns `{ token, expiresAt }` or null. */
export async function mintAccountReadToken(username, deps = {}) {
  const u = username.toLowerCase();
  const session = (deps.getSession ?? getSession)();
  if (!(session?.umk instanceof Uint8Array)) return null;
  const profile = (deps.getProfile ?? getActiveProfile)();
  const path = `/api/accounts/${u}/read-token`;
  const url = `${deps.baseUrl ?? controlApex()}${path}`;
  const f = deps.fetch ?? globalThis.fetch;
  if (String(profile?.accountId ?? "").toLowerCase() === u && /^[0-9a-f]{32}$/.test(profile?.deviceId ?? "")) {
    const headers = await deviceRequestHeaders({ umk: session.umk, accountId: u, deviceId: profile.deviceId, path }, deps);
    const minted = await readMinted(await f(url, { method: "POST", cache: "no-store", headers }));
    if (minted) return minted;
  }
  const body = await irkClaimBody({ username: u, umk: session.umk }, deps);
  return await readMinted(await f(url, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function readMinted(r) {
  if (!r?.ok) return null;
  const body = await r.json().catch(() => null);
  return typeof body?.token === "string" && typeof body?.expiresAt === "number"
    ? { token: body.token, expiresAt: body.expiresAt }
    : null;
}

/** The account-directory request headers for the device path. */
export async function deviceRequestHeaders({ umk, accountId, deviceId, path }, deps = {}) {
  const key = await (deps.deriveDeviceKey ?? deriveAccountDeviceKeyFromSeed)(umk, accountId, deviceId);
  const request = {
    accountId,
    deviceId,
    signerPubHex: bytesToHex(key.publicKey),
    method: "POST",
    path,
    requestId: deps.requestId ?? bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
    issuedAt: (deps.now ?? Date.now)(),
  };
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: tr("Ed25519") },
    key.privateKey,
    canonicalDirectoryRequest(request),
  ));
  return {
    "x-flagship-device-id": deviceId,
    "x-flagship-device-pub": request.signerPubHex,
    "x-flagship-request-id": request.requestId,
    "x-flagship-issued-at": String(request.issuedAt),
    "x-flagship-signature": bytesToHex(signature),
  };
}

/** The `{auth, authSignature}` body for the IRK path. */
export async function irkClaimBody({ username, umk }, deps = {}) {
  const irkPubHex = deps.irkPubHex ?? bytesToHex((await (deps.deriveIrk ?? deriveIrkFromSeed)(umk)).publicKey);
  const issuedAt = (deps.now ?? Date.now)();
  const auth = {
    username,
    endpointLabel: ACCOUNT_READ_TOKEN_LABEL,
    phoneIrkPub: irkPubHex,
    issuedAt,
    expiresAt: issuedAt + 5 * 60_000,
    nonce: deps.nonceHex ?? bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const canonical = new TextEncoder().encode([
    TAG_DEVICE_ENDPOINT_CLAIM,
    auth.username,
    auth.endpointLabel,
    auth.phoneIrkPub,
    auth.issuedAt,
    auth.expiresAt,
    auth.nonce,
  ].join("|"));
  const signature = await (deps.signWithIrk ?? signWithIrk)(umk, canonical);
  return { auth, authSignature: bytesToHex(signature) };
}
