// voi.ci shortener (V1) — mint codes, redirect on hostname, periodic GC.
//
// Three concerns:
//
//   1. mintShortLink (internal helper) — Worker-private, called by
//      handleAppRename + (future) one-off shorten endpoint. Picks a
//      6-base36 code, retries on collision up to 5 times.
//
//   2. handleVoiciRedirect — public hostname route. The Worker's
//      top-level entry checks `url.hostname === "voi.ci"` and
//      dispatches the path `/abc123` here. Returns 302 to target_url,
//      or 404 / 410 on miss / expired.
//
//   3. handleVoiciShorten — phone-facing API. Signed by IRK; mints
//      a one-off code (no appId binding). For app-bound codes the
//      caller is the rename handler, not this endpoint.
//
// Short code alphabet: lowercase base36 (`0-9a-z`). 6 chars = 2.18B
// keyspace; collision probability per mint is negligible until we
// have >>100M live codes. The retry loop catches the long tail.

import {
  verifyVoiciShorten,
  type VoiciShorten,
} from "@flagship/protocol";
import type {
  UsernameStorage,
  VoiciLinkStorage,
} from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import {
  forbidden,
  malformed,
  notFound,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

export interface VoiciDeps {
  usernames: UsernameStorage;
  voiciLinks: VoiciLinkStorage;
  /** Optional clock injection — tests override; production uses Date.now. */
  now?: () => number;
  /** Base hostname used when formatting the short URL the API returns
   *  to clients. Defaults to "voi.ci" — overrideable in dev to point
   *  at a staging hostname. */
  shortHost?: string;
  /** Code length in chars. Defaults to 6. */
  codeLength?: number;
}

/** voi.ci's public-facing hostname (used in the URL returned to
 *  clients). The Worker route for this hostname dispatches to
 *  handleVoiciRedirect below. */
export const DEFAULT_VOICI_HOST = "voi.ci";

/** Retry budget for code collisions before we return 500.  D1 throws
 *  a constraint error on duplicate codes; the rng-based code minter
 *  picks fresh bytes on each retry. */
const MAX_MINT_RETRIES = 5;

const DEFAULT_MAX_AGE_MS = 5 * 60_000;
const ONE_OFF_TTL_MS = 365 * 24 * 60 * 60_000;

const USERNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
// Matches `^https://` — Worker rejects anything else so an attacker
// can't mint a short code that redirects to `javascript:` etc.
const TARGET_URL_RE = /^https:\/\/[^\s]+$/i;

/** Worker-private: pick a fresh code, hand it back to the caller
 *  along with the persisted row. Used by both the public shorten
 *  endpoint AND the rename handler when minting the post-rename
 *  link. */
export async function mintShortLink(
  deps: VoiciDeps,
  args: {
    username: string;
    appId?: string;
    targetUrl: string;
    expiresAt?: number;
  },
): Promise<{ code: string; shortUrl: string } | { error: string }> {
  const username = args.username.toLowerCase();
  if (!USERNAME_RE.test(username)) return { error: "malformed username" };
  if (!TARGET_URL_RE.test(args.targetUrl)) return { error: "targetUrl must be https://…" };
  const len = deps.codeLength ?? 6;
  const host = deps.shortHost ?? DEFAULT_VOICI_HOST;
  const now = (deps.now ?? (() => Date.now()))();

  for (let attempt = 0; attempt < MAX_MINT_RETRIES; attempt++) {
    const code = randomBase36Code(len);
    const insert = await deps.voiciLinks.insert({
      code,
      username,
      ...(args.appId ? { appId: args.appId } : {}),
      targetUrl: args.targetUrl,
      createdAt: now,
      ...(args.expiresAt !== undefined ? { expiresAt: args.expiresAt } : {}),
    });
    if (insert.ok) {
      return { code, shortUrl: `https://${host}/${code}` };
    }
    // Collision — retry with fresh entropy.
  }
  return { error: "couldn't allocate a unique short code; retry" };
}

/** Phone-facing API. Signed by IRK over canonical bytes. Mints a
 *  one-off code (no appId binding). App-bound codes ride through
 *  handleAppRename instead — appId binding lets that handler cascade-
 *  delete on subsequent renames. */
export async function handleVoiciShorten(
  deps: VoiciDeps,
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const maxAgeMs = DEFAULT_MAX_AGE_MS;

  const b = body as { request?: Record<string, unknown>; signature?: unknown };
  const r = b?.request ?? {};
  if (
    typeof r.username !== "string" ||
    typeof r.targetUrl !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return malformed("malformed body");
  }
  if (Math.abs(now - r.issuedAt) > maxAgeMs) return forbidden("stale request");
  if (!TARGET_URL_RE.test(r.targetUrl)) return malformed("targetUrl must be https://…");

  const userRec = await deps.usernames.get(r.username);
  if (!userRec) return notFound("unknown username");

  let sig: Uint8Array;
  try {
    sig = hexToBytes(b.signature);
  } catch {
    return malformed("invalid signature hex");
  }
  const claim: VoiciShorten = {
    username: r.username,
    ...(typeof r.appId === "string" && r.appId.length > 0 ? { appId: r.appId } : {}),
    targetUrl: r.targetUrl,
    issuedAt: r.issuedAt,
  };
  if (!verifyVoiciShorten(claim, sig, hexToBytes(userRec.irkPubHex))) {
    return forbidden("invalid signature");
  }

  const minted = await mintShortLink(deps, {
    username: r.username,
    ...(typeof r.appId === "string" && r.appId.length > 0 ? { appId: r.appId } : {}),
    targetUrl: r.targetUrl,
    expiresAt: now + ONE_OFF_TTL_MS,
  });
  if ("error" in minted) return { status: 500, body: { error: minted.error } };
  return ok({
    ok: true,
    code: minted.code,
    shortUrl: minted.shortUrl,
  });
}

/** Worker hostname route. Input is the raw code path component;
 *  output is a 302 redirect (handled by the Worker frontend). 410
 *  Gone fires when the code resolves but has expired — distinct
 *  from 404 so a victim of a rename sees "this link was rotated"
 *  rather than "this link never existed." */
export async function handleVoiciRedirect(
  deps: VoiciDeps,
  code: string,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  if (!/^[a-z0-9]{1,10}$/.test(code)) return notFound("short code not found");
  const row = await deps.voiciLinks.get(code);
  if (!row) return notFound("short code not found");
  if (row.expiresAt !== undefined && row.expiresAt <= now) {
    return { status: 410, body: { error: "this short link was rotated; ask the sender for a fresh one" } };
  }
  return {
    status: 302,
    body: { ok: true, target: row.targetUrl },
    headers: {
      location: row.targetUrl,
      "cache-control": "private, no-store",
    },
  };
}

/** Cryptographically-strong base36 code generator. */
function randomBase36Code(length: number): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}
