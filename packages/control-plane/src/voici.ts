// voi.ci shortener (V1) — mint codes, redirect on hostname, periodic GC.
//
// Three concerns:
//
//   1. mintShortLink (internal helper) — Worker-private, called by
//      handleServiceRename + (future) one-off shorten endpoint. Picks a
//      6-base36 code, retries on collision up to 5 times.
//
//   2. handleVoiciRedirect — public hostname route. The Worker's
//      top-level entry checks `url.hostname === "voi.ci"` and
//      dispatches the path `/abc123` here. Returns 302 to target_url,
//      or 404 / 410 on miss / expired.
//
//   3. handleVoiciShorten — phone-facing API. Signed by IRK; mints
//      a one-off code (no serviceId binding). For app-bound codes the
//      caller is the rename handler, not this endpoint.
//
// Short code alphabet: lowercase base36 (`0-9a-z`). 6 chars = 2.18B
// keyspace; collision probability per mint is negligible until we
// have >>100M live codes. The retry loop catches the long tail.

import {
  verifyVoiciShorten,
  type VoiciShorten,
} from "@flagship/protocol";
import { voiciNameKey } from "@flagship/protocol";
import type {
  UsernameStorage,
  VoiciLinkStorage,
  VoiciNameStorage,
} from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import {
  forbidden,
  gone,
  malformed,
  notFound,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

export interface VoiciDeps {
  usernames: UsernameStorage;
  voiciLinks: VoiciLinkStorage;
  /** Custom names (docs/named-links.md). Absent: codes only. */
  voiciNames?: VoiciNameStorage;
  /** The service's canonical address (`https://<label>.<user>.flagship.services`),
   *  worked out on each visit so a link follows a rename. Null: fall back to
   *  [resolveAppUrl] and then to the stored target. */
  resolveCanonical?: (username: string, serviceId: string) => Promise<string | null>;
  /** Optional clock injection — tests override; production uses Date.now. */
  now?: () => number;
  /** Base hostname used when formatting the short URL the API returns
   *  to clients. Defaults to "voi.ci" — overrideable in dev to point
   *  at a staging hostname. */
  shortHost?: string;
  /** Code length in chars. Defaults to 6. */
  codeLength?: number;
  /** An app-bound link's current target (the box that leads the app now),
   *  so the link follows the app between boxes. Null keeps the stored one. */
  resolveAppUrl?: (username: string, serviceId: string) => Promise<string | null>;
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

const USERNAME_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/; // no hyphens — see labels.ts
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
    serviceId?: string;
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
    // A readable name that happens to look like this code keeps it: never hand it out.
    if (deps.voiciNames && (await deps.voiciNames.get(code))) continue;
    const insert = await deps.voiciLinks.insert({
      code,
      username,
      ...(args.serviceId ? { serviceId: args.serviceId } : {}),
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
 *  one-off code (no serviceId binding). App-bound codes ride through
 *  handleServiceRename instead — serviceId binding lets that handler cascade-
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
    ...(typeof r.serviceId === "string" && r.serviceId.length > 0 ? { serviceId: r.serviceId } : {}),
    targetUrl: r.targetUrl,
    issuedAt: r.issuedAt,
  };
  if (!verifyVoiciShorten(claim, sig, hexToBytes(userRec.irkPubHex))) {
    return forbidden("invalid signature");
  }

  const minted = await mintShortLink(deps, {
    username: r.username,
    ...(typeof r.serviceId === "string" && r.serviceId.length > 0 ? { serviceId: r.serviceId } : {}),
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

/** Worker hostname route. Input is the raw path component: a random code or a
 *  custom name. Output is a 302 (handled by the Worker frontend). 410 Gone says
 *  the link is no longer in use (a rotated one-off, a retired code, a custom
 *  name in its wait); 404 says it never existed. A custom name in its wait
 *  redirects nowhere on purpose, so caches elsewhere forget it before anyone
 *  else can take the name. */
export async function handleVoiciRedirect(
  deps: VoiciDeps,
  code: string,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const target = async (username: string, serviceId: string | undefined, stored: string | undefined): Promise<string | null> => {
    if (serviceId) {
      const canonical = await deps.resolveCanonical?.(username, serviceId).catch(() => null);
      if (canonical && TARGET_URL_RE.test(canonical)) return canonical;
      const live = await deps.resolveAppUrl?.(username, serviceId).catch(() => null);
      if (live && TARGET_URL_RE.test(live)) return live;
    }
    return stored ?? null;
  };
  const found = (to: string): HandlerResponseWithHeaders => ({
    status: 302,
    body: { ok: true, target: to },
    headers: { location: to, "cache-control": "private, no-store" },
  });

  if (/^[a-z0-9]{1,10}$/.test(code)) {
    const row = await deps.voiciLinks.get(code);
    if (row) {
      if (row.retiredAt !== undefined) return gone("this short link is no longer in use");
      if (row.expiresAt !== undefined && row.expiresAt <= now) {
        return gone("this short link was rotated; ask the sender for a fresh one");
      }
      const to = await target(row.username, row.serviceId, row.targetUrl);
      return to ? found(to) : notFound("short code not found");
    }
  }
  if (deps.voiciNames && code.length >= 4 && code.length <= 40 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(code)) {
    const name = await deps.voiciNames.get(voiciNameKey(code));
    if (name) {
      if (name.state === "waiting") return gone("this short link is no longer in use");
      const to = await target(name.username, name.serviceId, undefined);
      return to ? found(to) : notFound("short code not found");
    }
  }
  return notFound("short code not found");
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
